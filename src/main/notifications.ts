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
    const n = await fromX(browser, s.xHandle.toLowerCase(), s.xUserId, found)
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

async function fromX(browser: XBrowser, me: string, myUserId: string, found: Tweet[]): Promise<Notification[]> {
  const seen = new Set<string>()
  const add = (ts: Tweet[], keep: (t: Tweet) => boolean = () => true): void => ts.forEach((t) => {
    if (!seen.has(t.id) && keep(t)) {
      seen.add(t.id)
      found.push(t)
    }
  })
  const quotesMe = (t: Tweet): boolean => t.quoted?.author.handle.toLowerCase() === me
  add(await browser.search(`@${me} -from:${me}`, 2, 'live'))
  add(await browser.search(`to:${me} -from:${me}`, 1, 'live'))
  // Quotes of your posts need not mention you. Two ways to find them: X's quoted_user_id operator,
  // and the quoted post's permalink, which X indexes as a link in the quoting post.
  if (myUserId) add(await browser.search(`quoted_user_id:${myUserId} -from:${me}`, 2, 'live'), quotesMe)
  add(await browser.search(`url:x.com/${me}/status -from:${me}`, 1, 'live'), quotesMe)
  const items: Notification[] = []
  for (const t of found) {
    if (t.author.handle.toLowerCase() === me) continue
    let kind: Notification['kind'] = 'mention'
    if (quotesMe(t)) kind = 'quote'
    else if (t.inReplyToHandle?.toLowerCase() === me) kind = 'reply'
    items.push({ id: t.id, kind, createdAt: t.createdAt, tweet: t, fromHandles: [t.author.handle], read: false })
  }
  return items
}

export function summary(): { items: Notification[]; fetchedAt: string | null } {
  return { items: listNotifications(), fetchedAt: getKv('notif_at') }
}
