import type React from 'react'
import { useEffect, useState } from 'react'
import type { Edition, EditionSummary } from '@shared/types'
import TweetCard from './TweetCard'

export default function ArchiveView({
  selectedId,
  onSelect,
  onOpenThread
}: {
  selectedId: number | null
  onSelect: (id: number | null) => void
  onOpenThread: (tweetId: string, editionId: number) => void
}): React.JSX.Element {
  const [list, setList] = useState<EditionSummary[]>([])
  const [edition, setEdition] = useState<Edition | null>(null)
  useEffect(() => {
    void window.api.listEditions().then(setList)
  }, [])
  useEffect(() => {
    if (selectedId === null) setEdition(null)
    else void window.api.getEdition(selectedId).then(setEdition)
  }, [selectedId])

  if (edition) {
    return (
      <div className="today">
        <header className="page-head">
          <div>
            <button className="link" onClick={() => onSelect(null)}>← Past editions</button>
            <h1>{edition.date}</h1>
            <div className="muted small">{edition.itemCount} posts · {edition.candidateCount} candidates</div>
          </div>
        </header>
        <div className="cards">
          {edition.items.map((item) => (
            <TweetCard key={item.tweet.id} item={item} editionId={edition.id} onOpenThread={(id) => onOpenThread(id, edition.id)} onChange={() => {}} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="today">
      <header className="page-head"><h1>Past editions</h1></header>
      {list.length === 0 ? <p className="muted">Nothing yet.</p> : null}
      <table className="table">
        <thead><tr><th>Date</th><th>Posts</th><th>Candidates</th><th>Priority</th><th>Voted</th></tr></thead>
        <tbody>
          {list.map((e) => (
            <tr key={e.id} onClick={() => onSelect(e.id)}>
              <td>{e.date}</td><td>{e.itemCount}</td><td>{e.candidateCount}</td><td>{e.priorityCount}</td><td>{e.votesCast}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
