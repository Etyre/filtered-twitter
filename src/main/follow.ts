// Keeps the browsing account's follows converging on your real account's
// follows, a few per day with pauses, so its own timeline becomes the main
// candidate source and it looks like an ordinary account rather than a reader.
import { loadSettings, saveSettings } from './settings'
import { localDate } from './edition'
import type { XBrowser } from './x/browser'
import * as official from './x/official'
import { ensureUserId } from './x/actions'

/** Your following list: through the official API when keys are set (complete and cheap), else read by the browsing account. */
async function myFollowing(browser: XBrowser, log: (m: string) => void): Promise<{ handle: string }[]> {
  const s = loadSettings()
  if (s.hasXApiKeys) {
    try {
      const users = await official.following(await ensureUserId())
      log(`following list via API: ${users.length} accounts`)
      return users.map((u) => ({ handle: u.username }))
    } catch (e) {
      log('following list via API failed, falling back to the browsing account: ' + String(e))
    }
  }
  if (!s.xHandle) throw new Error('Set your account handle first (verify your API keys in Settings).')
  return browser.followingList(s.xHandle)
}

export async function refreshFollowing(browser: XBrowser, log: (m: string) => void): Promise<void> {
  const s = loadSettings()
  const mine = await myFollowing(browser, log)
  const patch: Partial<typeof s> = { followingHandles: mine.map((u) => u.handle.toLowerCase()), followingFetchedAt: new Date().toISOString() }
  if (s.browsingHandle) {
    try {
      const theirs = await browser.followingList(s.browsingHandle)
      patch.browsingFollows = theirs.map((u) => u.handle.toLowerCase())
    } catch (e) {
      log('browsing follows failed: ' + String(e))
    }
  }
  saveSettings(patch)
}

/** Follow up to `followPerDay` accounts the browsing account doesn't follow yet. */
export async function followSync(browser: XBrowser, log: (m: string) => void, force = false): Promise<string[]> {
  const s = loadSettings()
  if (!s.followSync && !force) return []
  if (s.lastFollowSyncDate === localDate() && !force) return []
  if (!(await browser.isLoggedIn())) return []
  const have = new Set(s.browsingFollows)
  const want = [...new Set([...s.priorityHandles, ...s.followingHandles])].filter((h) => !have.has(h) && h !== s.browsingHandle.toLowerCase())
  const prio = want.filter((h) => s.priorityHandles.includes(h))
  const rest = want.filter((h) => !s.priorityHandles.includes(h)).sort(() => Math.random() - 0.5)
  const todo = [...prio, ...rest].slice(0, Math.max(0, s.followPerDay))
  const followed: string[] = []
  saveSettings({ lastFollowSyncDate: localDate() })
  for (const h of todo) {
    try {
      const r = await browser.follow(h)
      log(`follow @${h}: ${r}`)
      if (r === 'followed' || r === 'already') {
        followed.push(h)
        const cur = loadSettings()
        saveSettings({ browsingFollows: [...new Set([...cur.browsingFollows, h])] })
      }
    } catch (e) {
      log(`follow @${h} failed: ${String(e)}`)
    }
    // Pause between follows, outside the browser queue so other work can interleave.
    await new Promise((r) => setTimeout(r, 25_000 + Math.random() * 50_000))
  }
  return followed
}
