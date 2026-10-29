import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ReplyNode, Thread, Tweet } from '@shared/types'
import { PostActions, TweetBody, VoteButtons } from './TweetCard'
import Composer from './Composer'
import { networkName, networkOf, postUrl } from '@shared/net'

/** The replies X sent with the post, plus whatever a click on this reply loaded, deeper ones replacing shallower copies. */
function mergeChildren(known: ReplyNode[], loaded: ReplyNode[] | null): ReplyNode[] {
  if (!loaded) return known
  const byId = new Map(known.map((n) => [n.tweet.id, n]))
  for (const n of loaded) byId.set(n.tweet.id, n)
  return [...byId.values()].sort((a, b) => b.tweet.likes - a.tweet.likes)
}

/** One reply. Clicking it loads the replies to it and nests them underneath; clicking again folds them. */
type Compose = { kind: 'reply' | 'quote'; id: string; handle: string }
type OnCompose = (c: Compose | null) => void

/**
 * The replies to one post. A click folds whatever is nested under it, or unfolds it, loading the replies the first time they are wanted.
 * Clicks on controls inside the post are left alone.
 */
function useReplies(id: string, startOpen = false): { open: boolean; loaded: ReplyNode[] | null; loading: boolean; err: string | null; toggle: (e: React.MouseEvent) => void; fold: () => void } {
  const [loaded, setLoaded] = useState<ReplyNode[] | null>(null)
  const [open, setOpen] = useState(startOpen)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setLoaded(null); setOpen(startOpen); setErr(null) }, [id, startOpen])
  useEffect(() => window.api.onThreadUpdated((t) => { if (t.focal.id === id) setLoaded(t.replies) }), [id]) // a refresh, after a reply of yours or a stale copy

  const toggle = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('a, button, video, img, .composer, .quoted')) return // controls keep their own behaviour
    e.stopPropagation() // a nested reply handles its own click; the one around it stays as it is
    void fold()
  }
  const fold = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (loaded || loading) return
    setLoading(true)
    setErr(null)
    try {
      const t = await window.api.getThread(id)
      setLoaded(t.replies)
    } catch (ex) {
      setErr(String(ex))
    }
    setLoading(false)
  }
  return { open, loaded, loading, err, toggle, fold: () => void fold() }
}

function ReplyItem({ node, depth, compose, onReply }: { node: ReplyNode; depth: number; compose: Compose | null; onReply: OnCompose }): React.JSX.Element {
  const { open, loaded, loading, err, toggle, fold } = useReplies(node.tweet.id, node.children.length > 0) // replies that came with the discussion start unfolded

  const children = mergeChildren(node.children, loaded)
  // The author's own follow-ups continue this post at the same level, oldest first; other people's replies nest under it and fold away with a click.
  const self = node.tweet.author.handle.toLowerCase()
  const own = children.filter((n) => n.tweet.author.handle.toLowerCase() === self).sort((a, b) => a.tweet.createdAt.localeCompare(b.tweet.createdAt))
  const others = open ? children.filter((n) => n.tweet.author.handle.toLowerCase() !== self) : []
  const hidden = !open && children.length - own.length // nested replies folded away
  const count = node.tweet.replies
  return (
    <>
    <div className={'reply clickable' + (open ? ' open' : '')} style={{ marginLeft: depth && depth <= 4 ? 22 : 0 }} onClick={toggle} title={open ? 'Fold replies' : 'Show replies to this'}>
      <TweetBody tweet={node.tweet} />
      <div className="actions small">
        <VoteButtons tweet={node.tweet} small />
        <button className="link" onClick={() => onReply({ kind: 'reply', id: node.tweet.id, handle: node.tweet.author.handle })}>Reply</button>
        <PostActions tweet={node.tweet} onQuote={() => onReply({ kind: 'quote', id: node.tweet.id, handle: node.tweet.author.handle })} />
        {count || node.children.length ? (
          <button className="link fold" onClick={(e) => { e.stopPropagation(); fold() }} title={open ? 'Fold the replies under this' : 'Show the replies under this'}>
            {open ? '▾' : '▸'} {count ? `${count} repl${count === 1 ? 'y' : 'ies'}` : 'replies'}{hidden ? ` · ${hidden} folded` : ''}
          </button>
        ) : null}
      </div>
      <ComposeBox compose={compose} id={node.tweet.id} onClose={() => onReply(null)} />
      {loading ? <div className="muted small">Loading replies…</div> : null}
      {err ? <div className="error small">{err}</div> : null}
      {open && loaded && !others.length ? <div className="muted small">No other replies to this one.</div> : null}
      {others.length ? <Replies nodes={others} depth={depth + 1} compose={compose} onReply={onReply} /> : null}
    </div>
    {own.length ? <Replies nodes={own} depth={depth} compose={compose} onReply={onReply} /> : null}
    </>
  )
}

