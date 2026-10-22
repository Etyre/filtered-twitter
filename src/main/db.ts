import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import type { Edition, EditionItem, EditionSummary, Notification, ScoredTweet, Thread, Tweet } from '@shared/types'

let db: Database.Database

export function openDb(): Database.Database {
  if (db) return db
  const file = join(app.getPath('userData'), 'filtered-twitter.sqlite')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      author_handle TEXT NOT NULL,
      created_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tweets_created ON tweets(created_at);
    CREATE TABLE IF NOT EXISTS editions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      built_at TEXT NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      priority_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS edition_items (
      edition_id INTEGER NOT NULL,
      tweet_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      source TEXT NOT NULL,
      heuristic REAL NOT NULL,
      claude REAL,
      final REAL NOT NULL,
      category TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      vote INTEGER NOT NULL DEFAULT 0,
      voted_at TEXT,
      opened INTEGER NOT NULL DEFAULT 0,
      replied INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (edition_id, tweet_id)
    );
    CREATE TABLE IF NOT EXISTS candidates (
      edition_id INTEGER NOT NULL,
      tweet_id TEXT NOT NULL,
      source TEXT NOT NULL,
      heuristic REAL NOT NULL,
      claude REAL,
      final REAL NOT NULL,
      PRIMARY KEY (edition_id, tweet_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS threads (focal_id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
  `)
  return db
}

// ---------- settings / kv ----------
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}
export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}
export function getSecretBlob(key: string): Buffer | null {
  const row = db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: Buffer } | undefined
  return row ? row.value : null
}
export function setSecretBlob(key: string, value: Buffer | null): void {
  if (value === null) db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
  else db.prepare('INSERT INTO secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}
export function getKv(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}
export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}

// ---------- tweets ----------
export function upsertTweet(t: Tweet): void {
  db.prepare(
    `INSERT INTO tweets(id,json,author_handle,created_at,fetched_at) VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at`
  ).run(t.id, JSON.stringify(t), t.author.handle.toLowerCase(), t.createdAt, new Date().toISOString())
}
export function upsertTweets(ts: Tweet[]): void {
  const tx = db.transaction((rows: Tweet[]) => {
    for (const t of rows) {
      upsertTweet(t)
      if (t.quoted) upsertTweet(t.quoted) // so a quoted post opens at once as its own discussion
      if (t.retweetOf) upsertTweet(t.retweetOf)
    }
  })
  tx(ts)
}
// ---------- discussions, kept so reopening one is instant ----------
export function getCachedThread(focalId: string): { thread: Thread; fetchedAt: string } | null {
  const row = db.prepare('SELECT json, fetched_at FROM threads WHERE focal_id = ?').get(focalId) as { json: string; fetched_at: string } | undefined
  return row ? { thread: JSON.parse(row.json) as Thread, fetchedAt: row.fetched_at } : null
}
export function setCachedThread(focalId: string, thread: Thread): void {
  db.prepare('INSERT INTO threads(focal_id, json, fetched_at) VALUES(?,?,?) ON CONFLICT(focal_id) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at').run(
    focalId, JSON.stringify(thread), new Date().toISOString()
  )
}

export function getTweet(id: string): Tweet | null {
  const row = db.prepare('SELECT json FROM tweets WHERE id = ?').get(id) as { json: string } | undefined
  return row ? (JSON.parse(row.json) as Tweet) : null
}
export function setTweetLiked(id: string, liked: boolean): void {
  const t = getTweet(id)
  if (!t) return
  t.liked = liked
  upsertTweet(t)
}

// ---------- editions ----------
export function createEdition(date: string, scored: ScoredTweet[], allCandidates: ScoredTweet[], notes: string): Edition {
  const builtAt = new Date().toISOString()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM editions WHERE date = ?').run(date)
    const info = db
      .prepare('INSERT INTO editions(date,built_at,candidate_count,priority_count,notes) VALUES(?,?,?,?,?)')
      .run(date, builtAt, allCandidates.length, scored.filter((s) => s.priorityAccount).length, notes)
    const id = Number(info.lastInsertRowid)
    db.prepare('DELETE FROM edition_items WHERE edition_id = ?').run(id)
    db.prepare('DELETE FROM candidates WHERE edition_id = ?').run(id)
    const ins = db.prepare(
      `INSERT INTO edition_items(edition_id,tweet_id,rank,source,heuristic,claude,final,category,reason,priority)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    )
    scored.forEach((s, i) => {
      upsertTweet(s.tweet)
      ins.run(id, s.tweet.id, i + 1, s.source, s.heuristicScore, s.claudeScore, s.finalScore, s.category, s.reason, s.priorityAccount ? 1 : 0)
    })
    const insC = db.prepare('INSERT OR REPLACE INTO candidates(edition_id,tweet_id,source,heuristic,claude,final) VALUES(?,?,?,?,?,?)')
    allCandidates.forEach((s) => insC.run(id, s.tweet.id, s.source, s.heuristicScore, s.claudeScore, s.finalScore))
    return id
  })
  const id = tx()
  return getEdition(id)!
}

