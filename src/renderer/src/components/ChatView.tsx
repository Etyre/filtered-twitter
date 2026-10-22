import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { DmMessage, DmSummary, Settings, Tweet } from '@shared/types'
import { timeAgo, TweetBody } from './TweetCard'

/** A post shared in a message, loaded through the browsing account and shown as a compact card. */
function SharedPost({ id }: { id: string }): React.JSX.Element {
  const [tweet, setTweet] = useState<Tweet | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void window.api.getTweet(id).then((t) => { if (live) setTweet(t) })
    return () => { live = false }
  }, [id])
  const url = `https://x.com/i/status/${id}`
  if (tweet === undefined) return <div className="quoted muted small">Loading post…</div>
  if (!tweet) return <div className="quoted small"><a href={url} onClick={(e) => { e.preventDefault(); void window.api.openExternal(url) }}>Post on X</a> (could not load it)</div>
  return <div className="quoted shared-post"><TweetBody tweet={tweet} compact /></div>
}

/** True when this link points at a post the message shows as a card, so the bare link can be left out of the text. */
function linkIsCard(m: DmMessage, link: string): boolean {
  const u = (m.urls ?? []).find((x) => x.short === link)
  const id = u?.expanded.match(/\/status\/(\d+)/)?.[1]
  return !!id && (m.tweetIds ?? []).includes(id)
}

/** The message with card links removed; empty when the message was only a shared post. */
function textWithoutCards(m: DmMessage): string {
  return m.text.replace(/https?:\/\/\S+/g, (l) => (linkIsCard(m, l) ? '' : l)).trim()
}

/** Message text with t.co links shown by their real address. */
function MessageText({ m }: { m: DmMessage }): React.JSX.Element {
  const parts = textWithoutCards(m).split(/(https?:\/\/\S+)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (!/^https?:\/\//.test(p)) return <span key={i}>{p}</span>
        const u = (m.urls ?? []).find((x) => x.short === p)
        const href = u?.expanded ?? p
        return <a key={i} href={href} onClick={(e) => { e.preventDefault(); void window.api.openExternal(href) }}>{(u?.display ?? p).slice(0, 60)}</a>
      })}
    </>
  )
}

export default function ChatView({ settings }: { settings: Settings | null }): React.JSX.Element {
  const [data, setData] = useState<DmSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sendErr, setSendErr] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  const load = async (refresh: boolean): Promise<void> => {
    setBusy(refresh)
    const d = await window.api.getDms(refresh)
    setData(d)
    setBusy(false)
    if (!selected && d.conversations.length) setSelected(d.conversations[0].id)
  }
  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [selected, data])

  const conv = data?.conversations.find((c) => c.id === selected) ?? null
  const send = async (): Promise<void> => {
    if (!conv || !draft.trim()) return
    setSendErr(null)
    const r = await window.api.sendDm(conv.id, draft.trim())
    if (r.ok) {
      setDraft('')
      await load(true)
    } else setSendErr(r.error ?? 'Failed')
  }

  if (!settings?.hasXApiKeys) {
    return (
      <div className="today narrow">
        <header className="page-head"><h1>Chat</h1></header>
        <p className="muted">Direct messages are read and sent through the official X API with your real account. Add your API keys in Settings first.</p>
      </div>
    )
  }

  return (
    <div className="chat">
      <aside className="chat-list">
        <div className="chat-list-head">
          <strong>Chat</strong>
          <button className="link small" disabled={busy} onClick={() => void load(true)}>{busy ? 'Checking…' : 'Refresh'}</button>
        </div>
        {data?.fetchedAt ? <div className="muted small pad">Checked {timeAgo(data.fetchedAt)} ago</div> : null}
        {data?.error ? <div className="error small pad">{data.error}</div> : null}
        {data?.conversations.map((c) => {
          const last = c.messages[c.messages.length - 1]
          return (
            <button key={c.id} className={'conv' + (c.id === selected ? ' on' : '')} onClick={() => setSelected(c.id)}>
              <div className="conv-head">
                <span className="name">{c.participants.map((p) => p.name || '@' + p.handle).join(', ') || 'Conversation'}</span>
                <span className="muted small">{timeAgo(c.lastAt)}</span>
              </div>
              <div className="muted small ellipsis">{last ? (last.mine ? 'You: ' : '') + last.text : ''}</div>
            </button>
          )
        })}
        {data && !data.conversations.length && !data.error ? <div className="muted small pad">No conversations loaded. Press Refresh.</div> : null}
      </aside>
      <section className="chat-pane">
        {conv ? (
          <>
            <div className="chat-pane-head">
              {conv.participants.map((p) => (
                <span key={p.id} className="who">
                  {p.avatar ? <img className="avatar small-avatar" src={p.avatar} alt="" /> : null}
                  <span className="name">{p.name}</span> <span className="handle">@{p.handle}</span>
                </span>
              ))}
            </div>
            <div className="messages">
              {conv.messages.map((m) => (
                <div key={m.id} className={'msg' + (m.mine ? ' mine' : '')}>
                  {textWithoutCards(m) ? <div className="bubble"><MessageText m={m} /></div> : null}
                  {(m.tweetIds ?? []).map((id) => <SharedPost key={id} id={id} />)}
                  <div className="muted small">{new Date(m.createdAt).toLocaleString()}</div>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <div className="chat-compose">
              <textarea rows={2} value={draft} placeholder="Write a message" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }} />
              <button className="primary" disabled={!draft.trim()} onClick={() => void send()}>Send</button>
            </div>
            {sendErr ? <div className="error small pad">{sendErr}</div> : null}
          </>
        ) : (
          <div className="muted pad">Select a conversation.</div>
        )}
      </section>
    </div>
  )
}
