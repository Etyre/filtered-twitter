// Builds the daily edition: gather candidates (via the browsing account), score, select, persist.
import type { Edition, Progress, ScoredTweet, Source, Tweet } from '@shared/types'
import { prefetchThreads } from './thread'
import { snapshot } from './backup'
import { createEdition, getEditionByDate, getVoteHistory, shownTweetIds, upsertTweets } from './db'
import { scoreHeuristic, trainHeuristic } from './ranking/heuristic'
import { scoreWithClaude } from './ranking/claude'
import { auc, blend, fitWeights } from './ranking/blend'
import { loadSettings, readSecret, saveSettings } from './settings'
import type { XBrowser } from './x/browser'

export function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

let progress: Progress | null = null
let building = false
const listeners = new Set<(p: Progress) => void>()
export function onProgress(cb: (p: Progress) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export function getProgress(): Progress | null {
  return progress
}
function report(phase: string, detail = '', done = false, error?: string): void {
  progress = { phase, detail, done, error }
  listeners.forEach((l) => l(progress!))
}

/** Split handles into `from:a OR from:b …` search queries that stay under X's query length. */
export function fromQueries(handles: string[], perQuery = 20): string[] {
  const out: string[] = []
  for (let i = 0; i < handles.length; i += perQuery) {
    out.push('(' + handles.slice(i, i + perQuery).map((h) => `from:${h}`).join(' OR ') + ')')
  }
  return out
}

export async function buildEdition(browser: XBrowser, log: (m: string) => void, force = false): Promise<Edition | null> {
  const date = localDate()
  const existing = getEditionByDate(date)
  if (existing && !force) return existing
  if (building) return existing
  building = true
  try {
    const s = loadSettings()
    if (!(await browser.isLoggedIn())) throw new Error('The browsing account is not logged in. Open Settings and log in.')
    const cutoff = new Date(Date.now() - 26 * 3600 * 1000)
    const already = shownTweetIds()
    const priority = new Set(s.priorityHandles.map((h) => h.toLowerCase()))
    const followingSet = new Set(s.followingHandles)
    const skipAuthors = new Set([s.xHandle.toLowerCase(), s.browsingHandle.toLowerCase()].filter(Boolean))
    const candidates = new Map<string, { tweet: Tweet; source: Source; isFollowing: boolean }>()
    const rank: Record<Source, number> = { priority: 4, following: 3, search: 2, foryou: 1, notification: 0 }
    const add = (t: Tweet, source: Source): void => {
      if (already.has(t.id)) return
      if (new Date(t.createdAt) < cutoff) return
      if (skipAuthors.has(t.author.handle.toLowerCase())) return
      const isFollowing = followingSet.has(t.author.handle.toLowerCase()) || priority.has(t.author.handle.toLowerCase())
      const cur = candidates.get(t.id)
      if (!cur || rank[source] > rank[cur.source]) candidates.set(t.id, { tweet: t, source, isFollowing })
    }

    // 1. Priority accounts, each profile read in full.
    let i = 0
    for (const h of s.priorityHandles) {
      i++
      report('Priority accounts', `@${h} (${i}/${s.priorityHandles.length})`)
      try {
        const ts = await browser.userTweets(h, cutoff)
        ts.forEach((t) => add(t, 'priority'))
      } catch (e) {
        log(`priority @${h} failed: ${String(e)}`)
      }
    }

    // 2. The browsing account's own Following timeline (covers whoever it already follows).
    const browsingFollows = new Set(s.browsingFollows)
    if (browsingFollows.size > 0) {
      report('Browsing-account timeline', `up to ${s.homePages} pages`)
      try {
        const home = await browser.homeTimeline(s.homePages, cutoff)
        home.following.forEach((t) => add(t, 'following'))
        home.forYou.forEach((t) => add(t, 'foryou'))
      } catch (e) {
        log('home failed: ' + String(e))
      }
    }

    // 3. Everyone you follow that the browsing account does not yet: batched from: searches.
    const since = localDate(new Date(Date.now() - 24 * 3600 * 1000))
    const uncovered = s.followingHandles.filter((h) => !browsingFollows.has(h) && !priority.has(h))
    const sweeps = fromQueries(uncovered)
    i = 0
    for (const q of sweeps) {
      i++
      report('Sweeping accounts you follow', `${i}/${sweeps.length}`)
      try {
        const ts = await browser.search(`${q} since:${since} -filter:replies`, s.searchPages, 'live')
        ts.forEach((t) => add(t, 'following'))
      } catch (e) {
        log(`sweep failed: ${String(e)}`)
      }
    }

    // 4. AI topic searches, anyone on X.
    i = 0
    for (const q of s.searchQueries) {
      i++
      report('Searching topics', `${i}/${s.searchQueries.length}: ${q.slice(0, 60)}`)
      try {
        const ts = await browser.search(`${q} since:${since}`, s.searchPages, 'top')
        ts.forEach((t) => add(t, 'search'))
      } catch (e) {
        log(`search failed: ${String(e)}`)
      }
    }

    const all = [...candidates.values()]
    upsertTweets(all.map((c) => c.tweet))
    report('Scoring', `${all.length} candidates`)

    // 5. Heuristic
    const history = getVoteHistory()
    const hModel = trainHeuristic(history)
    const scored: ScoredTweet[] = all.map((c) => {
      const isPriority = priority.has(c.tweet.author.handle.toLowerCase()) || (!!c.tweet.retweetedBy && priority.has(c.tweet.retweetedBy.handle.toLowerCase()))
      const h = scoreHeuristic({ tweet: c.tweet, isPriority, isFollowing: c.isFollowing, source: c.source }, hModel)
      return { tweet: c.tweet, source: c.source, heuristicScore: h, claudeScore: null, finalScore: h, category: 'interesting', reason: '', priorityAccount: isPriority }
    })

    // 6. Claude, on the heuristic shortlist to bound cost
    const key = readSecret('anthropicApiKey')
    const notes: string[] = []
    if (s.claudeEnabled && key) {
      const shortlist = [...scored]
        .filter((x) => !x.priorityAccount)
        .sort((a, b) => b.heuristicScore - a.heuristicScore)
        .slice(0, Math.max(s.dailyLimit * 3, 150))
      const withPriority = [...scored.filter((x) => x.priorityAccount), ...shortlist]
      report('Claude scoring', `0/${withPriority.length}`)
      try {
        const ratings = await scoreWithClaude(
          withPriority.map((x) => x.tweet),
          {
            apiKey: key, model: s.claudeModel, profile: s.interestProfile, history, priorityHandles: s.priorityHandles, log,
            onProgress: (d, t) => report('Claude scoring', `${d}/${t}`)
          }
        )
        for (const x of scored) {
          const r = ratings.get(x.tweet.id)
          if (r) {
            x.claudeScore = r.score
            x.category = r.category
            x.reason = r.reason
          }
        }
        notes.push(`Claude rated ${ratings.size} of ${withPriority.length} sent.`)
      } catch (e) {
        notes.push('Claude scoring failed: ' + String(e))
        log('claude failed: ' + String(e))
      }
    } else {
      notes.push(key ? 'Claude scoring disabled.' : 'No Anthropic key; heuristic only.')
    }

    // 7. Blend with learned weights
    const weights = fitWeights(history, s.blendWeights)
    saveSettings({ blendWeights: weights })
    for (const x of scored) x.finalScore = blend(x.heuristicScore, x.claudeScore, weights)
    for (const x of scored) if (x.claudeScore === null && !x.reason) x.reason = x.source === 'search' ? 'matched a topic search' : 'from someone you follow'

    // 8. Select: all priority originals (no cap), then best of the rest.
    const prio = scored.filter((x) => x.priorityAccount && !x.tweet.inReplyToId).sort((a, b) => b.finalScore - a.finalScore)
    const rest = scored
      .filter((x) => !(x.priorityAccount && !x.tweet.inReplyToId))
      .filter((x) => x.category !== 'skip' || x.finalScore > 0.6)
      .sort((a, b) => b.finalScore - a.finalScore)
    const room = Math.max(0, s.dailyLimit - prio.length)
    const chosen = [...prio, ...dedupeNews(rest).slice(0, room)]
    if (prio.length > s.dailyLimit) notes.push(`Priority accounts alone produced ${prio.length} posts, over the ${s.dailyLimit} limit.`)
    chosen.sort((a, b) => {
      if (a.priorityAccount !== b.priorityAccount) return a.priorityAccount ? -1 : 1
      if (a.priorityAccount) return new Date(b.tweet.createdAt).getTime() - new Date(a.tweet.createdAt).getTime()
      return b.finalScore - a.finalScore
    })

    if (uncovered.length) notes.push(`${uncovered.length} accounts swept by search; the browsing account follows ${browsingFollows.size} so far.`)
    const hAuc = auc(history, (h) => h.heuristic)
    const cAuc = auc(history, (h) => h.claude)
    if (hAuc !== null || cAuc !== null) notes.push(`Scorer AUC so far: heuristic ${fmt(hAuc)}, Claude ${fmt(cAuc)}; weights h=${weights.heuristic.toFixed(2)} c=${weights.claude.toFixed(2)}.`)
    report('Saving', `${chosen.length} posts`)
    const ed = createEdition(date, chosen, scored, notes.join(' '))
    report('Done', `${chosen.length} posts from ${all.length} candidates`, true)
    void prefetchThreads(browser, chosen.filter((x) => x.tweet.replies > 0 || x.tweet.inReplyToId).map((x) => x.tweet.id), log)
    snapshot('build', log)
    return ed
  } catch (e) {
    report('Failed', String(e), true, String(e))
    log('build failed: ' + String(e))
    return getEditionByDate(date)
  } finally {
    building = false
  }
}

const fmt = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(2))

/** Light near-duplicate suppression: posts sharing most of their rare tokens keep only the best. */
function dedupeNews(sorted: ScoredTweet[]): ScoredTweet[] {
  const kept: { x: ScoredTweet; toks: Set<string> }[] = []
  const out: ScoredTweet[] = []
  for (const x of sorted) {
    const toks = new Set(x.tweet.text.toLowerCase().replace(/https?:\/\/\S+/g, '').split(/\W+/).filter((t) => t.length > 4))
    let dup = false
    for (const k of kept) {
      if (toks.size < 6 || k.toks.size < 6) continue
      let inter = 0
      toks.forEach((t) => {
        if (k.toks.has(t)) inter++
      })
      const j = inter / (toks.size + k.toks.size - inter)
      if (j > 0.6) {
        dup = true
        break
      }
    }
    if (!dup) {
      kept.push({ x, toks })
      out.push(x)
    }
  }
  return out
}