interface EditionRow { id: number; date: string; built_at: string; candidate_count: number; priority_count: number; notes: string }
interface ItemRow {
  tweet_id: string; rank: number; source: string; heuristic: number; claude: number | null; final: number
  category: string; reason: string; priority: number; vote: number; opened: number; replied: number; json: string
}

function rowToItem(r: ItemRow): EditionItem {
  return {
    tweet: JSON.parse(r.json) as Tweet,
    source: r.source as EditionItem['source'],
    heuristicScore: r.heuristic,
    claudeScore: r.claude,
    finalScore: r.final,
    category: r.category as EditionItem['category'],
    reason: r.reason,
    priorityAccount: !!r.priority,
    rank: r.rank,
    vote: r.vote as 1 | -1 | 0,
    opened: !!r.opened,
    replied: !!r.replied
  }
}

export function getEdition(id: number): Edition | null {
  const e = db.prepare('SELECT * FROM editions WHERE id = ?').get(id) as EditionRow | undefined
  if (!e) return null
  const rows = db
    .prepare('SELECT ei.*, t.json FROM edition_items ei JOIN tweets t ON t.id = ei.tweet_id WHERE edition_id = ? ORDER BY rank')
    .all(id) as ItemRow[]
  return {
    id: e.id, date: e.date, builtAt: e.built_at, candidateCount: e.candidate_count,
    priorityCount: e.priority_count, notes: e.notes, itemCount: rows.length, items: rows.map(rowToItem)
  }
}
export function getEditionByDate(date: string): Edition | null {
  const e = db.prepare('SELECT id FROM editions WHERE date = ?').get(date) as { id: number } | undefined
  return e ? getEdition(e.id) : null
}
export function listEditions(): EditionSummary[] {
  const rows = db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM edition_items ei WHERE ei.edition_id = e.id) AS item_count,
              (SELECT COUNT(*) FROM edition_items ei WHERE ei.edition_id = e.id AND vote != 0) AS votes
       FROM editions e WHERE e.date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' ORDER BY date DESC`
    )
    .all() as (EditionRow & { item_count: number; votes: number })[]
  return rows.map((r) => ({
    id: r.id, date: r.date, builtAt: r.built_at, itemCount: r.item_count,
    candidateCount: r.candidate_count, priorityCount: r.priority_count, votesCast: r.votes
  }))
}
export function setVote(editionId: number, tweetId: string, vote: 1 | -1 | 0): void {
  db.prepare('UPDATE edition_items SET vote = ?, voted_at = ? WHERE edition_id = ? AND tweet_id = ?').run(vote, new Date().toISOString(), editionId, tweetId)
}
export function setOpened(editionId: number, tweetId: string): void {
  db.prepare('UPDATE edition_items SET opened = 1 WHERE edition_id = ? AND tweet_id = ?').run(editionId, tweetId)
}
export function setReplied(tweetId: string): void {
  db.prepare('UPDATE edition_items SET replied = 1 WHERE tweet_id = ?').run(tweetId)
}

