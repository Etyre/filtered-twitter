// Replies, mentions and quotes of your real account, found by the browsing
// account via search. No session of your real account is ever used.
import type { Notification, Tweet } from '@shared/types'
import { getKv, listNotifications, setKv, upsertNotifications, upsertTweets } from './db'
import { loadSettings } from './settings'
import type { XBrowser } from './x/browser'

export async function refreshNotifications(browser: XBrowser, log: (m: string) => void): Promise<{ items: Notification[]; fetchedAt: string | null }> {
  const s = loadSettings()
  const me = s.xHandle.toLowerCase()
  if (!me) throw new Error('Set your account handle in Settings first (it is filled in when you verify your API keys).')
  const found: Tweet[] = []
  const seen = new Set<string>()
  const add = (ts: Tweet[]): void => ts.forEach((t) => {
    if (!seen.has(t.id)) {
      seen.add(t.id)
      found.push(t)
    }
  })
  add(await browser.search(`@${me} -from:${me}`, 2, 'live'))
  add(await browser.search(`to:${me} -from:${me}`, 1, 'live'))
  const items: Notification[] = []
  for (const t of found) {
    if (t.author.handle.toLowerCase() === me) continue
    let kind: Notification['kind'] = 'mention'
    if (t.quoted && t.quoted.author.handle.toLowerCase() === me) kind = 'quote'
    else if (t.inReplyToHandle?.toLowerCase() === me) kind = 'reply'
    items.push({ id: t.id, kind, createdAt: t.createdAt, tweet: t, fromHandles: [t.author.handle], read: false })
  }
  upsertTweets(found)
  upsertNotifications(items)
  const fetchedAt = new Date().toISOString()
  setKv('notif_at', fetchedAt)
  log(`notifications: ${items.length} items`)
  return summary()
}

export function summary(): { items: Notification[]; fetchedAt: string | null } {
  return { items: listNotifications(), fetchedAt: getKv('notif_at') }
}
