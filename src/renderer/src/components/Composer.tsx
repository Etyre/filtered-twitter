import type React from 'react'
import { useState } from 'react'
import type { PostNetwork } from '@shared/types'
import { isBskyId } from '@shared/net'

/** X allows 280 characters, Bluesky 300; a post going to both must fit the smaller. */
const limitFor = (n: PostNetwork): number => (n === 'bsky' ? 300 : 280)

export default function Composer({ replyToId, quoteId, network = 'x', onDone, onCancel }: { replyToId?: string; quoteId?: string; network?: PostNetwork; onDone: () => void; onCancel?: () => void }): React.JSX.Element {
  const anchor = replyToId ?? quoteId
  const where: PostNetwork = anchor ? (isBskyId(anchor) ? 'bsky' : 'x') : network
  const LIMIT = limitFor(where)
  const [parts, setParts] = useState<string[]>([''])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [refused, setRefused] = useState(false) // X's API would not take this reply; offer the website instead

  /** Opens x.com with the draft already in the reply box, for the replies this API level refuses. */
  const replyOnX = (): void => {
    const text = parts.map((p) => p.trim()).filter(Boolean).join('\n\n')
    const u = new URL('https://x.com/intent/post')
    if (replyToId) u.searchParams.set('in_reply_to', replyToId)
    u.searchParams.set('text', text)
    void window.api.openExternal(u.toString())
  }

  const update = (i: number, v: string): void => setParts((p) => p.map((x, j) => (j === i ? v : x)))
  const over = parts.some((p) => [...p].length > LIMIT)
  const empty = parts.every((p) => !p.trim())

  const submit = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    setRefused(false)
    const texts = parts.map((p) => p.trim()).filter(Boolean)
    const r = await window.api.postThread(texts, replyToId, quoteId, where)
    setBusy(false)
    if (r.ok) {
      setMsg(`Posted${texts.length > 1 ? ` ${r.ids.length} posts` : ''}.`)
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
          <textarea value={p} rows={3} placeholder={i === 0 ? (replyToId ? 'Write your reply' : quoteId ? 'Add a comment' : 'What is on your mind?') : `Part ${i + 1}`} onChange={(e) => update(i, e.target.value)} />
          <div className="part-foot small">
            <span className={[...p].length > LIMIT ? 'error' : 'muted'}>{[...p].length}/{LIMIT}</span>
            {parts.length > 1 ? <button className="link" onClick={() => setParts((x) => x.filter((_, j) => j !== i))}>remove</button> : null}
          </div>
        </div>
      ))}
      <div className="actions">
        {!replyToId || parts.length > 0 ? <button className="link" onClick={() => setParts((x) => [...x, ''])}>+ Add to thread</button> : null}
        <span className="spacer" />
        {onCancel ? <button className="link" onClick={onCancel}>Cancel</button> : null}
        <button className="primary" disabled={busy || over || empty} onClick={() => void submit()}>{busy ? 'Posting…' : replyToId ? 'Reply' : quoteId ? 'Quote' : parts.length > 1 ? 'Post thread' : 'Post'}</button>
      </div>
      {msg ? <div className={'small ' + (msg.startsWith('Failed') ? 'error' : 'muted')}>{msg}</div> : null}
      {refused ? (
        <div className="small muted refused">
          This API level only lets you reply to people who mentioned you. The draft is kept:{' '}
          <button className="link" onClick={replyOnX}>reply on X instead</button>, which opens x.com with it filled in.
        </div>
      ) : null}
    </div>
  )
}
