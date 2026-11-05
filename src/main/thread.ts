import type { ReplyNode, Thread, Tweet } from '@shared/types'
import { getCachedThread, getTweet, setCachedThread, upsertTweets } from './db'
import type { XBrowser } from './x/browser'
import { isBskyId } from '@shared/net'
import * as bsky from './bsky/client'
import { autoTranslateOn, translateTweets } from './translate'

const inFlight = new Map<string, Promise<Thread>>()

let notify: ((t: Thread) => void) | null = null
/** Who to tell when a stored discussion changes after it was handed out (its translations arriving, say). */
export function setThreadNotifier(fn: (t: Thread) => void): void {
  notify = fn
}

/** Every post in a discussion: the post, what it answers, and the replies at every depth. */
function allTweets(t: Thread): Tweet[] {
  const out: Tweet[] = [t.focal, ...t.ancestors]
  const walk = (nodes: ReplyNode[]): void => nodes.forEach((n) => { out.push(n.tweet); walk(n.children) })
  walk(t.replies)
  return out
}

/** Translates the non-English posts of a discussion in the background, then stores and announces the updated copy. */
function translateThread(id: string, t: Thread, log: (m: string) => void): void {
  if (!autoTranslateOn()) return
  void translateTweets(allTweets(t), log)
    .then((n) => {
      if (!n) return
      setCachedThread(id, t)
      notify?.(t)
    })
    .catch((e) => log(`thread translate ${id} failed: ${String(e)}`))
}

/** Loads a discussion from X or Bluesky, one load per post at a time, and stores it. Translations, when wanted, follow on their own. */
export function loadThread(browser: XBrowser, tweetId: string, log: (m: string) => void = () => {}): Promise<Thread> {
  let p = inFlight.get(tweetId)
  if (!p) {
    p = (isBskyId(tweetId) ? bsky.thread(tweetId) : fetchThread(browser, tweetId))
      .then((t) => {
        setCachedThread(tweetId, t)
        translateThread(tweetId, t, log)
        return t
      })
      .finally(() => inFlight.delete(tweetId))
    inFlight.set(tweetId, p)
  }
  return p
}

let prefetchRun = 0
/** Loads discussions ahead of time, in order, skipping any fetched in the last six hours. A newer run cancels an older one. */
export async function prefetchThreads(browser: XBrowser, tweetIds: string[], log: (m: string) => void): Promise<void> {
  const run = ++prefetchRun
  let done = 0
  for (const id of tweetIds) {
    if (run !== prefetchRun) return
    const hit = getCachedThread(id)
    if (hit && Date.now() - new Date(hit.fetchedAt).getTime() < 6 * 3600_000) continue
    try {
      await loadThread(browser, id, log)
      done++
    } catch (e) {
      log(`prefetch ${id} failed: ${String(e)}`)
    }
  }
  if (done) log(`prefetched ${done} discussions`)
}

async function fetchThread(browser: XBrowser, tweetId: string): Promise<Thread> {
  const tweets = await browser.tweetDetail(tweetId)
  upsertTweets(tweets)
  const byId = new Map<string, Tweet>()
  tweets.forEach((t) => byId.set(t.id, t))
  const focal = byId.get(tweetId) ?? getTweet(tweetId)
  if (!focal) throw new Error('Could not load that post. It may be deleted or protected.')
  // ancestors: walk up the reply chain
  const ancestors: Tweet[] = []
  let cur = focal
  const guard = new Set<string>()
  while (cur.inReplyToId && byId.has(cur.inReplyToId) && !guard.has(cur.inReplyToId)) {
    guard.add(cur.inReplyToId)
    cur = byId.get(cur.inReplyToId)!
    ancestors.unshift(cur)
  }
  // replies tree
  const children = new Map<string, Tweet[]>()
  for (const t of tweets) {
    if (!t.inReplyToId || t.id === tweetId) continue
    if (ancestors.some((a) => a.id === t.id)) continue
    const arr = children.get(t.inReplyToId) ?? []
    arr.push(t)
    children.set(t.inReplyToId, arr)
  }
  // Other people's replies nest at most seven deep; the author's own run is followed to its end, however long
  // the thread, since each part is a reply to the one before and the view shows them as one run.
  const author = focal.author.handle.toLowerCase()
  const build = (id: string, depth: number): ReplyNode[] => {
    const kids = (children.get(id) ?? []).sort((a, b) => b.likes - a.likes)
    return kids
      .filter((t) => depth <= 6 || t.author.handle.toLowerCase() === author)
      .map((t) => ({ tweet: t, children: build(t.id, depth + 1) }))
  }
  return { focal, ancestors, replies: build(tweetId, 0) }
}
