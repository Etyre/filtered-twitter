// Votes are the one thing that cannot be rebuilt, so they leave the database as soon as they happen.
// Three layers: an append-only log written on every vote, a JSON snapshot of all interactions and
// settings, and a daily copy of the whole database. All of it lands in a folder that iCloud Drive
// syncs when it exists, so a lost disk is not a lost taste profile.
import { BrowserWindow, dialog } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { BackupStatus, Interaction, Tweet } from '@shared/types'
import * as db from './db'
import { loadSettings, saveSettings } from './settings'

const KEEP_DB_COPIES = 7

export function defaultBackupDir(): string {
  const icloud = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  return join(existsSync(icloud) ? icloud : join(homedir(), 'Documents'), 'Filtered Twitter backups')
}

export function backupDir(): string {
  const dir = loadSettings().backupDir.trim() || defaultBackupDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Append one interaction to votes.jsonl the moment it happens. Each line is self-contained, with the post itself. */
export function logInteraction(rec: Interaction, log: (m: string) => void): void {
  try {
    appendFileSync(join(backupDir(), 'votes.jsonl'), JSON.stringify(rec) + '\n')
  } catch (e) {
    log('backup: could not append to votes.jsonl: ' + String(e))
  }
  scheduleSnapshot(log)
}

let pending: NodeJS.Timeout | null = null
/** A JSON snapshot shortly after the last vote in a burst, without the database copy. */
function scheduleSnapshot(log: (m: string) => void): void {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    snapshot('vote', log, false)
  }, 30_000)
}

/** Write votes.json and settings.json; with `withDb`, also a dated copy of the database, keeping the newest few. */
export function snapshot(reason: string, log: (m: string) => void, withDb = true): { ok: boolean; error?: string } {
  try {
    const dir = backupDir()
    const interactions = db.exportInteractions()
    writeFileSync(join(dir, 'votes.json'), JSON.stringify({ exportedAt: new Date().toISOString(), count: interactions.length, interactions }, null, 1))
    const s = loadSettings()
    const { hasAnthropicKey: _a, hasXApiKeys: _b, ...rest } = s // nothing secret is in settings, but the flags are meaningless elsewhere
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(rest, null, 2))
    if (withDb) {
      const name = `filtered-twitter-${new Date().toISOString().slice(0, 10)}.sqlite`
      const target = join(dir, name)
      if (existsSync(target)) unlinkSync(target)
      db.copyDatabaseTo(target)
      const copies = readdirSync(dir)
        .filter((f) => /^filtered-twitter-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
        .sort()
      for (const old of copies.slice(0, Math.max(0, copies.length - KEEP_DB_COPIES))) unlinkSync(join(dir, old))
    }
    saveSettings({ lastBackupAt: new Date().toISOString() })
    log(`backup (${reason}): ${interactions.length} interactions to ${dir}${withDb ? ', with database copy' : ''}`)
    return { ok: true }
  } catch (e) {
    log(`backup (${reason}) failed: ${String(e)}`)
    return { ok: false, error: String(e) }
  }
}

/** A full backup on startup when the last one is more than a day old. */
export function snapshotIfStale(log: (m: string) => void): void {
  const last = loadSettings().lastBackupAt
  if (!last || Date.now() - new Date(last).getTime() > 24 * 3600_000) snapshot('startup', log)
}

export function status(): BackupStatus {
  const s = loadSettings()
  const dir = s.backupDir.trim() || defaultBackupDir()
  let files = 0
  let logLines = 0
  try {
    files = readdirSync(dir).length
    const p = join(dir, 'votes.jsonl')
    if (existsSync(p) && statSync(p).size) logLines = readFileSync(p, 'utf8').split('\n').filter(Boolean).length
  } catch {
    /* folder may not exist yet */
  }
  return { dir, lastBackupAt: s.lastBackupAt, interactions: db.countInteractions(), loggedEvents: logLines, files }
}

/** Let the user pick votes.json or votes.jsonl and merge its interactions back in. Existing votes are never weakened. */
export async function restoreFromFile(parent: BrowserWindow | undefined, log: (m: string) => void): Promise<{ ok: boolean; imported: number; error?: string }> {
  const r = await dialog.showOpenDialog(parent ?? new BrowserWindow({ show: false }), {
    title: 'Restore votes from a backup',
    defaultPath: backupDir(),
    filters: [{ name: 'Vote backups', extensions: ['json', 'jsonl'] }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths[0]) return { ok: false, imported: 0, error: 'cancelled' }
  try {
    const text = readFileSync(r.filePaths[0], 'utf8')
    const records: Interaction[] = r.filePaths[0].endsWith('.jsonl')
      ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Interaction)
      : (JSON.parse(text) as { interactions: Interaction[] }).interactions
    const imported = db.restoreInteractions(records)
    log(`restore: ${imported} interactions from ${r.filePaths[0]}`)
    return { ok: true, imported }
  } catch (e) {
    return { ok: false, imported: 0, error: String(e) }
  }
}

/** Build the record for one interaction from what the database knows about it. */
export function interactionRecord(kind: Interaction['kind'], editionId: number | null, tweetId: string, vote: 1 | -1 | 0): Interaction | null {
  const row = editionId !== null ? db.getItem(editionId, tweetId) : db.getItemsForTweet(tweetId)[0]
  if (!row) return null
  return {
    at: new Date().toISOString(), kind, editionId: row.editionId, editionDate: row.editionDate, tweetId, vote,
    opened: row.opened, replied: row.replied, heuristic: row.heuristic, claude: row.claude, final: row.final, source: row.source,
    tweet: row.tweet as Tweet
  }
}
