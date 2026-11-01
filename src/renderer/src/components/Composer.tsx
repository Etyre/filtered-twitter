import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { HandleSuggestion, PostNetwork } from '@shared/types'
import { isBskyId } from '@shared/net'
import { speak } from '../speech'

/** X allows Premium accounts 25,000 characters (a post past 280 is a long post); Bluesky allows 300, and a post going to both must fit the smaller. */
const X_LIMIT = 25_000
const X_SHORT = 280
const limitFor = (n: PostNetwork): number => (n === 'x' ? X_LIMIT : 300)

/** The @handle being typed at the caret, if any: where it starts, and the letters after the @. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|[\s(])@([A-Za-z0-9_.-]*)$/.exec(before)
  if (!m || !m[2]) return null
  return { start: before.length - m[2].length - 1, query: m[2] }
}

type Mention = { part: number; start: number; end: number; items: HandleSuggestion[]; index: number }

export default function Composer({ replyToId, quoteId, network = 'x', onDone, onCancel }: { replyToId?: string; quoteId?: string; network?: PostNetwork; onDone: () => void; onCancel?: () => void }): React.JSX.Element {
  const anchor = replyToId ?? quoteId
  const where: PostNetwork = anchor ? (isBskyId(anchor) ? 'bsky' : 'x') : network
  const LIMIT = limitFor(where)
  const [parts, setParts] = useState<string[]>([''])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [refused, setRefused] = useState(false) // X's API would not take this reply; offer the website instead
  const [mention, setMention] = useState<Mention | null>(null) // the @handle menu open under one part, if any
  const [speaking, setSpeaking] = useState(false) // the draft is being read aloud
  const stopSpeaking = useRef<(() => void) | null>(null)
  const boxes = useRef<(HTMLTextAreaElement | null)[]>([])
  const lookup = useRef(0) // answers to older lookups are ignored

  /** Opens x.com with the draft already in the reply box, for the replies this API level refuses. */
  const replyOnX = (): void => {
    const text = parts.map((p) => p.trim()).filter(Boolean).join('\n\n')
    const u = new URL('https://x.com/intent/post')
    if (replyToId) u.searchParams.set('in_reply_to', replyToId)
    u.searchParams.set('text', text)
    void window.api.openExternal(u.toString())
  }

  const update = (i: number, v: string): void => setParts((p) => p.map((x, j) => (j === i ? v : x)))

  /** Reads the whole draft aloud, every part of the thread in order, or stops a reading under way. */
  const readAloud = (): void => {
    if (stopSpeaking.current) {
      stopSpeaking.current()
      return
    }
    setSpeaking(true)
    stopSpeaking.current = speak(parts, () => {
      stopSpeaking.current = null
      setSpeaking(false)
    })
  }
  useEffect(() => () => stopSpeaking.current?.(), []) // leaving the composer stops the voice
  const over = parts.some((p) => [...p].length > LIMIT)
  const empty = parts.every((p) => !p.trim())

  /** After typing or moving the caret: offer handles if the caret sits in an @mention, otherwise close the menu. */
  const checkMention = (i: number): void => {
    const box = boxes.current[i]
    if (!box) return
    const at = mentionAt(box.value, box.selectionStart)
    if (!at) {
      if (mention) setMention(null)
      return
    }
    const id = ++lookup.current
    void window.api.suggestHandles(at.query, where).then((items) => {
      if (id !== lookup.current) return
      setMention(items.length ? { part: i, start: at.start, end: at.start + 1 + at.query.length, items, index: 0 } : null)
    })
  }
  useEffect(() => {
    if (!mention) return
    const t = setTimeout(() => checkMention(mention.part), 0) // keep the menu's range current after the text changes
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts])

  /** Puts the chosen handle in place of what was typed, with a space after it, and goes on typing from there. */
  const pick = (s: HandleSuggestion): void => {
    if (!mention) return
    const box = boxes.current[mention.part]
    const text = parts[mention.part]
    const inserted = '@' + s.handle + ' '
    const next = text.slice(0, mention.start) + inserted + text.slice(mention.end)
    update(mention.part, next)
    setMention(null)
    lookup.current++
    const caret = mention.start + inserted.length
    requestAnimationFrame(() => {
      if (!box) return
      box.focus()
      box.setSelectionRange(caret, caret)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!mention || !mention.items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setMention({ ...mention, index: (mention.index + d + mention.items.length) % mention.items.length })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(mention.items[mention.index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
    }
  }

  const submit = async (): Promise<void> => {
    stopSpeaking.current?.()
    setBusy(true)
    setMsg(null)
    setRefused(false)
    const texts = parts.map((p) => p.trim()).filter(Boolean)
    const r = await window.api.postThread(texts, replyToId, quoteId, where)
    setBusy(false)
    if (r.ok) {
      setMsg(`Posted${texts.length > 1 ? ` ${r.ids.length} posts` : ''}${r.via === 'web' ? ' through your web session' : ''}.`)
      setParts([''])
      setTimeout(onDone, 900)
    } else {
      setMsg(`Failed${r.ids.length ? ` after ${r.ids.length} post(s)` : ''}: ${r.error}`)
      if (where === 'x' && /403/.test(r.error ?? '') && /mentioned|author/.test(r.error ?? '')) setRefused(true)
    }
  }

  return (
    <div className="composer">
      {parts.map((p, i) => (
        <div key={i} className="part">
          <textarea
            ref={(el) => { boxes.current[i] = el }}
            value={p}
            rows={3}
            placeholder={i === 0 ? (replyToId ? 'Write your reply' : quoteId ? 'Add a comment' : 'What is on your mind?') : `Part ${i + 1}`}
            onChange={(e) => update(i, e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) checkMention(i) }}
            onClick={() => checkMention(i)}
            onBlur={() => setTimeout(() => setMention((m) => (m?.part === i ? null : m)), 150)} // after a click on the menu lands
          />
          {mention?.part === i ? (
            <ul className="mention-menu" role="listbox">
              {mention.items.map((s, k) => (
                <li key={s.network + s.handle} role="option" aria-selected={k === mention.index} className={k === mention.index ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); pick(s) }}>
                  {s.avatar ? <img src={s.avatar} alt="" /> : <span className="no-avatar" />}
                  {s.name ? <span className="name">{s.name}</span> : null}
                  <span className="muted">@{s.handle}</span>
                  {where === 'both' ? <span className={'tag ' + s.network}>{s.network === 'bsky' ? 'Bluesky' : 'X'}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="part-foot small">
            <span className={[...p].length > LIMIT ? 'error' : 'muted'}>
              {LIMIT === X_LIMIT ? `${[...p].length}${[...p].length > X_SHORT ? ' · long post' : ''}` : `${[...p].length}/${LIMIT}`}
            </span>
            {parts.length > 1 ? <button className="link" onClick={() => setParts((x) => x.filter((_, j) => j !== i))}>remove</button> : null}
          </div>
        </div>
      ))}
      <div className="actions">
        {!replyToId || parts.length > 0 ? <button className="link" onClick={() => setParts((x) => [...x, ''])}>+ Add to thread</button> : null}
        <span className="spacer" />
        {onCancel ? <button className="link" onClick={onCancel}>Cancel</button> : null}
        <button className="secondary speak" disabled={empty && !speaking} onClick={readAloud} title={speaking ? 'Stop reading' : 'Read the whole draft aloud'}>
          {speaking ? '■ Stop' : '🔊 Read aloud'}
        </button>
        <button className="primary" disabled={busy || over || empty} onClick={() => void submit()}>{busy ? 'Posting…' : replyToId ? 'Reply' : quoteId ? 'Quote' : parts.length > 1 ? 'Post thread' : 'Post'}</button>
      </div>
      {msg ? <div className={'small ' + (msg.startsWith('Failed') ? 'error' : 'muted')}>{msg}</div> : null}
      {refused ? (
        <div className="small muted refused">
          X's API only lets an app reply to or quote posts whose author mentioned you. The draft is kept: log in with your own account under Settings → Your account's web session and press the button again,
          or <button className="link" onClick={replyOnX}>reply on X instead</button>, which opens x.com with it filled in.
        </div>
      ) : null}
    </div>
  )
}
