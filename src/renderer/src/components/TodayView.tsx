import type React from 'react'
import { useMemo, useState } from 'react'
import type { Edition, Progress, Settings } from '@shared/types'
import TweetCard from './TweetCard'

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
  const items = useMemo(() => {
    if (!edition) return []
    if (section === 'priority') return edition.items.filter((i) => i.priorityAccount)
    if (section === 'rest') return edition.items.filter((i) => !i.priorityAccount)
    return edition.items
  }, [edition, section])

  const voted = edition ? edition.items.filter((i) => i.vote !== 0).length : 0
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="today">
      <header className="page-head">
        <div>
          <h1>{today}</h1>
          {edition ? (
            <div className="muted small">
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
          <button className={edition ? 'secondary' : 'primary'} disabled={!!building} onClick={() => void onBuild(!!edition)}>
            {building ? 'Building…' : edition ? 'Rebuild' : "Build today's edition"}
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
          <p className="muted">It takes a few minutes: the app reads your priority accounts, your Following timeline, and a few AI searches, then ranks everything.</p>
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
          <p>That's everything for today.</p>
          <p className="muted small">The next edition arrives tomorrow. Your votes shape it.</p>
        </div>
      ) : null}
    </div>
  )
}
