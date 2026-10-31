import type React from 'react'
import { useEffect, useState } from 'react'
import type { Notification, NotificationSummary } from '@shared/types'
import Composer from './Composer'
import { PostActions, TweetBody, timeAgo } from './TweetCard'

export default function NotificationsView({ onOpenThread, onChange }: { onOpenThread: (tweetId: string) => void; onChange: () => void }): React.JSX.Element {
  const [data, setData] = useState<NotificationSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = async (refresh: boolean): Promise<void> => {
    setBusy(refresh)
    setErr(null)
    try {
      setData(await window.api.getNotifications(refresh))
    } catch (e) {
      setErr(String(e))
    }
    setBusy(false)
  }
  useEffect(() => {
    void load(false)
    return window.api.onNotificationsUpdated(() => void load(false)) // the scheduled check found something
  }, [])

  const unread = data?.items.filter((n) => !n.read) ?? []
  const markAll = async (): Promise<void> => {
    await window.api.markNotificationsRead(unread.map((n) => n.id))
    await load(false)
    onChange()
  }

  return (
    <div className="today">
      <header className="page-head">
        <div>
          <h1>Notifications</h1>
          <div className="muted small">
            {data?.fetchedAt ? `Checked ${timeAgo(data.fetchedAt)} ago` : 'Not checked yet'}
          </div>
        </div>
        <div className="head-actions">
          {unread.length ? <button className="secondary" onClick={() => void markAll()}>Mark all read</button> : null}
          <button className="primary" disabled={busy} onClick={() => void load(true)}>{busy ? 'Checking…' : 'Check now'}</button>
        </div>
      </header>
      {err ? <div className="error">{err}</div> : null}
      <div className="cards">
        {data?.items.map((n) => <NotificationCard key={n.id} n={n} onOpenThread={onOpenThread} onChange={() => { void load(false); onChange() }} />)}
        {data && data.items.length === 0 ? <p className="muted">No replies, mentions, or quotes yet. Press Check now.</p> : null}
      </div>
    </div>
  )
}

/** One notification. Reply and Quote open a composer right here; opening the post shows it in context. Either marks it read. */
function NotificationCard({ n, onOpenThread, onChange }: { n: Notification; onOpenThread: (tweetId: string) => void; onChange: () => void }): React.JSX.Element {
  const [compose, setCompose] = useState<'reply' | 'quote' | null>(null)
  const markRead = (): void => {
    if (!n.read) void window.api.markNotificationsRead([n.id]).then(onChange)
  }
  /** Opens the post with what it replies to above it and the replies under it, and marks the notification read. */
  const open = (): void => {
    markRead()
    onOpenThread(n.tweet!.id)
  }
  const openCard = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('a, button, video, img, .composer, .reply-box')) return // controls keep their own behaviour
    open()
  }
  const toggle = (kind: 'reply' | 'quote'): void => setCompose((c) => (c === kind ? null : kind))
  return (
    <article className={'card' + (n.read ? ' read' : '') + (n.tweet ? ' clickable' : '')} onClick={n.tweet ? openCard : undefined} title={n.tweet ? 'Open in context' : undefined}>
      <div className="card-meta">
        <span className={'tag ' + n.kind}>{n.kind}</span>
        {!n.read ? <span className="dot" /> : null}
      </div>
      {n.tweet ? <TweetBody tweet={n.tweet} /> : <p className="text">{n.text}</p>}
      {n.tweet ? (
        <div className="actions">
          <button className="link" onClick={() => toggle('reply')}>Reply</button>
          <PostActions tweet={n.tweet} onQuote={() => toggle('quote')} />
          <button className="link" onClick={open}>Open in context</button>
        </div>
      ) : null}
      {n.tweet && compose ? (
        <div className="reply-box" onClick={(e) => e.stopPropagation()}>
          <div className="muted small">{compose === 'reply' ? 'Replying to' : 'Quoting'} @{n.tweet.author.handle}</div>
          <Composer
            key={compose}
            replyToId={compose === 'reply' ? n.tweet.id : undefined}
            quoteId={compose === 'quote' ? n.tweet.id : undefined}
            onDone={() => { setCompose(null); markRead() }}
            onCancel={() => setCompose(null)}
          />
        </div>
      ) : null}
    </article>
  )
}
