// Developer smoke test: FT_SMOKE=1 runs the capture pipeline and logs results.
import { app } from 'electron'
import type { XBrowser } from './x/browser'
import { loadSettings } from './settings'
import { fromQueries } from './edition'

export async function runSmoke(browser: XBrowser, log: (m: string) => void): Promise<void> {
  const s = loadSettings()
  const out = (label: string, v: unknown): void => log(`SMOKE ${label}: ${JSON.stringify(v)}`)
  try {
    out('loggedIn', await browser.isLoggedIn())
    out('browsingHandle', await browser.currentHandle())
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000)
    const h = s.priorityHandles[0] ?? 'AnthropicAI'
    const ut = await browser.userTweets(h, cutoff, 2)
    out('user ' + h, { n: ut.length, sample: ut.slice(0, 2).map((t) => [t.author.handle, t.text.slice(0, 60), t.createdAt]) })
    const target = s.xHandle || 'AnthropicAI'
    const fl = await browser.followingList(target, 3)
    out('following of ' + target, { n: fl.length, sample: fl.slice(0, 5).map((u) => u.handle) })
    const sweep = fromQueries(fl.slice(0, 20).map((u) => u.handle))[0]
    if (sweep) {
      const sw = await browser.search(`${sweep} -filter:replies`, 1, 'live')
      out('sweep', { n: sw.length, sample: sw.slice(0, 3).map((t) => [t.author.handle, t.text.slice(0, 50)]) })
    }
    const sr = await browser.search('(OpenAI OR Anthropic) min_faves:300', 1)
    out('search', { n: sr.length, sample: sr.slice(0, 2).map((t) => [t.author.handle, t.text.slice(0, 60)]) })
    const home = await browser.homeTimeline(2, cutoff)
    out('home', { following: home.following.length, forYou: home.forYou.length })
    const focal = ut[0] ?? sr[0]
    if (focal) {
      const td = await browser.tweetDetail(focal.id, 1)
      out('detail', { n: td.length, focalFound: td.some((t) => t.id === focal.id) })
    }
  } catch (e) {
    out('error', String(e))
  }
  log('SMOKE done')
  if (process.env.FT_SMOKE_QUIT) app.quit()
}