/** Everything the user has ever voted on or interacted with, for learning. */
export interface VoteRecord {
  tweet: Tweet
  vote: 1 | -1 | 0
  opened: boolean
  replied: boolean
  heuristic: number
  claude: number | null
  final: number
  source: string
}
export function getVoteHistory(limit = 2000): VoteRecord[] {
  const rows = db
    .prepare(
      `SELECT ei.*, t.json FROM edition_items ei JOIN tweets t ON t.id = ei.tweet_id
       WHERE ei.vote != 0 OR ei.replied = 1 OR ei.opened = 1
       ORDER BY ei.voted_at DESC LIMIT ?`
    )
    .all(limit) as ItemRow[]
  return rows.map((r) => ({
    tweet: JSON.parse(r.json) as Tweet, vote: r.vote as 1 | -1 | 0, opened: !!r.opened, replied: !!r.replied,
    heuristic: r.heuristic, claude: r.claude, final: r.final, source: r.source
  }))
}
export interface ItemDetail {
  editionId: number
  editionDate: string
  vote: 1 | -1 | 0
  opened: boolean
  replied: boolean
  heuristic: number
  claude: number | null
  final: number
  source: string
  tweet: Tweet
}
interface DetailRow extends ItemRow { edition_id: number; date: string; json: string }
const toDetail = (r: DetailRow): ItemDetail => ({
  editionId: r.edition_id, editionDate: r.date, vote: r.vote as 1 | -1 | 0, opened: !!r.opened, replied: !!r.replied,
  heuristic: r.heuristic, claude: r.claude, final: r.final, source: r.source, tweet: JSON.parse(r.json) as Tweet
})
const DETAIL_SQL = 'SELECT ei.*, e.date, t.json FROM edition_items ei JOIN editions e ON e.id = ei.edition_id JOIN tweets t ON t.id = ei.tweet_id'
export function getItem(editionId: number, tweetId: string): ItemDetail | null {
  const r = db.prepare(`${DETAIL_SQL} WHERE ei.edition_id = ? AND ei.tweet_id = ?`).get(editionId, tweetId) as DetailRow | undefined
  return r ? toDetail(r) : null
}
export function getItemsForTweet(tweetId: string): ItemDetail[] {
  return (db.prepare(`${DETAIL_SQL} WHERE ei.tweet_id = ? ORDER BY ei.edition_id DESC`).all(tweetId) as DetailRow[]).map(toDetail)
}
/** Every vote, open, and reply, with the post, for backups. */
export function exportInteractions(): ItemDetail[] {
  return (db.prepare(`${DETAIL_SQL} WHERE ei.vote != 0 OR ei.replied = 1 OR ei.opened = 1 ORDER BY ei.voted_at`).all() as DetailRow[]).map(toDetail)
}
export function countInteractions(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM edition_items WHERE vote != 0 OR replied = 1 OR opened = 1').get() as { n: number }).n
}
/** A consistent copy of the whole database, safe to take while the app runs. */
export function copyDatabaseTo(path: string): void {
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
}
/** Merge backed-up interactions in. Posts the database has never seen go into a synthetic "restored" edition; a stronger signal always wins. */
export function restoreInteractions(records: { tweetId: string; vote: number; opened: boolean; replied: boolean; heuristic?: number; claude?: number | null; final?: number; source?: string; tweet?: Tweet }[]): number {
  const tx = db.transaction((rows: typeof records) => {
    db.prepare("INSERT INTO editions(date, built_at, notes) VALUES('restored', ?, 'Votes restored from a backup') ON CONFLICT(date) DO NOTHING").run(new Date().toISOString())
    const restoredId = (db.prepare("SELECT id FROM editions WHERE date = 'restored'").get() as { id: number }).id
    let n = 0
    for (const r of rows) {
      if (!r.tweet || !r.tweetId) continue
      upsertTweet(r.tweet)
      const existing = db.prepare('SELECT edition_id, vote, opened, replied FROM edition_items WHERE tweet_id = ? ORDER BY edition_id LIMIT 1').get(r.tweetId) as
        | { edition_id: number; vote: number; opened: number; replied: number }
        | undefined
      if (existing) {
        db.prepare('UPDATE edition_items SET vote = ?, opened = ?, replied = ?, voted_at = COALESCE(voted_at, ?) WHERE edition_id = ? AND tweet_id = ?').run(
          r.vote !== 0 ? r.vote : existing.vote, Math.max(existing.opened, r.opened ? 1 : 0), Math.max(existing.replied, r.replied ? 1 : 0), new Date().toISOString(), existing.edition_id, r.tweetId
        )
      } else {
        db.prepare(
          `INSERT INTO edition_items(edition_id, tweet_id, rank, source, heuristic, claude, final, category, reason, priority, vote, voted_at, opened, replied)
           VALUES(?, ?, 0, ?, ?, ?, ?, 'interesting', 'restored from backup', 0, ?, ?, ?, ?)`
        ).run(restoredId, r.tweetId, r.source ?? 'restored', r.heuristic ?? 0.5, r.claude ?? null, r.final ?? 0.5, r.vote, new Date().toISOString(), r.opened ? 1 : 0, r.replied ? 1 : 0)
      }
      n++
    }
    return n
  })
  return tx(records)
}

