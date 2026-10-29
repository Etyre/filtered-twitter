import type React from 'react'
import Composer from './Composer'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { EditionItem, LinkCard, Poll, Tweet, Vote } from '@shared/types'
import { networkName, networkOf, postUrl } from '@shared/net'
import { openImages } from './Lightbox'
import { openClaudeChat } from './ClaudePanel'
import Hls from 'hls.js'

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
  // X handles are letters, digits and underscores; Bluesky handles are domain names, so dots inside a handle count, a trailing one does not.
  const parts = text.split(/(https?:\/\/\S+|@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g)
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

/** Bluesky serves video as an HLS playlist, which Chromium's <video> cannot play on its own. */
const isHls = (src: string): boolean => /\.m3u8(\?|$)/.test(src)

/** A post's video. HLS streams go through hls.js; if the video cannot play, say why instead of showing a dead player. */
function Video({ src, poster, ratio, where, onOpen }: { src: string; poster: string; ratio?: string; where: string; onOpen: () => void }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  const el = useRef<HTMLVideoElement>(null)
  const hls = isHls(src)
  useEffect(() => {
    if (!hls || !el.current) return
    if (!Hls.isSupported()) {
      setErr('HLS not supported')
      return
    }
    const h = new Hls({ enableWorker: false })
    h.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setErr(data.details) })
    h.loadSource(src)
    h.attachMedia(el.current)
    return () => h.destroy()
  }, [src, hls])
  if (err) {
    return (
      <div className="video-failed" onClick={onOpen}>
        <img src={poster} alt="" loading="lazy" />
        <div className="small">Video would not play here ({err}). Click to watch on {where}.</div>
      </div>
    )
  }
  return (
    <video
      ref={el}
      src={hls ? undefined : src}
      poster={poster}
      style={ratio ? { aspectRatio: ratio } : undefined}
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

// Reposts, shared the same way: once a post is reposted, every copy of it says so.
const knownReposts = new Map<string, boolean>() // reposts made or undone in this session, overriding what the stored post says
const repostListeners = new Map<string, Set<() => void>>()
function setReposted(id: string, on: boolean): void {
  knownReposts.set(id, on)
  repostListeners.get(id)?.forEach((fn) => fn())
}
function useReposted(tweet: Tweet): boolean {
  const [, bump] = useState(0)
  useEffect(() => {
    const set = repostListeners.get(tweet.id) ?? new Set()
    const fn = (): void => bump((n) => n + 1)
    set.add(fn)
    repostListeners.set(tweet.id, set)
    return () => { set.delete(fn) }
  }, [tweet.id])
  return knownReposts.get(tweet.id) ?? !!tweet.reposted
}

/** A link preview, as Bluesky attaches to posts. */
function CardView({ card }: { card: LinkCard }): React.JSX.Element {
  let host = ''
  try {
    host = new URL(card.url).hostname.replace(/^www\./, '')
  } catch {
    /* leave empty */
  }
  return (
    <a className="link-card" href={card.url} onClick={(e) => { e.preventDefault(); e.stopPropagation(); void window.api.openExternal(card.url) }}>
      {card.image ? <img src={card.image} alt="" loading="lazy" /> : null}
      <div className="link-card-text">
        <div className="link-card-title">{card.title}</div>
        {card.description ? <div className="muted small link-card-desc">{card.description}</div> : null}
        {host ? <div className="muted small">{host}</div> : null}
      </div>
    </a>
  )
}

/** Repost and Quote for any post. Repost goes straight to the post's network; Quote asks the parent to open a composer. */
export function PostActions({ tweet, onQuote }: { tweet: Tweet; onQuote: () => void }): React.JSX.Element {
  const reposted = useReposted(tweet)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const doRepost = async (on: boolean): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = on ? await window.api.repost(tweet.id) : await window.api.unrepost(tweet.id)
    if (r.ok) setReposted(tweet.id, on)
    else setErr((on ? 'Repost' : 'Undo repost') + ' failed: ' + r.error)
    setBusy(false)
  }
  const where = networkName(networkOf(tweet))
  return (
    <>
      {reposted ? (
        <button className="link" disabled={busy} onClick={() => void doRepost(false)} title={`Take back your repost on ${where}`}>{busy ? 'Undoing…' : 'Reposted ✓ · Undo'}</button>
      ) : (
        <button className="link" disabled={busy} onClick={() => void doRepost(true)} title={`Repost from your ${where} account`}>{busy ? 'Reposting…' : 'Repost'}</button>
      )}
      <button className="link" onClick={onQuote} title="Quote this post">Quote</button>
      <button className="link" onClick={() => openClaudeChat(tweet)} title="Open a chat with Claude about this post and its discussion">Talk to Claude</button>
      {err ? <span className="error small">{err}</span> : null}
    </>
  )
}

