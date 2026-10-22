import type { ReplyNode, Thread, Tweet } from '@shared/types'
import { getCachedThread, getTweet, setCachedThread, upsertTweets } from './db'
import type { XBrowser } from './x/browser'

const inFlight = new Map<string, Promise<Thread>>()

/** Loads a discussion from X, one load per post at a time, and stores it. */
export function loadThread(browser: XBrowser, tweetId: string): Promise<Thread> {
  let p = inFlight.get(tweetId)
  if (!p) {
    p = fetchThread(browser, tweetId)
      .then((t) => {
        setCachedThread(tweetId, t)
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
      await loadThread(browser, id)
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
  const build = (id: string, depth: number): ReplyNode[] => {
    if (depth > 6) return []
    const kids = (children.get(id) ?? []).sort((a, b) => b.likes - a.likes)
    return kids.map((t) => ({ tweet: t, children: build(t.id, depth + 1) }))
  }
  return { focal, ancestors, replies: build(tweetId, 0) }
}