/** The vote on a post from whichever edition holds it, 0 when none. */
export function getVote(tweetId: string): 1 | -1 | 0 {
  const r = db.prepare('SELECT vote FROM edition_items WHERE tweet_id = ? AND vote != 0 LIMIT 1').get(tweetId) as { vote: number } | undefined
  return (r?.vote ?? 0) as 1 | -1 | 0
}
/** Vote on any post, in an edition or not: replies, quoted posts, thread parts. Posts outside an edition go into a hidden holding edition so the learner and backups see them like any other. */
export function voteOnTweet(tweet: Tweet, vote: 1 | -1 | 0): { editionId: number } {
  const tx = db.transaction(() => {
    upsertTweet(tweet)
    const existing = db.prepare('SELECT edition_id FROM edition_items WHERE tweet_id = ? ORDER BY edition_id LIMIT 1').get(tweet.id) as { edition_id: number } | undefined
    if (existing) {
      setVote(existing.edition_id, tweet.id, vote)
      return { editionId: existing.edition_id }
    }
    db.prepare("INSERT INTO editions(date, built_at, notes) VALUES('extra', ?, 'Votes cast on replies and quoted posts') ON CONFLICT(date) DO NOTHING").run(new Date().toISOString())
    const extraId = (db.prepare("SELECT id FROM editions WHERE date = 'extra'").get() as { id: number }).id
    db.prepare(
      `INSERT INTO edition_items(edition_id, tweet_id, rank, source, heuristic, claude, final, category, reason, priority, vote, voted_at, opened, replied)
       VALUES(?, ?, 0, 'thread', 0.5, NULL, 0.5, 'interesting', 'voted in a discussion', 0, ?, ?, 1, 0)`
    ).run(extraId, tweet.id, vote, new Date().toISOString())
    return { editionId: extraId }
  })
  return tx()
}

/** Tweet ids already shown in any edition (so we never re-serve them). */
export function shownTweetIds(): Set<string> {
  const rows = db.prepare('SELECT tweet_id FROM edition_items').all() as { tweet_id: string }[]
  return new Set(rows.map((r) => r.tweet_id))
}

// ---------- notifications ----------
export function upsertNotifications(ns: Notification[]): void {
  const ins = db.prepare(
    `INSERT INTO notifications(id,json,created_at,read) VALUES(?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET json=excluded.json`
  )
  const tx = db.transaction((rows: Notification[]) => rows.forEach((n) => ins.run(n.id, JSON.stringify(n), n.createdAt)))
  tx(ns)
}
export function listNotifications(limit = 200): Notification[] {
  const rows = db.prepare('SELECT json, read FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit) as { json: string; read: number }[]
  return rows.map((r) => ({ ...(JSON.parse(r.json) as Notification), read: !!r.read }))
}
export function markNotificationsRead(ids: string[]): void {
  const st = db.prepare('UPDATE notifications SET read = 1 WHERE id = ?')
  const tx = db.transaction((xs: string[]) => xs.forEach((i) => st.run(i)))
  tx(ids)
}
