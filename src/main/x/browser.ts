// Drives a hidden BrowserWindow logged into x.com AS THE BROWSING ACCOUNT and
// captures the JSON the site's own frontend receives. This sidesteps the
// request-signing headers X requires for raw API calls. Your real account is
// never logged in here.
import { app, BrowserWindow, session } from 'electron'
import type { Author, Tweet } from '@shared/types'
import { collectTweets, parseUser } from './parse'

export interface Captured {
  url: string
  op: string
  json: unknown
  at: number
}

const X_ORIGIN = 'https://x.com'
export const PARTITION = 'persist:browsing'

/** True when the browsing partition holds X's auth_token cookie. Filters by name only: Electron's domain filter is unreliable for dotted domains. */
export async function hasAuthCookie(): Promise<boolean> {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ name: 'auth_token' })
  return cookies.some((c) => /(^|\.)x\.com$/.test(c.domain ?? '') || /(^|\.)twitter\.com$/.test(c.domain ?? ''))
}

let proxyAuth: { user: string; pass: string } | null = null

/** Route the browsing partition through a proxy so it never shares your home IP. */
export async function applyProxy(proxyUrl: string, log: (m: string) => void): Promise<void> {
  const ses = session.fromPartition(PARTITION)
  const trimmed = proxyUrl.trim()
  if (!trimmed) {
    proxyAuth = null
    await ses.setProxy({ mode: 'system' })
    return
  }
  try {
    const u = new URL(trimmed)
    const scheme = u.protocol.replace(':', '')
    const rules = `${scheme}://${u.hostname}${u.port ? ':' + u.port : ''}`
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    proxyAuth = u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : null
    log(`proxy set: ${rules}${proxyAuth ? ' (with credentials)' : ''}`)
  } catch (e) {
    log('bad proxy url: ' + String(e))
  }
}

app.on('login', (event, _wc, _details, authInfo, callback) => {
  if (authInfo.isProxy && proxyAuth) {
    event.preventDefault()
    callback(proxyAuth.user, proxyAuth.pass)
  }
})

