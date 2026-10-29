import { type BrowserWindow, Notification as SysNotification } from 'electron'
import { getEditionByDate } from './db'
import { buildEdition, localDate } from './edition'
import { followSync } from './follow'
import { refreshNotifications, summary } from './notifications'
import { syncHistory } from './history'
import { getKv } from './db'
import { loadSettings } from './settings'
import type { XBrowser } from './x/browser'
import * as bsky from './bsky/client'

/** Builds today's edition at the configured hour, runs the daily follow sync, and checks notifications on the chosen interval. */
export function startScheduler(browser: XBrowser, mainWin: () => BrowserWindow | null, log: (m: string) => void): void {
  let syncing = false
  let building = false
  let checking = false
  let syncingHistory = false
  const tick = async (): Promise<void> => {
    const s = loadSettings()
    const now = new Date()
    const bskyOn = bsky.configured()
    // Not before setup: the first build is manual, after the following list has been read (or Bluesky is set up).
    const canBuild = (s.followingFetchedAt && (await browser.isLoggedIn())) || bskyOn
    if (s.autoBuild && !building && now.getHours() >= s.buildHour && !getEditionByDate(localDate(now)) && canBuild) {
      building = true
      try {
        log("scheduler: building today's edition")
        const ed = await buildEdition(browser, log)
        if (ed && SysNotification.isSupported()) {
          new SysNotification({ title: "Today's edition is ready", body: `${ed.itemCount} posts, picked from ${ed.candidateCount}.` }).show()
        }
      } finally {
        building = false
      }
    }
    const lastCheck = getKv('notif_at')
    const due = s.notifyEveryMinutes > 0 && (!lastCheck || now.getTime() - new Date(lastCheck).getTime() >= s.notifyEveryMinutes * 60_000)
    if (due && !checking && ((s.xHandle && (await browser.isLoggedIn())) || bskyOn)) {
      checking = true
      try {
        const before = new Set(summary().items.map((n) => n.id))
        const after = await refreshNotifications(browser, log)
        const fresh = after.items.filter((n) => !before.has(n.id) && !n.read)
        if (fresh.length) {
          log(`scheduler: ${fresh.length} new notifications`)
          mainWin()?.webContents.send('notifications:updated')
          if (SysNotification.isSupported()) {
            const who = [...new Set(fresh.map((n) => '@' + n.fromHandles[0]))].slice(0, 3).join(', ')
            new SysNotification({ title: fresh.length === 1 ? 'New reply or mention' : `${fresh.length} new replies and mentions`, body: `From ${who}` }).show()
          }
        }
      } catch (e) {
        log('scheduler: notification check failed: ' + String(e))
      } finally {
        checking = false
      }
    }
    if (s.historySync && (s.hasXApiKeys || bskyOn) && !syncingHistory && now.getHours() >= 9 && s.lastHistorySyncDate !== localDate(now)) {
      syncingHistory = true
      try {
        await syncHistory(log)
      } catch (e) {
        log('scheduler: history sync failed: ' + String(e))
      } finally {
        syncingHistory = false
      }
    }
    if (s.followSync && !syncing && now.getHours() >= 9 && s.lastFollowSyncDate !== localDate(now)) {
      syncing = true
      try {
        const done = await followSync(browser, log)
        if (done.length) log(`scheduler: browsing account followed ${done.length} accounts`)
      } finally {
        syncing = false
      }
    }
  }
  setTimeout(() => void tick(), 20_000)
  setInterval(() => void tick(), 5 * 60_000)
}
