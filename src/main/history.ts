// Your past likes and replies, as training signal for the filter.
// The X data archive gives the full history once; afterwards the official API keeps it current.
// Both become hidden "history" records: a like is an upvote, a reply marks the post replied to.
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { promisify } from 'util'
import type { Tweet } from '@shared/types'
import { getKv, hasPositiveVote, historyCounts, importHistory, setKv, type HistoryRecord } from './db'
import { loadSettings, saveSettings } from './settings'
import { ensureUserId } from './x/actions'
import * as bsky from './bsky/client'
import * as official from './x/official'
import type { RawTweet, RawUser } from './x/official'

const run = promisify(execFile)

/** The newest likes come first in the archive. They carry no date, so they are filed far in the past, behind every real vote. */
const ARCHIVE_EPOCH = Date.UTC(2000, 0, 1)

function placeholderTweet(id: string, text: string, handle: string, createdAt: string): Tweet {
  return {
    id, conversationId: id, text, createdAt,
    author: { id: '', handle, name: handle, avatar: '' },
    likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0, media: [], urls: []
  }
}

// ---------- the archive ----------

/** Reads one data file from the archive, whether it is a zip or an unpacked folder. */
async function archiveFiles(path: string): Promise<{ name: string; read: () => Promise<string> }[]> {
  const wanted = /^(?:.*\/)?data\/(like|tweets?|tweet)(-part\d+)?\.js$/
  const st = await fs.stat(path)
  if (st.isDirectory()) {
    const dir = join(path, 'data')
    const names = await fs.readdir(dir).catch(() => [] as string[])
    return names.filter((n) => wanted.test('data/' + n)).map((n) => ({ name: n, read: () => fs.readFile(join(dir, n), 'utf8') }))
  }
  const { stdout } = await run('/usr/bin/unzip', ['-Z1', path], { maxBuffer: 64 * 1024 * 1024 })
  return stdout
    .split('\n')
    .filter((n) => wanted.test(n))
    .map((n) => ({ name: basename(n), read: async () => (await run('/usr/bin/unzip', ['-p', path, n], { maxBuffer: 1024 * 1024 * 1024 })).stdout }))
}

/** The archive's JS files are `window.YTD.x.part0 = [...]`; the array is what we want. */
function parseYtd(src: string): unknown[] {
  const i = src.indexOf('=')
  if (i < 0) return []
  const v = JSON.parse(src.slice(i + 1)) as unknown
  return Array.isArray(v) ? v : []
}

export async function importArchive(path: string, log: (m: string) => void): Promise<{ likes: number; replies: number }> {
  const me = loadSettings().xHandle.toLowerCase()
  const files = await archiveFiles(path)
  if (!files.length) throw new Error('No like.js or tweets.js found. Pick the archive zip X sent you, or the folder it unpacks to.')
  const records: HistoryRecord[] = []
  let likes = 0
  let replies = 0
  for (const f of files) {
    const rows = parseYtd(await f.read())
    if (f.name.startsWith('like')) {
      rows.forEach((row, i) => {
        const l = (row as { like?: { tweetId?: string; fullText?: string } }).like
        if (!l?.tweetId) return
        likes++
        records.push({
          tweet: placeholderTweet(l.tweetId, l.fullText ?? '', '', new Date(ARCHIVE_EPOCH).toISOString()),
          vote: 1, replied: false, at: new Date(ARCHIVE_EPOCH + (rows.length - i) * 1000).toISOString()
        })
      })
    } else {
      for (const row of rows) {
        const t = (row as { tweet?: { id_str?: string; created_at?: string; in_reply_to_status_id_str?: string; in_reply_to_screen_name?: string } }).tweet
        const parent = t?.in_reply_to_status_id_str
        const handle = t?.in_reply_to_screen_name ?? ''
        if (!parent || !handle || handle.toLowerCase() === me) continue
        replies++
        const at = t?.created_at ? new Date(t.created_at).toISOString() : new Date(ARCHIVE_EPOCH).toISOString()
        records.push({ tweet: placeholderTweet(parent, '', handle, at), vote: 0, replied: true, at })
      }
    }
  }
  importHistory(records)
  saveSettings({ historyImportedAt: new Date().toISOString() })
  log(`history: imported ${likes} likes and ${replies} replies from the archive`)
  return { likes, replies }
}

// ---------- the API, going forward ----------

function toTweet(r: RawTweet, users: Map<string, RawUser>, referenced: Map<string, RawTweet>, depth = 0): Tweet {
  const u = r.author_id ? users.get(r.author_id) : undefined
  const reply = r.referenced_tweets?.find((x) => x.type === 'replied_to')
  const quote = r.referenced_tweets?.find((x) => x.type === 'quoted')
  const quotedRaw = quote && depth === 0 ? referenced.get(quote.id) : undefined
  const parentRaw = reply ? referenced.get(reply.id) : undefined
  const parentAuthor = parentRaw?.author_id ? users.get(parentRaw.author_id) : undefined
  const t: Tweet = {
    id: r.id,
    conversationId: r.conversation_id ?? r.id,
    text: r.text,
    createdAt: r.created_at ?? new Date().toISOString(),
    author: { id: u?.id ?? '', handle: u?.username ?? '', name: u?.name ?? '', avatar: u?.profile_image_url ?? '', verified: u?.verified, followers: u?.public_metrics?.followers_count },
    likes: r.public_metrics?.like_count ?? 0,
    reposts: r.public_metrics?.retweet_count ?? 0,
    replies: r.public_metrics?.reply_count ?? 0,
    quotes: r.public_metrics?.quote_count ?? 0,
    views: r.public_metrics?.impression_count ?? 0,
    media: [],
    urls: (r.entities?.urls ?? []).map((x) => ({ short: x.url, expanded: x.expanded_url ?? x.url, display: x.display_url ?? x.url })),
    lang: r.lang
  }
  if (reply) {
    t.inReplyToId = reply.id
    if (parentAuthor) t.inReplyToHandle = parentAuthor.username
  }
  if (quotedRaw) t.quoted = toTweet(quotedRaw, users, referenced, depth + 1)
  return t
}