/** Up and down votes for any post, inside or outside the edition. Up also likes it on its network; down only teaches the filter. */
export function VoteButtons({ tweet, small = false, initial, onChange }: { tweet: Tweet; small?: boolean; initial?: Vote; onChange?: () => void }): React.JSX.Element {
  const vote = useSharedVote(tweet.id, initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Up and Down toggle off. Super toggles back to a plain upvote, so the like it made stays.
  const cast = async (v: 2 | 1 | -1): Promise<void> => {
    const next: Vote = v === 2 ? (vote === 2 ? 1 : 2) : v === 1 ? (vote >= 1 ? 0 : 1) : vote === -1 ? 0 : -1
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
      <button className={'vote up' + (vote >= 1 ? ' on' : '')} disabled={busy} onClick={() => void cast(1)} title={`Upvote (also likes on ${networkName(networkOf(tweet))})`}>▲ {vote >= 1 ? 'Liked' : 'Up'}</button>
      <button className={'vote super' + (vote === 2 ? ' on' : '')} disabled={busy} onClick={() => void cast(2)} title="Super upvote: this was extremely valuable to me (also likes it)">★ {vote === 2 ? 'Essential' : 'Super'}</button>
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

// X's codes for "no particular language"; anything else that is not English can be translated.
const UNTRANSLATABLE = new Set(['en', 'und', 'qme', 'qht', 'qst', 'qam', 'zxx', 'art'])

export function TweetBody({ tweet, compact = false }: { tweet: Tweet; compact?: boolean }): React.JSX.Element {
  const net = networkOf(tweet)
  const openOnX = (): void => void window.api.openExternal(postUrl(tweet))
  const photos = tweet.media.filter((x) => x.type === 'photo').map((x) => x.url)
  const [showAll, setShowAll] = useState(false)
  // Translation: what the stored post carries, or what the Translate button just fetched.
  const [translation, setTranslation] = useState<string | null>(tweet.translation ?? null)
  useEffect(() => { if (tweet.translation) setTranslation(tweet.translation) }, [tweet.translation]) // a translation made after the post was shown
  const [showOriginal, setShowOriginal] = useState(false)
  const [translating, setTranslating] = useState(false)
  const foreign = !!tweet.lang && !UNTRANSLATABLE.has(tweet.lang)
  const translate = async (): Promise<void> => {
    setTranslating(true)
    const t = await window.api.translateTweet(tweet.id)
    setTranslating(false)
    if (t?.translation) setTranslation(t.translation)
  }
  const text = translation && !showOriginal ? translation : tweet.text
  const folded = compact && !showAll && [...text].length > QUOTE_PREVIEW
  const openThread = useContext(OpenThreadContext)
  const openQuoted = (e: React.MouseEvent): void => {
    if (!tweet.quoted || (e.target as HTMLElement).closest('a, button, video')) return // links and buttons inside keep their own behaviour
    e.stopPropagation() // the card around it would otherwise open the outer post
    if (openThread) openThread(tweet.quoted.id)
    else void window.api.openExternal(postUrl(tweet.quoted))
  }
  return (
    <div className={'tweet-body' + (compact ? ' compact' : '')}>
      <div className="tweet-head">
        {tweet.author.avatar ? <img className="avatar" src={tweet.author.avatar} alt="" /> : <div className="avatar" />}
        <div className="who">
          <span className="name">{tweet.author.name}</span>
          <span className="handle">@{tweet.author.handle}</span>
          {tweet.author.verified ? <span className="verified" title="verified">✓</span> : null}
          {net === 'bsky' ? <span className="tag bsky" title="A Bluesky post">Bluesky</span> : null}
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
        <Linkified text={folded ? preview(text, QUOTE_PREVIEW) : text} />
        {folded ? <> <button className="link small" onClick={() => setShowAll(true)}>Show more</button></> : null}
      </p>
      {translation ? (
        <div className="muted small translation-note">
          {showOriginal ? 'Original' : `Translated from ${tweet.lang}`} · <button className="link small" onClick={() => setShowOriginal((o) => !o)}>{showOriginal ? 'show translation' : 'show original'}</button>
        </div>
      ) : foreign ? (
        <div className="muted small translation-note">
          <button className="link small" disabled={translating} onClick={() => void translate()}>{translating ? 'Translating…' : 'Translate'}</button>
        </div>
      ) : null}
      {tweet.media.length ? (
        <div className={'media n' + Math.min(4, tweet.media.length)}>
          {/* photos open in the viewer, in order, so the arrows step through this post's pictures */}
          {tweet.media.slice(0, 4).map((m, i) => {
            const ratio = m.width && m.height ? `${m.width} / ${m.height}` : undefined // keeps tall media tall and wide media wide
            // Bluesky posts stored before the stream address was kept: it sits beside the thumbnail.
            const videoUrl = m.videoUrl ?? (net === 'bsky' && m.type === 'video' ? m.url.replace(/\/thumbnail\.jpg$/, '/playlist.m3u8') : undefined)
            return videoUrl && videoUrl !== m.url ? (
              <Video key={i} src={videoUrl} poster={m.url} ratio={ratio} where={networkName(net)} onOpen={openOnX} />
            ) : m.type === 'video' ? (
              <div key={i} className="video-ext" onClick={openOnX} title={`Watch on ${networkName(net)}`}>
                <img src={m.url} alt="" loading="lazy" style={ratio ? { aspectRatio: ratio } : undefined} />
                <span className="play">▶</span>
              </div>
            ) : (
              <img key={i} src={m.url} alt="" loading="lazy" style={ratio ? { aspectRatio: ratio } : undefined} title="View larger" onClick={(e) => { e.stopPropagation(); openImages(photos, photos.indexOf(m.url)) }} />
            )
          })}
        </div>
      ) : null}
      {tweet.communityNote ? (
        <div className="community-note" onClick={(e) => e.stopPropagation()}>
          <div className="community-note-title">Readers added context</div>
          <div className="community-note-text"><Linkified text={tweet.communityNote.text} /></div>
          {tweet.communityNote.url ? <button className="link small" onClick={() => void window.api.openExternal(tweet.communityNote!.url!)}>Read the note on X</button> : null}
        </div>
      ) : null}
      {tweet.card ? <CardView card={tweet.card} /> : null}
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
  const vote = useSharedVote(item.tweet.id, item.vote)
  const [quoting, setQuoting] = useState(false)
  // A voted post folds to one line so the edition reads as a to-do list; it can be opened again, and folds afresh on the next vote.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [vote])
  const collapsed = vote !== 0 && !expanded

  void editionId // the vote path finds the post's edition itself
  const cat = item.category
  /** Clicking the card itself opens the post with what it replies to and the replies under it. Links, buttons, and media keep their own behaviour. */
  const openCard = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('a, button, video, img, .composer')) return
    onOpenThread(item.tweet.id)
  }
  if (collapsed) {
    const text = item.tweet.text.replace(/\s+/g, ' ').trim()
    return (
      <article className={'card collapsed clickable' + (vote === -1 ? ' downvoted' : '')} onClick={() => setExpanded(true)} title="Show this post again">
        <span className="rank">#{item.rank}</span>
        <span className={'vote-mark ' + (vote === 2 ? 'super' : vote === 1 ? 'up' : 'down')}>{vote === 2 ? '★' : vote === 1 ? '▲' : '▼'}</span>
        <span className="who">{item.tweet.author.name}</span>
        <span className="snippet muted">{[...text].slice(0, 90).join('')}{[...text].length > 90 ? '…' : ''}</span>
        <button className="link small" onClick={(e) => { e.stopPropagation(); setExpanded(true) }}>Show</button>
      </article>
    )
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
        <PostActions tweet={item.tweet} onQuote={() => setQuoting((q) => !q)} />
      </div>
      {quoting ? (
        <div className="reply-box">
          <div className="muted small">Quoting @{item.tweet.author.handle}</div>
          <Composer quoteId={item.tweet.id} onDone={() => setQuoting(false)} onCancel={() => setQuoting(false)} />
        </div>
      ) : null}
    </article>
  )
}
