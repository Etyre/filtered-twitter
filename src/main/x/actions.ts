// Likes, reposts and posts on your real accounts, through the official APIs. The one exception:
// replies and quotes X's self-serve API refuses go through your own web session, if you logged it in.
// A post's id says which network it is on: Bluesky posts carry an at:// URI.
import type { PostNetwork, PostResult } from '@shared/types'
import { isBskyId } from '@shared/net'
import { setReplied, setTweetLiked, setTweetReposted } from '../db'
import { loadSettings, saveSettings } from '../settings'
import * as bsky from '../bsky/client'
import * as official from './official'
import type { XBrowser } from './browser'

let web: XBrowser | null = null
/** The hidden browser holding your own account's web session. */
export function setWebBrowser(b: XBrowser): void {
  web = b
}

const errMsg = (e: unknown): string => String(e instanceof Error ? e.message : e)

/** Since February 2026 the self-serve API tiers reply to or quote only posts whose author mentioned you. This is that refusal, or no keys at all. */
export function apiRefused(e: unknown): boolean {
  if (e instanceof official.XApiError) return e.status === 403 && /mentioned|author|not allowed|conversation/i.test(e.message)
  return /not configured/.test(errMsg(e))
}

export async function ensureUserId(): Promise<string> {
  const s = loadSettings()
  if (s.xUserId) return s.xUserId
  const m = await official.me()
  saveSettings({ xUserId: m.id, xHandle: m.username })
  return m.id
}

export async function like(tweetId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (isBskyId(tweetId)) await bsky.like(tweetId)
    else await official.like(await ensureUserId(), tweetId)
    setTweetLiked(tweetId, true)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

export async function repost(tweetId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (isBskyId(tweetId)) await bsky.repost(tweetId)
    else await official.retweet(await ensureUserId(), tweetId)
    setTweetReposted(tweetId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

export async function unrepost(tweetId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (isBskyId(tweetId)) await bsky.unrepost(tweetId)
    else await official.unretweet(await ensureUserId(), tweetId)
    setTweetReposted(tweetId, false)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

/** Posts a thread; the first post may reply to one post and/or quote another. A reply or quote goes where that post is; a fresh post goes where asked, or to both. */
export async function postThread(texts: string[], replyToId?: string, quoteId?: string, network: PostNetwork = 'x'): Promise<PostResult> {
  const anchor = replyToId ?? quoteId
  const where: PostNetwork = anchor ? (isBskyId(anchor) ? 'bsky' : 'x') : network
  if (where === 'both') {
    const x = await postThread(texts, undefined, undefined, 'x')
    const b = await postThread(texts, undefined, undefined, 'bsky')
    const ids = [...x.ids, ...b.ids]
    if (!x.ok || !b.ok) return { ok: false, ids, error: [x.ok ? '' : `X: ${x.error}`, b.ok ? '' : `Bluesky: ${b.error}`].filter(Boolean).join(' ') }
    return { ok: true, ids }
  }
  if (where === 'bsky') {
    try {
      const ids = await bsky.postThread(texts, replyToId, quoteId)
      if (replyToId) setReplied(replyToId)
      return { ok: true, ids }
    } catch (e) {
      return { ok: false, ids: [], error: String(e instanceof Error ? e.message : e) }
    }
  }
  const ids: string[] = []
  let parent = replyToId
  let via: PostResult['via'] = 'api'
  for (const text of texts) {
    const quote = ids.length === 0 ? quoteId : undefined
    try {
      ids.push(await official.createPost(text, parent, quote))
    } catch (e) {
      if (!apiRefused(e)) return { ok: false, ids, error: errMsg(e) }
      if (!web || !(await web.isLoggedIn())) return { ok: false, ids, error: errMsg(e), needsWebLogin: true }
      try {
        ids.push(await web.postViaWeb(text, parent, quote)) // later parts answer your own post, which the API allows
        via = 'web'
      } catch (e2) {
        return { ok: false, ids, error: `${errMsg(e)} Posting through your web session failed too: ${errMsg(e2)}` }
      }
    }
    parent = ids[ids.length - 1]
  }
  if (replyToId) setReplied(replyToId)
  return { ok: true, ids, via }
}