function Replies({ nodes, depth, compose, onReply }: { nodes: ReplyNode[]; depth: number; compose: Compose | null; onReply: OnCompose }): React.JSX.Element {
  return (
    <>
      {nodes.map((n) => (
        <ReplyItem key={n.tweet.id} node={n} depth={depth} compose={compose} onReply={onReply} />
      ))}
    </>
  )
}

/** The one open composer, shown under the post it replies to or quotes. */
function ComposeBox({ compose, id, onClose }: { compose: Compose | null; id: string; onClose: () => void }): React.JSX.Element | null {
  if (!compose || compose.id !== id) return null
  return (
    <div className="reply-box" onClick={(e) => e.stopPropagation()}>
      <div className="muted small">{compose.kind === 'reply' ? 'Replying to' : 'Quoting'} @{compose.handle}</div>
      <Composer key={compose.kind + compose.id} replyToId={compose.kind === 'reply' ? compose.id : undefined} quoteId={compose.kind === 'quote' ? compose.id : undefined} onDone={onClose} onCancel={onClose} />
    </div>
  )
}

/**
 * A post in the thread above the discussion: an earlier post it answers, a part of the author's run, or the post itself.
 * Clicking it loads the replies to it and nests them underneath; the opened post's own replies are the discussion below, so it does not fold.
 */
function ThreadPost({ tweet, className, compact, small, compose, onCompose, extra, elRef, inThread, isFocal }: { tweet: Tweet; className: string; compact?: boolean; small?: boolean; compose: Compose | null; onCompose: OnCompose; extra?: React.ReactNode; elRef?: React.Ref<HTMLDivElement>; inThread: Set<string>; isFocal?: boolean }): React.JSX.Element {
  const { open, loaded, loading, err, toggle, fold } = useReplies(tweet.id)
  const reply = (): void => onCompose({ kind: 'reply', id: tweet.id, handle: tweet.author.handle })
  const replies = open && loaded ? loaded.filter((n) => !inThread.has(n.tweet.id)) : [] // the thread's own next part is already shown in the run
  const count = tweet.replies
  return (
    <div ref={elRef} className={className + (isFocal ? '' : ' clickable' + (open ? ' open' : ''))} onClick={isFocal ? undefined : toggle} title={isFocal ? undefined : open ? 'Fold replies' : 'Show replies to this'}>
      <TweetBody tweet={tweet} compact={compact} />
      <div className={'actions' + (small ? ' small' : '')}>
        <VoteButtons tweet={tweet} small={small} />
        <button className={small ? 'link' : 'secondary'} onClick={reply}>Reply</button>
        <PostActions tweet={tweet} onQuote={() => onCompose({ kind: 'quote', id: tweet.id, handle: tweet.author.handle })} />
        {extra}
        {!isFocal && count ? <button className="link fold" onClick={(e) => { e.stopPropagation(); fold() }} title={open ? 'Fold the replies under this' : 'Show the replies under this'}>{open ? '▾' : '▸'} {count} repl{count === 1 ? 'y' : 'ies'}</button> : null}
      </div>
      <ComposeBox compose={compose} id={tweet.id} onClose={() => onCompose(null)} />
      {loading ? <div className="muted small">Loading replies…</div> : null}
      {err ? <div className="error small">{err}</div> : null}
      {open && loaded && !replies.length ? <div className="muted small">No other replies to this one.</div> : null}
      {replies.length ? <div className="part-replies"><Replies nodes={replies} depth={0} compose={compose} onReply={onCompose} /></div> : null}
    </div>
  )
}

/** Splits a discussion into the author's own thread (their earlier parts, the post, their follow-ups) and everyone else's replies. */
function splitThread(thread: Thread): { before: Tweet[]; context: Tweet[]; after: Tweet[]; discussion: ReplyNode[] } {
  const author = thread.focal.author.handle.toLowerCase()
  const mine = (t: Tweet): boolean => t.author.handle.toLowerCase() === author
  // Ancestors: the author's own run directly above the post is thread; anything above that is context.
  const before: Tweet[] = []
  let i = thread.ancestors.length - 1
  while (i >= 0 && mine(thread.ancestors[i])) before.unshift(thread.ancestors[i--])
  const context = thread.ancestors.slice(0, i + 1)
  // Follow-ups: walk down through the author's earliest self-reply at each step; other replies along the way join the discussion.
  const after: Tweet[] = []
  const discussion: ReplyNode[] = []
  let nodes = thread.replies
  for (;;) {
    const own = nodes.filter((n) => mine(n.tweet)).sort((a, b) => a.tweet.createdAt.localeCompare(b.tweet.createdAt))
    discussion.push(...nodes.filter((n) => n !== own[0]))
    if (!own[0]) break
    after.push(own[0].tweet)
    nodes = own[0].children
  }
  return { before, context, after, discussion }
}

