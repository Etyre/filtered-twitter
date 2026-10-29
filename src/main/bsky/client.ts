// Bluesky, through the AT Protocol API with your own account: there is no separate browsing
// account here, because reading is an ordinary, permitted use of the API.
import { AtpAgent, RichText, AppBskyFeedDefs, type AppBskyNotificationListNotifications, type AtpSessionData } from '@atproto/api'
import type { Thread, Tweet } from '@shared/types'
import { getTweet, upsertTweets } from '../db'
import { loadSettings, readSecret, saveSettings, writeSecrets } from '../settings'
import { feedItemToTweet, postToTweet } from './parse'

const SERVICE = 'https://bsky.social'

/** Bluesky is switched on, with a handle and an app password to log in with. */
export function configured(): boolean {
  const s = loadSettings()
  return s.bskyEnabled && !!s.bskyHandle && s.hasBskyPassword
}

let agent: AtpAgent | null = null
let connecting: Promise<AtpAgent> | null = null

/** Forget the live session, after the password or handle changed. */
export function reset(): void {
  agent = null
  connecting = null
  writeSecrets({ bskySession: '' })
}

function newAgent(): AtpAgent {
  return new AtpAgent({
    service: SERVICE,
    persistSession: (_evt, sess) => {
      if (sess) writeSecrets({ bskySession: JSON.stringify(sess) })
    }
  })
}

