// Builds the daily edition: gather candidates (X via the browsing account, Bluesky via its API), score, select, persist.
import type { Edition, Progress, ScoredTweet, Source, Tweet } from '@shared/types'
import { prefetchThreads } from './thread'
import { snapshot } from './backup'
import { createEdition, getEditionByDate, getVoteHistory, shownTweetIds, upsertTweets } from './db'
import { scoreHeuristic, trainHeuristic } from './ranking/heuristic'
import { scoreWithClaude } from './ranking/claude'
import { auc, blend, fitWeights } from './ranking/blend'
import { loadSettings, readSecret, saveSettings } from './settings'
import { translateTweets } from './translate'
import type { XBrowser } from './x/browser'
import * as bsky from './bsky/client'

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
    const xOn = await browser.isLoggedIn()
    const bskyOn = bsky.configured()
    if (!xOn && !bskyOn) throw new Error('Nothing to read from: log the browsing account in, or set up Bluesky, in Settings.')
    const cutoff = new Date(Date.now() - 26 * 3600 * 1000)
    const already = shownTweetIds()
    // Bluesky handles contain a dot and X handles cannot, so one set holds both without clashing.
    const priority = new Set([...s.priorityHandles, ...s.bskyPriorityHandles].map((h) => h.toLowerCase()))
    const followingSet = new Set(s.followingHandles)
    const skipAuthors = new Set([s.xHandle.toLowerCase(), s.browsingHandle.toLowerCase(), s.bskyHandle.toLowerCase()].filter(Boolean))
    const candidates = new Map<string, { tweet: Tweet; source: Source; isFollowing: boolean }>()
    const notes: string[] = []
    const rank: Record<Source, number> = { priority: 4, following: 3, search: 2, foryou: 1, notification: 0 }
    const add = (t: Tweet, source: Source, following = false): void => {
      if (already.has(t.id)) return
      if (new Date(t.createdAt) < cutoff) return
      if (skipAuthors.has(t.author.handle.toLowerCase())) return
      const isFollowing = following || followingSet.has(t.author.handle.toLowerCase()) || priority.has(t.author.handle.toLowerCase())
      const cur = candidates.get(t.id)
      if (!cur || rank[source] > rank[cur.source]) candidates.set(t.id, { tweet: t, source, isFollowing })
    }

    if (xOn) await gatherX()
    if (bskyOn) await gatherBsky()

    async function gatherX(): Promise<void> {
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
    if (uncovered.length) notes.push(`${uncovered.length} accounts swept by search; the browsing account follows ${browsingFollows.size} so far.`)
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
    }

    /** Bluesky: priority accounts, the following feed, and topic searches, all through the API. */
    async function gatherBsky(): Promise<void> {
      const found: Tweet[] = []
      const take = (ts: Tweet[], source: Source, following: boolean): void => {
        for (const t of ts) {
          add(t, source, following)
          found.push(t)
        }
      }
      let i = 0
      for (const h of s.bskyPriorityHandles) {
        i++
        report('Bluesky priority accounts', `@${h} (${i}/${s.bskyPriorityHandles.length})`)
        try {
          take(await bsky.authorFeed(h, cutoff), 'priority', true)
        } catch (e) {
          log(`bsky priority @${h} failed: ${String(e)}`)
        }
      }
      report('Bluesky following feed', `up to ${s.bskyPages} pages`)
      try {
        take(await bsky.timeline(s.bskyPages, cutoff), 'following', true)
      } catch (e) {
        log('bsky timeline failed: ' + String(e))
      }
      i = 0
      for (const q of s.bskySearchQueries) {
        i++
        report('Searching Bluesky', `${i}/${s.bskySearchQueries.length}: ${q.slice(0, 60)}`)
        try {
          take(await bsky.search(q, cutoff), 'search', false)
        } catch (e) {
          log(`bsky search failed: ${String(e)}`)
        }
      }
      // Feed items carry no follower counts; fetch them so engagement is judged against audience size, as on X.
      const dids = [...new Set(found.filter((t) => candidates.has(t.id)).map((t) => t.author.id))]
      if (dids.length) {
        report('Bluesky profiles', `${dids.length} accounts`)
        const counts = await bsky.followerCounts(dids)
        for (const c of candidates.values()) {
          const n = c.tweet.network === 'bsky' ? counts.get(c.tweet.author.id) : undefined
          if (n !== undefined) c.tweet.author.followers = n
        }
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

    const bskyCount = all.filter((c) => c.tweet.network === 'bsky').length
    if (bskyOn) notes.push(`${bskyCount} candidates came from Bluesky, ${chosen.filter((x) => x.tweet.network === 'bsky').length} chosen.`)
    const hAuc = auc(history, (h) => h.heuristic)
    const cAuc = auc(history, (h) => h.claude)
    if (hAuc !== null || cAuc !== null) notes.push(`Scorer AUC so far: heuristic ${fmt(hAuc)}, Claude ${fmt(cAuc)}; weights h=${weights.heuristic.toFixed(2)} c=${weights.claude.toFixed(2)}.`)
    report('Saving', `${chosen.length} posts`)
    let ed = createEdition(date, chosen, scored, notes.join(' '))
    if (s.autoTranslate && key) {
      try {
        const n = await translateTweets(chosen.map((x) => x.tweet), log, (d, t) => report('Translating', `${d}/${t}`))
        if (n) {
          log(`translated ${n} posts`)
          ed = getEditionByDate(date) ?? ed // re-read, so the items carry their translations
        }
      } catch (e) {
        log('translation failed: ' + String(e))
      }
    }
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
