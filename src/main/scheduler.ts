import { Notification as SysNotification } from 'electron'
import { getEditionByDate } from './db'
import { buildEdition, localDate } from './edition'
import { followSync } from './follow'
import { loadSettings } from './settings'
import type { XBrowser } from './x/browser'

/** Builds today's edition at the configured hour, then runs the daily follow sync. */
export function startScheduler(browser: XBrowser, log: (m: string) => void): void {
  let syncing = false
  let building = false
  const tick = async (): Promise<void> => {
    const s = loadSettings()
    const now = new Date()
    // Not before setup: the first build is manual, after the following list has been read.
    if (s.autoBuild && !building && s.followingFetchedAt && now.getHours() >= s.buildHour && !getEditionByDate(localDate(now)) && (await browser.isLoggedIn())) {
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
