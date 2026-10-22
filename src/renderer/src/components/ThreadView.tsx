import type React from 'react'
import { useEffect, useState } from 'react'
import type { ReplyNode, Thread, Tweet } from '@shared/types'
import { TweetBody, VoteButtons } from './TweetCard'
import Composer from './Composer'

/** The replies X sent with the post, plus whatever a click on this reply loaded, deeper ones replacing shallower copies. */
function mergeChildren(known: ReplyNode[], loaded: ReplyNode[] | null): ReplyNode[] {
  if (!loaded) return known
  const byId = new Map(known.map((n) => [n.tweet.id, n]))
  for (const n of loaded) byId.set(n.tweet.id, n)
  return [...byId.values()].sort((a, b) => b.tweet.likes - a.tweet.likes)
}

/** One reply. Clicking it loads the replies to it and nests them underneath; clicking again folds them. */
function ReplyItem({ node, depth, onReply }: { node: ReplyNode; depth: number; onReply: (id: string, handle: string) => void }): React.JSX.Element {
  const [loaded, setLoaded] = useState<ReplyNode[] | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const toggle = async (e: React.MouseEvent): Promise<void> => {
    if ((e.target as HTMLElement).closest('a, button, video, img')) return // controls keep their own behaviour
    e.stopPropagation() // a nested reply handles its own click; the one around it stays as it is
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (loaded || loading) return
    setLoading(true)
    setErr(null)
    try {
      const t = await window.api.getThread(node.tweet.id)
      setLoaded(t.replies)
    } catch (ex) {
      setErr(String(ex))
    }
    setLoading(false)
  }

  const children = open ? mergeChildren(node.children, loaded) : node.children
  const count = node.tweet.replies
  return (
    <div className={'reply clickable' + (open ? ' open' : '')} style={{ marginLeft: Math.min(depth, 4) * 22 }} onClick={(e) => void toggle(e)} title={open ? 'Fold replies' : 'Show replies to this'}>
      <TweetBody tweet={node.tweet} />
      <div className="actions small">
        <VoteButtons tweet={node.tweet} small />
        <button className="link" onClick={() => onReply(node.tweet.id, node.tweet.author.handle)}>Reply</button>
        {count || node.children.length ? <span className="muted">{open ? '▾' : '▸'} {count ? `${count} repl${count === 1 ? 'y' : 'ies'}` : 'replies'}</span> : null}
      </div>
      {loading ? <div className="muted small">Loading replies…</div> : null}
      {err ? <div className="error small">{err}</div> : null}
      {open && loaded && !children.length ? <div className="muted small">No replies to this one.</div> : null}
      {children.length ? <Replies nodes={children} depth={depth + 1} onReply={onReply} /> : null}
    </div>
  )
}

function Replies({ nodes, depth, onReply }: { nodes: ReplyNode[]; depth: number; onReply: (id: string, handle: string) => void }): React.JSX.Element {
  return (
    <>
      {nodes.map((n) => (
        <ReplyItem key={n.tweet.id} node={n} depth={depth} onReply={onReply} />
      ))}
    </>
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

export default function ThreadView({ tweetId, editionId, onBack }: { tweetId: string; editionId?: number; onBack: () => void }): React.JSX.Element {
  const [thread, setThread] = useState<Thread | null>(null)
  const [focalNow, setFocalNow] = useState<Tweet | null>(null) // the post itself, from the cache, before replies arrive
  const [err, setErr] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<{ id: string; handle: string } | null>(null)

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
  const focal = thread?.focal ?? focalNow
  const parts = thread ? splitThread(thread) : null
  const isThread = !!parts && parts.before.length + parts.after.length > 0

  return (
    <div className="thread">
      <header className="page-head">
        <button className="link" onClick={onBack}>← Back</button>
      </header>
      {err ? <div className="error">{err}</div> : null}
      {!focal && !err ? (
        <div className="progress"><div className="spinner" /><div>Loading discussion…</div></div>
      ) : null}
      {(parts?.context ?? thread?.ancestors ?? []).map((t) => (
        <div key={t.id} className="ancestor"><TweetBody tweet={t} /></div>
      ))}
      {isThread ? <h3 className="muted">Thread · {parts!.before.length + parts!.after.length + 1} posts</h3> : null}
      <div className={isThread ? 'thread-run' : ''}>
        {parts?.before.map((t) => (
          <div key={t.id} className="thread-part"><TweetBody tweet={t} compact /></div>
        ))}
        {focal ? (
          <div className={'focal' + (isThread ? ' thread-part' : '')}>
            <TweetBody tweet={focal} />
            <div className="actions">
              <VoteButtons tweet={focal} />
              <button className="secondary" onClick={() => setReplyTo({ id: focal.id, handle: focal.author.handle })}>Reply</button>
              <button className="link" onClick={() => void window.api.openExternal(`https://x.com/${focal.author.handle}/status/${focal.id}`)}>Open on X</button>
            </div>
          </div>
        ) : null}
        {parts?.after.map((t) => (
          <div key={t.id} className="thread-part">
            <TweetBody tweet={t} compact />
            <div className="actions small"><VoteButtons tweet={t} small /><button className="link" onClick={() => setReplyTo({ id: t.id, handle: t.author.handle })}>Reply</button></div>
          </div>
        ))}
      </div>
      {focal && !thread && !err ? (
        <div className="progress"><div className="spinner" /><div>Loading replies…</div></div>
      ) : null}
      {thread ? (
        <>
          {replyTo ? (
            <div className="reply-box">
              <div className="muted small">Replying to @{replyTo.handle}</div>
              <Composer replyToId={replyTo.id} onDone={() => setReplyTo(null)} onCancel={() => setReplyTo(null)} />
            </div>
          ) : null}
          <h3 className="muted">{parts!.discussion.length ? 'Discussion' : 'No replies loaded'}</h3>
          <Replies nodes={parts!.discussion} depth={0} onReply={(id, handle) => setReplyTo({ id, handle })} />
        </>
      ) : null}
    </div>
  )
}
