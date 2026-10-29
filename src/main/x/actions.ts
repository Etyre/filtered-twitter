// Likes, reposts and posts on your real accounts, through the official APIs only.
// A post's id says which network it is on: Bluesky posts carry an at:// URI.
import type { PostNetwork, PostResult } from '@shared/types'
import { isBskyId } from '@shared/net'
import { setReplied, setTweetLiked, setTweetReposted } from '../db'
import { loadSettings, saveSettings } from '../settings'
import * as bsky from '../bsky/client'
import * as official from './official'

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
  for (const text of texts) {
    try {
      const id = await official.createPost(text, parent, ids.length === 0 ? quoteId : undefined)
      ids.push(id)
      parent = id
    } catch (e) {
      return { ok: false, ids, error: String(e instanceof Error ? e.message : e) }
    }
  }
  if (replyToId) setReplied(replyToId)
  return { ok: true, ids }
}
