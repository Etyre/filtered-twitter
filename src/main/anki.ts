import { app, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { AnkiGate } from '@shared/types'
import { getSetting, setSetting } from './db'
import { loadSettings } from './settings'

/**
 * When the setting is on, the app stays closed each day until the Anki review is done: the chosen deck
 * (with its subdecks) has nothing left to do but learning cards, or enough of its cards were answered today.
 * Once open, it stays open until Anki's next day begins.
 */
const ANKI_CONNECT = 'http://127.0.0.1:8765'
const ANKI_APP = '/Applications/Anki.app'
const COLLECTION = join(app.getPath('home'), 'Library/Application Support/Anki2/User 1/collection.anki2')

const DAY_MS = 86_400_000

/** Anki's day starts at its rollover hour, not midnight. Days are numbered by the local date of (time − rollover). */
function dayNumber(ms: number, rollover: number): number {
  const d = new Date(ms - rollover * 3_600_000)
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS)
}
function rolloverHour(): number {
  const n = Number(getSetting('ankiRollover'))
  return Number.isFinite(n) && getSetting('ankiRollover') !== null ? n : 4
}
const todayKey = (): string => String(dayNumber(Date.now(), rolloverHour()))

async function ankiConnect<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ANKI_CONNECT, {
    method: 'POST',
    body: JSON.stringify({ action, version: 6, params }),
    signal: AbortSignal.timeout(3000)
  })
  const body = (await res.json()) as { result: T; error: string | null }
  if (body.error) throw new Error(body.error)
  return body.result
}

interface Counts { reviewed: number; newDue: number; reviewDue: number }

/** Exact counts from Anki itself, while it is running. Null when Anki (or AnkiConnect) is not answering. */
async function fromAnkiConnect(DECK: string): Promise<Counts | null> {
  let names: string[]
  try {
    names = await ankiConnect<string[]>('deckNames')
  } catch {
    return null
  }
  // getDeckStats creates a deck it doesn't find, so make sure the deck exists first.
  if (!names.includes(DECK)) throw new Error(`Anki has no deck named “${DECK}”.`)
  const q = `"deck:${DECK}"`
  const [stats, reviewedCards] = await Promise.all([
    ankiConnect<Record<string, { name: string; new_count: number; review_count: number }>>('getDeckStats', { decks: [DECK] }),
    ankiConnect<number[]>('findCards', { query: `${q} rated:1` })
  ])
  const s = Object.values(stats).find((x) => x.name === DECK)
  if (!s) throw new Error('Anki did not report counts for ' + DECK)
  return { reviewed: reviewedCards.length, newDue: s.new_count, reviewDue: s.review_count }
}

/**
 * Read the collection file directly, when Anki is closed. Cards answered today are exact. For what's
 * still due it is conservative: any unseen new card counts as due, since daily new-card limits live in
 * Anki's deck options; opening Anki gives the exact answer.
 */
function fromCollectionFile(DECK: string): Counts | null {
  if (!existsSync(COLLECTION)) return null
  let db: Database.Database | null = null
  try {
    db = new Database(COLLECTION, { readonly: true, fileMustExist: true, timeout: 500 })
    const conf = db.prepare("SELECT CAST(val AS TEXT) AS v FROM config WHERE key = 'rollover'").get() as { v: string } | undefined
    const rollover = conf ? Number(conf.v) : 4
    if (Number.isFinite(rollover)) setSetting('ankiRollover', String(rollover))
    const crt = (db.prepare('SELECT crt FROM col').get() as { crt: number }).crt
    const now = Date.now()
    const today = dayNumber(now, rollover) - dayNumber(crt * 1000, rollover)
    // Start of Anki's day, in ms: rollover hour on the local date that dayNumber assigns to now.
    const d = new Date(now - rollover * 3_600_000)
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), rollover).getTime()
    const sep = '\x1f'
    const decks = (db.prepare('SELECT id, name FROM decks').all() as { id: number; name: string }[])
      .filter((x) => x.name === DECK || x.name.startsWith(DECK + sep))
      .map((x) => x.id)
    if (!decks.length) throw new Error(`Anki has no deck named “${DECK}”.`)
    const inDecks = `(${decks.map(() => '?').join(',')})`
    // A card in a filtered deck keeps its home deck in odid.
    const home = `(CASE WHEN c.odid != 0 THEN c.odid ELSE c.did END) IN ${inDecks}`
    const reviewed = (db.prepare(`SELECT COUNT(DISTINCT r.cid) AS n FROM revlog r JOIN cards c ON c.id = r.cid WHERE r.id >= ? AND r.type != 4 AND ${home}`).get(dayStart, ...decks) as { n: number }).n
    const reviewDue = (db.prepare(`SELECT COUNT(*) AS n FROM cards c WHERE c.queue = 2 AND c.due <= ? AND ${home}`).get(today, ...decks) as { n: number }).n
    const newDue = (db.prepare(`SELECT COUNT(*) AS n FROM cards c WHERE c.queue = 0 AND ${home}`).get(...decks) as { n: number }).n
    return { reviewed, newDue, reviewDue }
  } catch (e) {
    if (e instanceof Error && e.message.includes('no deck named')) throw e
    return null // locked by a running Anki, or unreadable
  } finally {
    db?.close()
  }
}

export async function ankiGate(): Promise<AnkiGate> {
  const s = loadSettings()
  if (!s.ankiGate || getSetting('ankiUnlockedDay') === todayKey()) return { open: true }
  const DECK = s.ankiDeck.trim() || 'Daily review'
  const REVIEW_TARGET = Math.max(1, s.ankiTarget || 80)
  try {
    const counts = (await fromAnkiConnect(DECK)) ?? fromCollectionFile(DECK)
    if (!counts) return { open: false, reviewed: null, target: REVIEW_TARGET, deck: DECK, note: 'Couldn’t read Anki. Open it and the app will check again.' }
    const open = counts.reviewed >= REVIEW_TARGET || (counts.newDue === 0 && counts.reviewDue === 0)
    if (open) setSetting('ankiUnlockedDay', todayKey())
    return { open, reviewed: counts.reviewed, target: REVIEW_TARGET, deck: DECK, note: null }
  } catch (e) {
    return { open: false, reviewed: null, target: REVIEW_TARGET, deck: DECK, note: e instanceof Error ? e.message : String(e) }
  }
}

export async function openAnki(): Promise<void> {
  const err = await shell.openPath(ANKI_APP)
  if (err) throw new Error(err)
}
