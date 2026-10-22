import type React from 'react'
import { createContext, useContext, useEffect, useState } from 'react'
import type { EditionItem, Poll, Tweet } from '@shared/types'

/** How to open a post as its own discussion inside the app. Without a provider, quoted posts open on X instead. */
export const OpenThreadContext = createContext<((tweetId: string) => void) | null>(null)

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export function fmtCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

function Linkified({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(https?:\/\/\S+|@[A-Za-z0-9_]{1,15})/g)
  return (
    <>
      {parts.map((p, i) => {
        if (/^https?:\/\//.test(p)) return <a key={i} href={p} onClick={(e) => { e.preventDefault(); void window.api.openExternal(p) }}>{p.replace(/^https?:\/\//, '').slice(0, 60)}</a>
        if (/^@/.test(p)) return <span key={i} className="handle">{p}</span>
        return <span key={i}>{p}</span>
      })}
    </>
  )
}

const QUOTE_PREVIEW = 280 // a quoted post shows this much until asked for more

/** Cuts text at the last word boundary before `max` characters. */
function preview(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  const cut = chars.slice(0, max).join('')
  const atWord = cut.lastIndexOf(' ')
  return (atWord > max * 0.6 ? cut.slice(0, atWord) : cut).trimEnd() + '…'
}

/** A post's video. If Chromium cannot play it, say why instead of showing a dead player. */
function Video({ src, poster, onOpen }: { src: string; poster: string; onOpen: () => void }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  if (err) {
    return (
      <div className="video-failed" onClick={onOpen}>
        <img src={poster} alt="" loading="lazy" />
        <div className="small">Video would not play here ({err}). Click to watch on X.</div>
      </div>
    )
  }
  return (
    <video
      src={src}
      poster={poster}
      controls
      preload="metadata"
      playsInline
      onError={(e) => {
        const er = e.currentTarget.error
        setErr(er ? `error ${er.code}${er.message ? ': ' + er.message : ''}` : 'unknown error')
      }}
    />
  )
}

// One vote per post, shared by every copy of it on screen (edition card, quote, reply), so they cannot disagree.
type Vote = 1 | -1 | 0
const knownVotes = new Map<string, Vote>()
const voteListeners = new Map<string, Set<(v: Vote) => void>>()
function publishVote(id: string, v: Vote): void {
  knownVotes.set(id, v)
  voteListeners.get(id)?.forEach((fn) => fn(v))
}
/** The shared vote for a post. `initial` seeds it when the caller already knows (an edition item); otherwise it is fetched once. */
function useSharedVote(id: string, initial?: Vote): Vote {
  const [vote, setLocal] = useState<Vote>(knownVotes.get(id) ?? initial ?? 0)
  useEffect(() => {
    const set = voteListeners.get(id) ?? new Set()
    set.add(setLocal)
    voteListeners.set(id, set)
    if (knownVotes.has(id)) setLocal(knownVotes.get(id)!)
    else if (initial !== undefined) knownVotes.set(id, initial)
    else void window.api.getVote(id).then((v) => publishVote(id, v))
    return () => { set.delete(setLocal) }
  }, [id, initial])
  return vote
}

/** Up and down votes for any post, inside or outside the edition. Up also likes on X; down only teaches the filter. */
export function VoteButtons({ tweet, small = false, initial, onChange }: { tweet: Tweet; small?: boolean; initial?: Vote; onChange?: () => void }): React.JSX.Element {
  const vote = useSharedVote(tweet.id, initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const cast = async (v: 1 | -1): Promise<void> => {
    const next: Vote = vote === v ? 0 : v
    publishVote(tweet.id, next)
    setBusy(true)
    setErr(null)
    const r = await window.api.voteOnTweet(tweet, next)
    if (r.likeError) setErr('Vote saved, but the like failed: ' + r.likeError)
    setBusy(false)
    onChange?.()
  }
  return (
    <span className={'votes' + (small ? ' small' : '')} onClick={(e) => e.stopPropagation()}>
      <button className={'vote up' + (vote === 1 ? ' on' : '')} disabled={busy} onClick={() => void cast(1)} title="Upvote (also likes on X)">▲ {vote === 1 ? 'Liked' : 'Up'}</button>
      <button className={'vote down' + (vote === -1 ? ' on' : '')} disabled={busy} onClick={() => void cast(-1)} title="Downvote (less like this)">▼ {vote === -1 ? 'Less' : 'Down'}</button>
      {err ? <span className="error small">{err}</span> : null}
    </span>
  )
}

/** A poll as bars: each option's share, the leader marked, and whether it is still open. */
function PollView({ poll }: { poll: Poll }): React.JSX.Element {
  const top = Math.max(...poll.options.map((o) => o.votes))
  const open = !poll.final && (!poll.endsAt || new Date(poll.endsAt) > new Date())
  const ends = poll.endsAt ? new Date(poll.endsAt) : null
  const left = ends ? Math.max(0, ends.getTime() - Date.now()) : 0
  const leftText = left >= 86400e3 ? `${Math.round(left / 86400e3)}d left` : left >= 3600e3 ? `${Math.round(left / 3600e3)}h left` : `${Math.max(1, Math.round(left / 60e3))}m left`
  return (
    <div className="poll" onClick={(e) => e.stopPropagation()}>
      {poll.options.map((o, i) => {
        const pct = poll.totalVotes ? Math.round((o.votes / poll.totalVotes) * 100) : 0
        return (
          <div key={i} className={'poll-option' + (o.votes === top && poll.totalVotes ? ' lead' : '')}>
            <div className="poll-bar" style={{ width: `${Math.max(2, pct)}%` }} />
            <span className="poll-label">{o.label}</span>
            <span className="poll-pct">{pct}%</span>
          </div>
        )
      })}
      <div className="muted small">{fmtCount(poll.totalVotes)} votes · {open ? (ends ? leftText : 'open') : 'final results'}</div>
    </div>
  )
}

export function TweetBody({ tweet, compact = false }: { tweet: Tweet; compact?: boolean }): React.JSX.Element {
  const openOnX = (): void => void window.api.openExternal(`https://x.com/${tweet.author.handle}/status/${tweet.id}`)
  const [showAll, setShowAll] = useState(false)
  const folded = compact && !showAll && [...tweet.text].length > QUOTE_PREVIEW
  const openThread = useContext(OpenThreadContext)
  const openQuoted = (e: React.MouseEvent): void => {
    if (!tweet.quoted || (e.target as HTMLElement).closest('a, button, video')) return // links and buttons inside keep their own behaviour
    e.stopPropagation() // the card around it would otherwise open the outer post
    if (openThread) openThread(tweet.quoted.id)
    else void window.api.openExternal(`https://x.com/${tweet.quoted.author.handle}/status/${tweet.quoted.id}`)
  }
  return (
    <div className={'tweet-body' + (compact ? ' compact' : '')}>
      <div className="tweet-head">
        {tweet.author.avatar ? <img className="avatar" src={tweet.author.avatar} alt="" /> : <div className="avatar" />}
        <div className="who">
          <span className="name">{tweet.author.name}</span>
          <span className="handle">@{tweet.author.handle}</span>
          {tweet.author.verified ? <span className="verified" title="verified">✓</span> : null}
        </div>
        <button className="time link" title={new Date(tweet.createdAt).toLocaleString()} onClick={openOnX}>{timeAgo(tweet.createdAt)}</button>
      </div>
      {tweet.retweetedBy ? <div className="muted small">Reposted by @{tweet.retweetedBy.handle}</div> : null}
      {tweet.inReplyToHandle ? (
        tweet.inReplyToHandle.toLowerCase() === tweet.author.handle.toLowerCase()
          ? <div className="muted small thread-mark">Part of a thread</div>
          : <div className="muted small">Replying to @{tweet.inReplyToHandle}</div>
      ) : null}
      <p className="text">
        <Linkified text={folded ? preview(tweet.text, QUOTE_PREVIEW) : tweet.text} />
        {folded ? <> <button className="link small" onClick={() => setShowAll(true)}>Show more</button></> : null}
      </p>
      {tweet.media.length ? (
        <div className={'media n' + Math.min(4, tweet.media.length)}>
          {tweet.media.slice(0, 4).map((m, i) =>
            m.videoUrl ? (
              <Video key={i} src={m.videoUrl} poster={m.url} onOpen={openOnX} />
            ) : (
              <img key={i} src={m.url} alt="" loading="lazy" onClick={openOnX} />
            )
          )}
        </div>
      ) : null}
      {tweet.poll ? <PollView poll={tweet.poll} /> : null}
      {tweet.quoted ? (
        <div className="quoted clickable" role="link" title="Open this post" onClick={openQuoted}>
          <TweetBody tweet={tweet.quoted} compact />
          <div className="actions small"><VoteButtons tweet={tweet.quoted} small /></div>
        </div>
      ) : null}
      {!compact ? (
        <div className="stats muted small">
          <span>{fmtCount(tweet.replies)} replies</span>
          <span>{fmtCount(tweet.reposts)} reposts</span>
          <span>{fmtCount(tweet.likes)} likes</span>
          {tweet.views ? <span>{fmtCount(tweet.views)} views</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export default function TweetCard({
  item,
  editionId,
  onOpenThread,
  onChange
}: {
  item: EditionItem
  editionId: number
  onOpenThread: (tweetId: string) => void
  onChange: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const vote = useSharedVote(item.tweet.id, item.vote)
  const [reposted, setReposted] = useState(false)

  const doRepost = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await window.api.repost(item.tweet.id)
    if (r.ok) setReposted(true)
    else setErr('Repost failed: ' + r.error)
    setBusy(false)
  }

  void editionId // the vote path finds the post's edition itself
  const cat = item.category
  /** Clicking the card itself opens the post with what it replies to and the replies under it. Links, buttons, and media keep their own behaviour. */
  const openCard = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('a, button, video, img')) return
    onOpenThread(item.tweet.id)
  }
  return (
    <article className={'card clickable' + (vote === -1 ? ' downvoted' : '')} onClick={openCard}>
      <div className="card-meta">
        <span className="rank">#{item.rank}</span>
        {item.priorityAccount ? <span className="tag prio">priority</span> : <span className={'tag ' + cat}>{cat.replace('_', ' ')}</span>}
        {item.reason ? <span className="reason muted">{item.reason}</span> : null}
      </div>
      <TweetBody tweet={item.tweet} />
      <div className="actions">
        <VoteButtons tweet={item.tweet} initial={item.vote} onChange={onChange} />
        <button className="link" onClick={() => onOpenThread(item.tweet.id)}>
          {item.tweet.replies ? `Discussion (${fmtCount(item.tweet.replies)})` : 'Discussion'}{item.opened ? ' · seen' : ''}
        </button>
        <button className="link" onClick={() => onOpenThread(item.tweet.id)}>{item.replied ? 'Replied ✓' : 'Reply'}</button>
        <button className="link" disabled={busy || reposted} onClick={() => void doRepost()}>{reposted ? 'Reposted ✓' : 'Repost'}</button>
      </div>
      {err ? <div className="error small">{err}</div> : null}
    </article>
  )
}
