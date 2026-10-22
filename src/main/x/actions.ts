// Likes, reposts and posts on your real account, through the official API only.
import type { PostResult } from '@shared/types'
import { setReplied, setTweetLiked } from '../db'
import { loadSettings, saveSettings } from '../settings'
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
    await official.like(await ensureUserId(), tweetId)
    setTweetLiked(tweetId, true)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

export async function repost(tweetId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await official.retweet(await ensureUserId(), tweetId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

export async function postThread(texts: string[], replyToId?: string): Promise<PostResult> {
  const ids: string[] = []
  let parent = replyToId
  for (const text of texts) {
    try {
      const id = await official.createPost(text, parent)
      ids.push(id)
      parent = id
    } catch (e) {
      return { ok: false, ids, error: String(e instanceof Error ? e.message : e) }
    }
  }
  if (replyToId) setReplied(replyToId)
  return { ok: true, ids }
}