export default function ThreadView({ tweetId, editionId, centerFocal = true, onBack }: { tweetId: string; editionId?: number; centerFocal?: boolean; onBack: () => void }): React.JSX.Element {
  const [thread, setThread] = useState<Thread | null>(null)
  const [focalNow, setFocalNow] = useState<Tweet | null>(null) // the post itself, from the cache, before replies arrive
  const [err, setErr] = useState<string | null>(null)
  const [compose, setCompose] = useState<Compose | null>(null) // the one open composer: a reply to, or a quote of, some post here
  const [discussionOpen, setDiscussionOpen] = useState(true) // the whole discussion folds away under its heading
  const focalEl = useRef<HTMLDivElement>(null)
  const centered = useRef<string | null>(null) // which post was already scrolled into the middle, so a refresh of the discussion leaves the scroll alone

  useEffect(() => {
    let live = true
    setThread(null)
    setFocalNow(null)
    setErr(null)
    if (editionId !== undefined) void window.api.markOpened(editionId, tweetId)
    void window.api.getTweet(tweetId, true).then((t) => { if (live && t) setFocalNow(t) })
    window.api.getThread(tweetId).then((t) => { if (live) setThread(t) }).catch((e) => { if (live) setErr(String(e)) })
    const off = window.api.onThreadUpdated((t) => { if (live && t.focal.id === tweetId) setThread(t) })
    return () => { live = false; off() }
  }, [tweetId, editionId])
  // Once the context above the post is in place, bring the post itself to the middle of the view instead of leaving the oldest post on top.
  useEffect(() => {
    if (!thread || centered.current === tweetId) return
    centered.current = tweetId
    if (centerFocal) focalEl.current?.scrollIntoView({ block: 'center' }) // coming back through history lands where the reader was instead
  }, [thread, tweetId])
  const focal = thread?.focal ?? focalNow
  const parts = thread ? splitThread(thread) : null
  const inThread = new Set<string>([tweetId, ...(thread?.ancestors ?? []).map((t) => t.id), ...(parts?.after ?? []).map((t) => t.id)])
  const isThread = !!parts && parts.before.length + parts.after.length > 0
  const context = parts?.context ?? thread?.ancestors ?? [] // what the post answers, by other people; a reply stays in their column

  return (
    <div className="thread">
      <header className="page-head">
        <button className="link" onClick={onBack}>← Back</button>
      </header>
      {err ? <div className="error">{err}</div> : null}
      {!focal && !err ? (
        <div className="progress"><div className="spinner" /><div>Loading discussion…</div></div>
      ) : null}
      {context.map((t) => (
        <ThreadPost key={t.id} tweet={t} className="ancestor" small compose={compose} onCompose={setCompose} inThread={inThread} />
      ))}
      {isThread ? <h3 className="muted">Thread · {parts!.before.length + parts!.after.length + 1} posts</h3> : null}
      <div className={isThread ? 'thread-run' : context.length ? 'chain' : ''}>
        {parts?.before.map((t) => (
          <ThreadPost key={t.id} tweet={t} className="thread-part" compact small compose={compose} onCompose={setCompose} inThread={inThread} />
        ))}
        {focal ? (
          <ThreadPost
            tweet={focal}
            elRef={focalEl}
            isFocal
            inThread={inThread}
            className={'focal' + (isThread ? ' thread-part' : '')}
            compose={compose}
            onCompose={setCompose}
            extra={<button className="link" onClick={() => void window.api.openExternal(postUrl(focal))}>Open on {networkName(networkOf(focal))}</button>}
          />
        ) : null}
        {parts?.after.map((t) => (
          <ThreadPost key={t.id} tweet={t} className="thread-part" compact small compose={compose} onCompose={setCompose} inThread={inThread} />
        ))}
      </div>
      {focal && !thread && !err ? (
        <div className="progress"><div className="spinner" /><div>Loading replies…</div></div>
      ) : null}
      {thread ? (
        <>
          {parts!.discussion.length ? (
            <h3 className="muted clickable" onClick={() => setDiscussionOpen((o) => !o)} title={discussionOpen ? 'Fold the discussion' : 'Unfold the discussion'}>
              {discussionOpen ? '▾' : '▸'} Discussion{discussionOpen ? '' : ` · ${parts!.discussion.length} folded`}
            </h3>
          ) : <h3 className="muted">No replies loaded</h3>}
          {discussionOpen ? <Replies nodes={parts!.discussion} depth={0} compose={compose} onReply={setCompose} /> : null}
        </>
      ) : null}
    </div>
  )
}
