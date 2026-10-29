import type React from 'react'
import { useMemo, useState } from 'react'
import type { Edition, Progress, Settings } from '@shared/types'
import TweetCard from './TweetCard'
import { orderItems } from '../order'

export default function TodayView({
  edition,
  settings,
  progress,
  onBuild,
  onOpenThread,
  onChange
}: {
  edition: Edition | null
  settings: Settings | null
  progress: Progress | null
  onBuild: (force: boolean) => Promise<void>
  onOpenThread: (tweetId: string, editionId: number) => void
  onChange: () => void
}): React.JSX.Element {
  const [section, setSection] = useState<'all' | 'priority' | 'rest'>('all')
  const building = progress && !progress.done
  const ordering = settings?.ordering ?? 'priority'
  const items = useMemo(() => {
    if (!edition) return []
    const base = section === 'priority' ? edition.items.filter((i) => i.priorityAccount) : section === 'rest' ? edition.items.filter((i) => !i.priorityAccount) : edition.items
    return orderItems(base, ordering)
  }, [edition, section, ordering])

  const voted = edition ? edition.items.filter((i) => i.vote !== 0).length : 0
  const now = new Date()
  const today = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const stale = !!edition && edition.date !== todayKey // the last edition, shown until today's is built
  const editionDay = edition ? new Date(edition.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : ''
  const nextBuild = settings?.autoBuild ? ` The next one is built at ${settings.buildHour}:00.` : ''

  return (
    <div className="today">
      <header className="page-head">
        <div>
          <h1>{today}</h1>
          {edition ? (
            <div className="muted small">
              {stale ? <>Edition of {editionDay}.{nextBuild} · </> : null}
              {edition.itemCount} posts chosen from {edition.candidateCount} candidates · {edition.priorityCount} from priority accounts · {voted} voted
            </div>
          ) : (
            <div className="muted small">No edition yet for today.</div>
          )}
        </div>
        <div className="head-actions">
          {edition ? (
            <div className="segmented">
              <button className={section === 'all' ? 'on' : ''} onClick={() => setSection('all')}>All</button>
              <button className={section === 'priority' ? 'on' : ''} onClick={() => setSection('priority')}>Priority</button>
              <button className={section === 'rest' ? 'on' : ''} onClick={() => setSection('rest')}>Filtered</button>
            </div>
          ) : null}
          <button className={edition && !stale ? 'secondary' : 'primary'} disabled={!!building} onClick={() => void onBuild(!!edition && !stale)}>
            {building ? 'Building…' : edition && !stale ? 'Rebuild' : "Build today's edition"}
          </button>
        </div>
      </header>

      {building ? (
        <div className="progress">
          <div className="spinner" />
          <div>
            <strong>{progress!.phase}</strong>
            <div className="muted small">{progress!.detail}</div>
          </div>
        </div>
      ) : null}
      {progress?.error ? <div className="error">{progress.error}</div> : null}
      {edition?.notes ? <div className="notes muted small">{edition.notes}</div> : null}

      {!edition && !building ? (
        <div className="empty">
          <p>Your edition is built once a day{settings?.autoBuild ? ` at ${settings.buildHour}:00` : ''}, or now, on request.</p>
          <p className="muted">It takes a few minutes: the app reads your priority accounts, your Following timeline{settings?.bskyEnabled ? ', your Bluesky feed' : ''}, and a few AI searches, then ranks everything.</p>
        </div>
      ) : null}

      <div className="cards">
        {items.map((item) => (
          <TweetCard key={item.tweet.id} item={item} editionId={edition!.id} onOpenThread={(id) => onOpenThread(id, edition!.id)} onChange={onChange} />
        ))}
      </div>

      {edition && items.length ? (
        <div className="end">
          <div className="end-mark">◆</div>
          <p>{stale ? `That's everything from ${editionDay}.` : "That's everything for today."}</p>
          <p className="muted small">{stale ? `Today's edition is not built yet.${nextBuild}` : 'The next edition arrives tomorrow.'} Your votes shape it.</p>
        </div>
      ) : null}
    </div>
  )
}