/** A logged-in agent: the stored session when it still works, otherwise a fresh login. */
export function getAgent(): Promise<AtpAgent> {
  if (agent) return Promise.resolve(agent)
  if (connecting) return connecting
  connecting = (async () => {
    const s = loadSettings()
    const password = readSecret('bskyAppPassword')
    if (!s.bskyHandle || !password) throw new Error('Bluesky is not set up (Settings → Bluesky).')
    const a = newAgent()
    const stored = readSecret('bskySession')
    if (stored) {
      try {
        await a.resumeSession(JSON.parse(stored) as AtpSessionData)
      } catch {
        /* expired; log in below */
      }
    }
    if (!a.hasSession) {
      try {
        await a.login({ identifier: s.bskyHandle, password })
      } catch (e) {
        throw new Error('Bluesky login failed: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    if (a.session && (a.session.did !== s.bskyDid || a.session.handle !== s.bskyHandle)) saveSettings({ bskyDid: a.session.did, bskyHandle: a.session.handle })
    agent = a
    return a
  })().finally(() => {
    connecting = null
  })
  return connecting
}

export async function verify(): Promise<{ did: string; handle: string }> {
  agent = null
  const a = await getAgent()
  return { did: a.session!.did, handle: a.session!.handle }
}

// ----- reading -----

/** The following feed, newest first, until posts are older than the cutoff or the pages run out. */
export async function timeline(pages: number, cutoff: Date): Promise<Tweet[]> {
  const a = await getAgent()
  const out: Tweet[] = []
  let cursor: string | undefined
  for (let p = 0; p < pages; p++) {
    const r = await a.getTimeline({ limit: 100, cursor })
    let old = 0
    for (const item of r.data.feed) {
      const t = feedItemToTweet(item)
      if (new Date(t.createdAt) < cutoff) old++
      else out.push(t)
    }
    cursor = r.data.cursor
    if (!cursor || old > r.data.feed.length / 2) break
  }
  return out
}

/** One account's posts and threads since the cutoff. */
export async function authorFeed(actor: string, cutoff: Date, maxPages = 3): Promise<Tweet[]> {
  const a = await getAgent()
  const out: Tweet[] = []
  let cursor: string | undefined
  for (let p = 0; p < maxPages; p++) {
    const r = await a.getAuthorFeed({ actor, limit: 50, cursor, filter: 'posts_and_author_threads' })
    let old = false
    for (const item of r.data.feed) {
      const t = feedItemToTweet(item)
      if (new Date(t.createdAt) < cutoff) {
        if (!t.retweetedBy) old = true // reposts carry the original's date; keep reading past them
        continue
      }
      out.push(t)
    }
    cursor = r.data.cursor
    if (!cursor || old) break
  }
  return out
}

export async function search(q: string, since: Date, limit = 50): Promise<Tweet[]> {
  const a = await getAgent()
  const r = await a.app.bsky.feed.searchPosts({ q, limit: Math.min(100, limit), sort: 'top', since: since.toISOString() })
  return r.data.posts.map(postToTweet)
}

/** Full post views for up to any number of URIs, 25 per request. */
export async function posts(uris: string[]): Promise<Tweet[]> {
  const a = await getAgent()
  const out: Tweet[] = []
  for (let i = 0; i < uris.length; i += 25) {
    const r = await a.getPosts({ uris: uris.slice(i, i + 25) })
    out.push(...r.data.posts.map(postToTweet))
  }
  return out
}

/** Follower counts for a set of accounts (25 per request), so the heuristic can normalize engagement. */
export async function followerCounts(dids: string[], maxRequests = 40): Promise<Map<string, number>> {
  const a = await getAgent()
  const out = new Map<string, number>()
  const unique = [...new Set(dids)]
  for (let i = 0; i < unique.length && i / 25 < maxRequests; i += 25) {
    try {
      const r = await a.getProfiles({ actors: unique.slice(i, i + 25) })
      for (const p of r.data.profiles) out.set(p.did, p.followersCount ?? 0)
    } catch {
      /* a missing count only costs a little accuracy */
    }
  }
  return out
}

/** The discussion around a post: its ancestors up to the root and the replies under it. */
export async function thread(uri: string): Promise<Thread> {
  const a = await getAgent()
  const r = await a.getPostThread({ uri, depth: 6, parentHeight: 40 })
  const node = r.data.thread
  if (!AppBskyFeedDefs.isThreadViewPost(node)) throw new Error('Could not load that post. It may be deleted or blocked.')
  const all: Tweet[] = []
  const focal = postToTweet(node.post)
  all.push(focal)
  const ancestors: Tweet[] = []
  let up = node.parent
  let child: Tweet = focal
  while (up && AppBskyFeedDefs.isThreadViewPost(up)) {
    const t = postToTweet(up.post)
    child.inReplyToId = t.id
    child.inReplyToHandle = t.author.handle
    ancestors.unshift(t)
    all.push(t)
    child = t
    up = up.parent
  }
  const build = (n: AppBskyFeedDefs.ThreadViewPost, parent: Tweet, depth: number): Thread['replies'] => {
    if (depth > 6) return []
    const kids = (n.replies ?? []).filter(AppBskyFeedDefs.isThreadViewPost)
    return kids
      .map((k) => {
        const t = postToTweet(k.post)
        t.inReplyToId = parent.id
        t.inReplyToHandle = parent.author.handle
        all.push(t)
        return { tweet: t, children: build(k, t, depth + 1) }
      })
      .sort((x, y) => y.tweet.likes - x.tweet.likes)
  }
  const replies = build(node, focal, 0)
  upsertTweets(all)
  return { focal, ancestors, replies }
}

// ----- writing -----

async function ref(uri: string): Promise<{ uri: string; cid: string; rootUri?: string; rootCid?: string }> {
  const known = getTweet(uri)
  const a = await getAgent()
  const r = await a.getPosts({ uris: [uri] })
  const p = r.data.posts[0]
  if (!p) {
    if (known?.cid) return { uri, cid: known.cid }
    throw new Error('That post could not be found on Bluesky.')
  }
  const reply = (p.record as { reply?: { root?: { uri: string; cid: string } } }).reply
  return { uri: p.uri, cid: p.cid, rootUri: reply?.root?.uri, rootCid: reply?.root?.cid }
}

export async function like(uri: string): Promise<void> {
  const a = await getAgent()
  const r = await ref(uri)
  await a.like(r.uri, r.cid)
}

export async function repost(uri: string): Promise<void> {
  const a = await getAgent()
  const r = await ref(uri)
  await a.repost(r.uri, r.cid)
}

/** Takes back your repost: the post's view carries the repost record's URI when you have one. */
export async function unrepost(uri: string): Promise<void> {
  const a = await getAgent()
  const r = await a.getPosts({ uris: [uri] })
  const repostUri = r.data.posts[0]?.viewer?.repost
  if (!repostUri) return // nothing to undo
  await a.deleteRepost(repostUri)
}

/** Posts a thread; the first post may answer one post and/or quote another. Links and mentions become facets. */
export async function postThread(texts: string[], replyToId?: string, quoteId?: string): Promise<string[]> {
  const a = await getAgent()
  const ids: string[] = []
  let parent: { uri: string; cid: string } | undefined
  let root: { uri: string; cid: string } | undefined
  if (replyToId) {
    const r = await ref(replyToId)
    parent = { uri: r.uri, cid: r.cid }
    root = r.rootUri && r.rootCid ? { uri: r.rootUri, cid: r.rootCid } : parent
  }
  let embed: { $type: 'app.bsky.embed.record'; record: { uri: string; cid: string } } | undefined
  if (quoteId) {
    const q = await ref(quoteId)
    embed = { $type: 'app.bsky.embed.record', record: { uri: q.uri, cid: q.cid } }
  }
  for (const text of texts) {
    const rt = new RichText({ text })
    await rt.detectFacets(a)
    const res = await a.post({
      text: rt.text,
      facets: rt.facets,
      langs: ['en'],
      reply: parent && root ? { root, parent } : undefined,
      embed: ids.length === 0 ? embed : undefined,
      createdAt: new Date().toISOString()
    })
    ids.push(res.uri)
    parent = { uri: res.uri, cid: res.cid }
    if (!root) root = parent
  }
  return ids
}

// ----- notifications and history -----

export type BskyNotification = AppBskyNotificationListNotifications.Notification

/** Replies, mentions and quotes of your posts, with the posts themselves. */
export async function notifications(limit = 50): Promise<{ n: BskyNotification; tweet: Tweet }[]> {
  const a = await getAgent()
  const r = await a.listNotifications({ limit })
  const wanted = r.data.notifications.filter((n) => n.reason === 'reply' || n.reason === 'mention' || n.reason === 'quote')
  const tweets = new Map((await posts(wanted.map((n) => n.uri))).map((t) => [t.id, t]))
  return wanted.flatMap((n) => {
    const t = tweets.get(n.uri)
    return t ? [{ n, tweet: t }] : []
  })
}

/** Your own likes, newest first, one page at a time. */
export async function likesPage(cursor?: string): Promise<{ tweets: Tweet[]; cursor?: string }> {
  const a = await getAgent()
  const r = await a.getActorLikes({ actor: a.session!.did, limit: 100, cursor })
  return { tweets: r.data.feed.map(feedItemToTweet), cursor: r.data.cursor }
}

/** Your own posts and replies, newest first, with the post each one answers when the feed carries it. */
export async function ownPostsPage(cursor?: string): Promise<{ items: { tweet: Tweet; parent?: Tweet }[]; cursor?: string }> {
  const a = await getAgent()
  const r = await a.getAuthorFeed({ actor: a.session!.did, limit: 100, cursor, filter: 'posts_with_replies' })
  const items = r.data.feed
    .filter((it) => !it.reason)
    .map((it) => {
      const parent = it.reply?.parent
      return { tweet: feedItemToTweet(it), parent: parent && AppBskyFeedDefs.isPostView(parent) ? postToTweet(parent) : undefined }
    })
  return { items, cursor: r.data.cursor }
}