/**
 * Pulls recent likes (until one we already know) and recent replies (since the last seen post)
 * from your real account through the API. A few requests a day; capped so it cannot run away.
 */
export async function syncHistory(log: (m: string) => void): Promise<{ likes: number; replies: number }> {
  const s = loadSettings()
  if (!s.hasXApiKeys && !bsky.configured()) throw new Error('Add X API keys or set up Bluesky in Settings first.')
  let likes = 0
  let replies = 0
  if (s.hasXApiKeys) {
    const r = await syncX(log)
    likes += r.likes
    replies += r.replies
  }
  if (bsky.configured()) {
    try {
      const r = await syncBsky(log)
      likes += r.likes
      replies += r.replies
    } catch (e) {
      log('bsky history sync failed: ' + String(e))
      if (!s.hasXApiKeys) throw e
    }
  }
  saveSettings({ lastHistorySyncDate: new Date().toISOString().slice(0, 10) })
  return { likes, replies }
}

/** Bluesky: your likes (the whole history the first time, then until one already known) and the posts you replied to. */
async function syncBsky(log: (m: string) => void): Promise<{ likes: number; replies: number }> {
  const me = loadSettings().bskyHandle.toLowerCase()
  const records: HistoryRecord[] = []
  const now = new Date().toISOString()
  const first = !getKv('bsky_likes_synced')
  let likes = 0
  let cursor: string | undefined
  pages: for (let p = 0; p < (first ? 30 : 3); p++) {
    const page = await bsky.likesPage(cursor)
    for (const t of page.tweets) {
      if (!first && hasPositiveVote(t.id)) break pages
      if (hasPositiveVote(t.id)) continue
      likes++
      // Likes come newest first and carry no date of their own; file them in order, behind every vote cast here.
      records.push({ tweet: t, vote: 1, replied: false, at: first ? new Date(ARCHIVE_EPOCH + 10 ** 9 - records.length * 1000).toISOString() : now })
    }
    cursor = page.cursor
    if (!cursor) break
  }
  setKv('bsky_likes_synced', '1')
  const since = getKv('bsky_replies_since')
  let newest: string | undefined
  let replies = 0
  cursor = undefined
  pages: for (let p = 0; p < (since ? 2 : 10); p++) {
    const page = await bsky.ownPostsPage(cursor)
    for (const { tweet, parent } of page.items) {
      if (since && tweet.createdAt <= since) break pages
      if (!newest || tweet.createdAt > newest) newest = tweet.createdAt
      if (!parent || parent.author.handle.toLowerCase() === me) continue
      replies++
      records.push({ tweet: parent, vote: 0, replied: true, at: tweet.createdAt })
    }
    cursor = page.cursor
    if (!cursor) break
  }
  if (newest) setKv('bsky_replies_since', newest)
  importHistory(records)
  log(`history: synced ${likes} new likes and ${replies} new replies from Bluesky`)
  return { likes, replies }
}

async function syncX(log: (m: string) => void): Promise<{ likes: number; replies: number }> {
  const userId = await ensureUserId()
  const me = loadSettings().xHandle.toLowerCase()
  const records: HistoryRecord[] = []
  const now = new Date().toISOString()

  // Likes: newest first; stop at the first one already recorded, or after 3 pages.
  let token: string | undefined
  let likes = 0
  pages: for (let p = 0; p < 3; p++) {
    const page = await official.likedTweets(userId, token)
    const users = new Map(page.users.map((u) => [u.id, u]))
    const refs = new Map(page.referenced.map((t) => [t.id, t]))
    for (const raw of page.tweets) {
      if (hasPositiveVote(raw.id)) break pages
      likes++
      records.push({ tweet: toTweet(raw, users, refs), vote: 1, replied: false, at: now })
    }
    token = page.next
    if (!token) break
  }

  // Own posts: only the replies, and only since the last sync.
  const since = getKv('history_tweets_since') ?? undefined
  let newest: string | undefined
  let replies = 0
  token = undefined
  for (let p = 0; p < 2; p++) {
    const page = await official.userTweets(userId, since, token)
    const users = new Map(page.users.map((u) => [u.id, u]))
    const refs = new Map(page.referenced.map((t) => [t.id, t]))
    for (const raw of page.tweets) {
      if (!newest || BigInt(raw.id) > BigInt(newest)) newest = raw.id
      const parentId = raw.referenced_tweets?.find((x) => x.type === 'replied_to')?.id
      if (!parentId) continue
      const parentRaw = refs.get(parentId)
      const parent = parentRaw ? toTweet(parentRaw, users, refs) : placeholderTweet(parentId, '', '', raw.created_at ?? now)
      if (!parent.author.handle || parent.author.handle.toLowerCase() === me) continue
      replies++
      records.push({ tweet: parent, vote: 0, replied: true, at: raw.created_at ?? now })
    }
    token = page.next
    if (!token) break
  }
  if (newest) setKv('history_tweets_since', newest)

  importHistory(records)
  log(`history: synced ${likes} new likes and ${replies} new replies from the X API`)
  return { likes, replies }
}

export function historyStatus(): { importedAt: string | null; lastSyncDate: string | null; likes: number; replies: number } {
  const s = loadSettings()
  return { importedAt: s.historyImportedAt, lastSyncDate: s.lastHistorySyncDate, ...historyCounts() }
}
