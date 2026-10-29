// Replies, mentions and quotes of your accounts. On X they are found by the browsing
// account via search (no session of your real account is ever used); on Bluesky the API lists them.
import type { Notification, Tweet } from '@shared/types'
import { getKv, listNotifications, setKv, upsertNotifications, upsertTweets } from './db'
import { loadSettings } from './settings'
import type { XBrowser } from './x/browser'
import * as bsky from './bsky/client'
import { autoTranslateOn, translateTweets } from './translate'

export async function refreshNotifications(browser: XBrowser, log: (m: string) => void): Promise<{ items: Notification[]; fetchedAt: string | null }> {
  const s = loadSettings()
  const xReady = !!s.xHandle && (await browser.isLoggedIn())
  const bskyReady = bsky.configured()
  if (!xReady && !bskyReady) throw new Error('Set your X handle (filled in when you verify your API keys) with the browsing account logged in, or set up Bluesky, in Settings.')
  const items: Notification[] = []
  const found: Tweet[] = []
  if (xReady) {
    const n = await fromX(browser, s.xHandle.toLowerCase(), found)
    items.push(...n)
  }
  if (bskyReady) {
    try {
      const rows = await bsky.notifications()
      for (const { n, tweet } of rows) {
        found.push(tweet)
        items.push({ id: tweet.id, kind: n.reason as Notification['kind'], createdAt: tweet.createdAt, tweet, fromHandles: [tweet.author.handle], read: false })
      }
    } catch (e) {
      log('bsky notifications failed: ' + String(e))
      if (!xReady) throw e
    }
  }
  upsertTweets(found)
  if (autoTranslateOn()) await translateTweets(found, log).catch((e) => log('notification translate failed: ' + String(e))) // the items hold these same posts
  upsertNotifications(items)
  const fetchedAt = new Date().toISOString()
  setKv('notif_at', fetchedAt)
  log(`notifications: ${items.length} items`)
  return summary()
}

async function fromX(browser: XBrowser, me: string, found: Tweet[]): Promise<Notification[]> {
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
  return items
}

export function summary(): { items: Notification[]; fetchedAt: string | null } {
  return { items: listNotifications(), fetchedAt: getKv('notif_at') }
}
