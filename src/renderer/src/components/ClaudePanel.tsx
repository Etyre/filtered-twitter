import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, Tweet } from '@shared/types'
import { readDraft, writeDraft } from '../drafts'

// A side panel for talking with Claude about one post and the discussion around it.
// Opened from any post's "Talk to Claude" button; transcripts are kept per post for the session.

let listener: ((t: Tweet | null) => void) | null = null
const transcripts = new Map<string, ChatMessage[]>()

/** Opens the panel on this post (or brings it back to it). */
export function openClaudeChat(tweet: Tweet): void {
  listener?.(tweet)
}

/**
 * Claude's replies come as light Markdown even when asked for plain prose: bold and italic
 * emphasis, inline code, and bare links. This renders just those inline marks; line breaks and
 * "-" lists come through as written, since the message keeps its whitespace.
 */
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])|`([^`\n]+)`|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = out.length
    if (m[1] !== undefined) out.push(<strong key={k}>{renderInline(m[1])}</strong>)
    else if (m[2] !== undefined) out.push(<em key={k}>{renderInline(m[2])}</em>)
    else if (m[3] !== undefined) out.push(<em key={k}>{renderInline(m[3])}</em>)
    else if (m[4] !== undefined) out.push(<code key={k}>{m[4]}</code>)
    else {
      const url = m[5]
      out.push(<a key={k} href={url} onClick={(e) => { e.preventDefault(); void window.api.openExternal(url) }}>{url}</a>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const SUGGESTIONS = ['What is this about?', 'What am I missing here?', 'Is this true?', 'Steelman the best reply.', 'Draft a reply for me.']

export default function ClaudePanel(): React.JSX.Element | null {
  const [tweet, setTweet] = useState<Tweet | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // the request being answered
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null) // what Claude is doing right now, while it searches
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    listener = (t) => {
      setTweet(t)
      setErr(null)
      setDraft(t ? readDraft<string>(`claude:${t.id}`) ?? '' : '')
      setMessages(t ? transcripts.get(t.id) ?? [] : [])
      setTimeout(() => input.current?.focus(), 50)
    }
    return () => { listener = null }
  }, [])

  // Streamed text lands on the last assistant message.
  useEffect(() => window.api.onChatDelta((requestId, delta) => {
    if (!busyRef.current || requestId !== busyRef.current) return
    if (delta.status) setStatus(delta.status)
    const text = delta.text
    if (!text) return
    setStatus(null)
    setMessages((ms) => {
      const last = ms[ms.length - 1]
      if (!last || last.role !== 'assistant') return [...ms, { role: 'assistant', text }]
      return [...ms.slice(0, -1), { role: 'assistant', text: last.text + text }]
    })
  }), [])
  const busyRef = useRef<string | null>(null)
  busyRef.current = busy

  useEffect(() => {
    if (tweet) transcripts.set(tweet.id, messages)
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, tweet])

  if (!tweet) return null

  const send = async (text: string): Promise<void> => {
    const q = text.trim()
    if (!q || busy) return
    const history: ChatMessage[] = [...messages, { role: 'user', text: q }]
    const requestId = `${tweet.id}:${Date.now()}`
    setMessages([...history, { role: 'assistant', text: '' }])
    setDraft('')
    writeDraft(`claude:${tweet.id}`, '')
    setErr(null)
    setBusy(requestId)
    busyRef.current = requestId
    const r = await window.api.askClaude(tweet.id, history, requestId)
    setStatus(null)
    setBusy(null)
    busyRef.current = null
    setMessages((ms) => {
      const last = ms[ms.length - 1]
      const text = r.text ?? last?.text ?? ''
      const kept = last?.role === 'assistant' ? ms.slice(0, -1) : ms
      return text.trim() ? [...kept, { role: 'assistant', text }] : kept
    })
    if (!r.ok) setErr(r.error ?? 'Something went wrong.')
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(draft)
    }
  }

  const shown = tweet.retweetOf ?? tweet
  return (
    <aside className="claude-panel">
      <div className="claude-head">
        <div className="claude-title">
          <strong>Talk to Claude</strong>
          <span className="muted small">about @{shown.author.handle}'s post and its discussion</span>
        </div>
        <button className="link" onClick={() => setTweet(null)} title="Close (the conversation is kept)">✕</button>
      </div>
      <div className="claude-post muted small">{shown.text.replace(/\s+/g, ' ').slice(0, 180)}{shown.text.length > 180 ? '…' : ''}</div>
      <div className="claude-log" ref={log}>
        {messages.length === 0 ? (
          <div className="claude-suggest">
            {SUGGESTIONS.map((s) => <button key={s} className="secondary small" onClick={() => void send(s)}>{s}</button>)}
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={`claude-msg ${m.role}`}>
            {m.text ? (m.role === 'assistant' ? renderInline(m.text) : m.text) : busy && !status ? <span className="muted">Thinking…</span> : null}
          </div>
        ))}
        {busy && status ? <div className="muted small claude-status">{status}</div> : null}
        {err ? <div className="error small">{err}</div> : null}
      </div>
      <div className="claude-compose">
        <textarea ref={input} rows={2} value={draft} placeholder="Ask about this post… (Enter to send, Shift+Enter for a new line)" onChange={(e) => { setDraft(e.target.value); writeDraft(`claude:${tweet.id}`, e.target.value) }} onKeyDown={onKey} />
        <div className="claude-compose-row">
          {messages.length ? <button className="link small" disabled={!!busy} onClick={() => { setMessages([]); setErr(null) }}>Clear</button> : <span />}
          {busy ? (
            <button className="secondary" onClick={() => void window.api.stopClaude(busy)}>Stop</button>
          ) : (
            <button className="primary" disabled={!draft.trim()} onClick={() => void send(draft)}>Send</button>
          )}
        </div>
      </div>
    </aside>
  )
}
