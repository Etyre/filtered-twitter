import type React from 'react'
import { useEffect, useState } from 'react'
import type { NotificationSummary } from '@shared/types'
import { TweetBody, timeAgo } from './TweetCard'

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
        {data?.items.map((n) => {
          /** Opens the post with what it replies to above it and the replies under it, and marks the notification read. */
          const open = (): void => {
            void window.api.markNotificationsRead([n.id]).then(onChange)
            onOpenThread(n.tweet!.id)
          }
          const openCard = (e: React.MouseEvent): void => {
            if ((e.target as HTMLElement).closest('a, button, video, img, .composer')) return // controls keep their own behaviour
            open()
          }
          return (
            <article key={n.id} className={'card' + (n.read ? ' read' : '') + (n.tweet ? ' clickable' : '')} onClick={n.tweet ? openCard : undefined} title={n.tweet ? 'Open in context' : undefined}>
              <div className="card-meta">
                <span className={'tag ' + n.kind}>{n.kind}</span>
                {!n.read ? <span className="dot" /> : null}
              </div>
              {n.tweet ? <TweetBody tweet={n.tweet} /> : <p className="text">{n.text}</p>}
              {n.tweet ? (
                <div className="actions">
                  <button className="link" onClick={open}>{n.kind === 'reply' ? 'Open in context' : 'Open'} &amp; reply</button>
                </div>
              ) : null}
            </article>
          )
        })}
        {data && data.items.length === 0 ? <p className="muted">No replies, mentions, or quotes yet. Press Check now.</p> : null}
      </div>
    </div>
  )
}