export class XBrowser {
  private win: BrowserWindow | null = null
  private pending = new Map<string, string>() // requestId -> url
  private captures: Captured[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private log: (msg: string) => void

  constructor(log: (msg: string) => void = () => {}) {
    this.log = log
  }

  /** Serialize all browser operations. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private async ensure(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1400,
      webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, sandbox: true }
    })
    win.webContents.setAudioMuted(true)
    // Give the window a live renderer before attaching the debugger: on a fresh, never-navigated
    // window the first CDP command can wait forever for a renderer process that has not started.
    await Promise.race([win.loadURL('about:blank').catch(() => {}), this.sleep(5000)])
    const dbg = win.webContents.debugger
    try {
      dbg.attach('1.3')
      await Promise.race([
        dbg.sendCommand('Network.enable'),
        this.sleep(10000).then(() => {
          throw new Error('Network.enable timed out')
        })
      ])
    } catch (e) {
      this.log('debugger attach failed: ' + String(e))
    }
    dbg.on('message', (_e, method, params: Record<string, unknown>) => {
      if (method === 'Network.responseReceived') {
        const resp = params.response as { url: string }
        if (resp && /\/i\/api\//.test(resp.url)) this.pending.set(String(params.requestId), resp.url)
      } else if (method === 'Network.loadingFinished') {
        const id = String(params.requestId)
        const url = this.pending.get(id)
        if (!url) return
        this.pending.delete(id)
        dbg
          .sendCommand('Network.getResponseBody', { requestId: id })
          .then((r: { body: string; base64Encoded: boolean }) => {
            const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
            try {
              const json = JSON.parse(text)
              const m = url.match(/\/graphql\/[^/]+\/([A-Za-z0-9_]+)/)
              const op = m ? m[1] : url.replace(/^.*\/i\/api\//, '').replace(/\?.*$/, '')
              this.captures.push({ url, op, json, at: Date.now() })
            } catch {
              /* not JSON */
            }
          })
          .catch(() => {})
      }
    })
    win.on('closed', () => {
      this.win = null
    })
    this.win = win
    return win
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
  /** Pause of unpredictable length, as a person reading would. */
  private jitter(min: number, max: number): Promise<void> {
    return this.sleep(min + Math.random() * (max - min))
  }

  private async navigate(path: string): Promise<void> {
    const win = await this.ensure()
    this.captures = []
    this.pending.clear()
    const url = path.startsWith('http') ? path : X_ORIGIN + path
    this.log('navigate ' + url)
    await Promise.race([win.loadURL(url).catch(() => {}), this.sleep(25000)])
    await this.jitter(1200, 2200)
  }

  /** Waits for a response matching `ops` beyond `prev`. `giveUp`, checked after 2.5s, ends the wait early when the page shows no sign of loading more. */
  private async waitForNewCaptures(ops: RegExp, prev: number, timeoutMs: number, giveUp?: () => Promise<boolean>): Promise<number> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const n = this.captures.filter((c) => ops.test(c.op)).length
      if (n > prev) {
        await this.sleep(400)
        return this.captures.filter((c) => ops.test(c.op)).length
      }
      if (giveUp && Date.now() - start > 2500 && (await giveUp())) break
      await this.sleep(250)
    }
    return this.captures.filter((c) => ops.test(c.op)).length
  }

  private async pageHeight(): Promise<number> {
    const win = await this.ensure()
    return (await win.webContents.executeJavaScript('document.documentElement.scrollHeight').catch(() => 0)) as number
  }

  private async scrollDown(): Promise<void> {
    const win = await this.ensure()
    await win.webContents.executeJavaScript('window.scrollBy(0, window.innerHeight * 3.5); true').catch(() => {})
  }

  private async exec<T>(js: string): Promise<T | null> {
    const win = await this.ensure()
    try {
      return (await win.webContents.executeJavaScript(js, true)) as T
    } catch (e) {
      this.log('exec failed: ' + String(e))
      return null
    }
  }

  // ---------- session ----------
  async isLoggedIn(): Promise<boolean> {
    return hasAuthCookie()
  }

  async logout(): Promise<void> {
    this.close()
    await session.fromPartition(PARTITION).clearStorageData()
  }

  /** Handle of the logged-in browsing account, read from the home page nav. */
  async currentHandle(): Promise<string | null> {
    return this.run(async () => {
      if (!(await this.isLoggedIn())) return null
      await this.navigate('/home')
      for (let i = 0; i < 10; i++) {
        const h = await this.exec<string | null>(
          `(() => { const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'); return a ? a.getAttribute('href') : null })()`
        )
        if (h) return h.replace(/^\//, '')
        await this.sleep(700)
      }
      return null
    })
  }

  /** Load a plain-text URL through the browsing partition (for the IP check). */
  async fetchTextViaPartition(url: string): Promise<string> {
    return this.run(async () => {
      const win = await this.ensure()
      this.captures = []
      await Promise.race([win.loadURL(url).catch(() => {}), this.sleep(15000)])
      const t = await this.exec<string>('document.body ? document.body.innerText : ""')
      return (t ?? '').trim()
    })
  }

  // ---------- timelines ----------
  private collected(ops: RegExp): Tweet[] {
    const out: Tweet[] = []
    const seen = new Set<string>()
    for (const c of this.captures) {
      if (!ops.test(c.op)) continue
      for (const t of collectTweets(c.json)) {
        if (!seen.has(t.id)) {
          seen.add(t.id)
          out.push(t)
        }
      }
    }
    return out
  }

  private async captureTimeline(path: string, ops: RegExp, pages: number, stop?: (tweets: Tweet[]) => boolean, beforeScroll?: () => Promise<void>): Promise<Tweet[]> {
    await this.navigate(path)
    let count = await this.waitForNewCaptures(ops, 0, 15000)
    if (count === 0) {
      // X renames its GraphQL operations now and then. Fall back to whichever captured operations carried posts, and say what was seen.
      const seen = [...new Set(this.captures.map((c) => c.op))]
      const carrying = seen.filter((op) => !ops.test(op) && this.captures.some((c) => c.op === op && collectTweets(c.json).length > 0))
      if (carrying.length) {
        this.log(`${path}: no ${ops} responses; using ${carrying.join(', ')} instead`)
        ops = new RegExp('^(' + carrying.map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$')
        count = this.captures.filter((c) => ops.test(c.op)).length
      } else {
        this.log(`${path}: no ${ops} responses; captured: ${seen.join(', ') || 'nothing'}`)
      }
    }
    if (beforeScroll) {
      await beforeScroll()
      count = await this.waitForNewCaptures(ops, count, 8000)
    }
    let stalls = 0
    while (count < pages && stalls < 3) {
      const cur = this.collected(ops)
      if (stop && stop(cur)) break
      const before = await this.pageHeight()
      await this.scrollDown()
      const next = await this.waitForNewCaptures(ops, count, 8000, async () => (await this.pageHeight()) === before)
      if (next === count) {
        // Nothing arrived. If the page did not even grow, there is nothing more to load: stop now instead of waiting out three stalls.
        if ((await this.pageHeight()) === before) break
        stalls++
      } else stalls = 0
      count = next
    }
    const result = this.collected(ops)
    this.log(`${path}: ${result.length} tweets from ${count} responses`)
    return result
  }

  /** The browsing account's Following timeline (plus whatever "For you" served). */
  async homeTimeline(pages: number, cutoff: Date): Promise<{ following: Tweet[]; forYou: Tweet[] }> {
    return this.run(async () => {
      const ops = /^Home(Latest)?Timeline$/
      const stop = (ts: Tweet[]): boolean => ts.length > 40 && ts.filter((t) => new Date(t.createdAt) < cutoff).length > 8
      const clickFollowing = async (): Promise<void> => {
        await this.exec(
          `(() => { const tabs = [...document.querySelectorAll('a[role="tab"]')]; const t = tabs.find(a => /following/i.test(a.textContent || '')); if (t) { t.click(); return true } return false })()`
        )
        await this.sleep(1500)
      }
      const all = await this.captureTimeline('/home', ops, pages, stop, clickFollowing)
      const latestIds = new Set<string>()
      for (const c of this.captures) if (c.op === 'HomeLatestTimeline') collectTweets(c.json).forEach((t) => latestIds.add(t.id))
      const following: Tweet[] = []
      const forYou: Tweet[] = []
      for (const t of all) (latestIds.has(t.id) ? following : forYou).push(t)
      return { following, forYou }
    })
  }

  async userTweets(handle: string, cutoff: Date, maxPages = 4): Promise<Tweet[]> {
    return this.run(async () => {
      const stop = (ts: Tweet[]): boolean => ts.length > 0 && ts.filter((t) => new Date(t.createdAt) < cutoff && !t.retweetedBy).length >= 3
      const ts = await this.captureTimeline(`/${encodeURIComponent(handle)}`, /^User(Tweets|OriginalsTimeline)$/, maxPages, stop)
      return ts.filter((t) => t.author.handle.toLowerCase() === handle.toLowerCase() || t.retweetedBy?.handle.toLowerCase() === handle.toLowerCase())
    })
  }

  async search(query: string, pages: number, mode: 'top' | 'live' = 'top'): Promise<Tweet[]> {
    return this.run(async () => {
      const q = encodeURIComponent(query)
      return this.captureTimeline(`/search?q=${q}&src=typed_query&f=${mode}`, /^SearchTimeline$/, pages)
    })
  }

  async tweetDetail(id: string, pages = 2): Promise<Tweet[]> {
    return this.run(async () => this.captureTimeline(`/i/status/${id}`, /^TweetDetail$/, pages))
  }

  /** Public following list of an account: your real account's, or the browsing account's own. */
  async followingList(handle: string, maxPages = 30): Promise<Author[]> {
    return this.run(async () => {
      const ops = /^Following$/
      await this.navigate(`/${encodeURIComponent(handle)}/following`)
      let count = await this.waitForNewCaptures(ops, 0, 15000)
      let stalls = 0
      while (count < maxPages && stalls < 3) {
        await this.scrollDown()
        const next = await this.waitForNewCaptures(ops, count, 7000)
        if (next === count) stalls++
        else stalls = 0
        count = next
      }
      const users = new Map<string, Author>()
      const walk = (v: unknown, depth: number): void => {
        if (depth > 40) return
        if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
        if (!v || typeof v !== 'object') return
        const o = v as Record<string, unknown>
        if (o.__typename === 'User') {
          const u = parseUser(o)
          if (u && !users.has(u.id)) users.set(u.id, u)
        }
        for (const k of Object.keys(o)) walk(o[k], depth + 1)
      }
      for (const c of this.captures) if (ops.test(c.op)) walk(c.json, 0)
      const list = [...users.values()].filter((u) => u.handle.toLowerCase() !== handle.toLowerCase())
      this.log(`following list of @${handle}: ${list.length} from ${count} pages`)
      return list
    })
  }

  /** Follow an account from the browsing account by pressing Follow on its profile. */
  async follow(handle: string): Promise<'followed' | 'already' | 'failed'> {
    return this.run(async () => {
      await this.navigate(`/${encodeURIComponent(handle)}`)
      for (let i = 0; i < 12; i++) {
        const r = await this.exec<string>(
          `(() => {
            const head = document.querySelector('[data-testid="primaryColumn"]') || document;
            if (head.querySelector('[data-testid$="-unfollow"]')) return 'already';
            const b = head.querySelector('[data-testid$="-follow"]');
            if (!b) return 'none';
            b.click(); return 'clicked';
          })()`
        )
        if (r === 'already') return 'already'
        if (r === 'clicked') {
          await this.jitter(1500, 3000)
          const ok = await this.exec<boolean>(`!!document.querySelector('[data-testid$="-unfollow"]')`)
          return ok ? 'followed' : 'failed'
        }
        await this.sleep(700)
      }
      return 'failed'
    })
  }
}

/** Visible login window for the BROWSING account, sharing the hidden browser's partition. */
export function openLoginWindow(parent?: BrowserWindow, mode: 'login' | 'signup' = 'login'): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent,
      title: mode === 'signup' ? 'Create the browsing account' : 'Log in to X with your browsing account',
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true }
    })
    win.loadURL(mode === 'signup' ? 'https://x.com/i/flow/signup' : 'https://x.com/i/flow/login')
    const check = async (): Promise<void> => {
      if ((await hasAuthCookie()) && /x\.com\/(home|$)/.test(win.webContents.getURL())) {
        setTimeout(() => {
          if (!win.isDestroyed()) win.close()
        }, 1200)
      }
    }
    win.webContents.on('did-navigate', check)
    win.webContents.on('did-navigate-in-page', check)
    win.on('closed', () => resolve())
  })
}
