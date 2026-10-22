// Local, no-LLM scorer. Learns per-author and per-token preferences from votes.
import type { Tweet } from '@shared/types'
import type { VoteRecord } from '../db'

export interface HeuristicModel {
  authorScore: Map<string, number> // smoothed mean vote in [-1, 1]
  tokenLogOdds: Map<string, number>
  authorsLearned: number
  tokensLearned: number
}

const AI_TERMS = [
  'ai', 'agi', 'llm', 'model', 'openai', 'anthropic', 'claude', 'gpt', 'gemini', 'deepmind', 'llama', 'mistral',
  'alignment', 'safety', 'benchmark', 'compute', 'gpu', 'nvidia', 'transformer', 'rl', 'agent', 'agents',
  'inference', 'training', 'frontier', 'superintelligence', 'interpretability', 'eval', 'evals', 'scaling'
]
const STOP = new Set(
  'the a an and or of to in on for with is are was were be been it this that these those i you he she they we at by from as not but if then than so do does did have has had my your our their its about just like more very can will would should could into out up down over under again'.split(' ')
)

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9@#'\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
}

export function trainHeuristic(history: VoteRecord[]): HeuristicModel {
  const authorSum = new Map<string, { s: number; n: number }>()
  const tokPos = new Map<string, number>()
  const tokNeg = new Map<string, number>()
  let pos = 0
  let neg = 0
  for (const h of history) {
    // implicit signals: reply = strong positive, open = weak positive
    let v = h.vote as number
    if (h.replied) v = Math.max(v, 1)
    else if (h.opened && v === 0) v = 0.4
    if (v === 0) continue
    const handle = h.tweet.author.handle.toLowerCase()
    const a = authorSum.get(handle) ?? { s: 0, n: 0 }
    a.s += v
    a.n += 1
    authorSum.set(handle, a)
    const toks = new Set(tokenize(h.tweet.text))
    if (v > 0) {
      pos++
      toks.forEach((t) => tokPos.set(t, (tokPos.get(t) ?? 0) + 1))
    } else {
      neg++
      toks.forEach((t) => tokNeg.set(t, (tokNeg.get(t) ?? 0) + 1))
    }
  }
  const authorScore = new Map<string, number>()
  for (const [h, a] of authorSum) authorScore.set(h, a.s / (a.n + 2)) // shrink toward 0
  const tokenLogOdds = new Map<string, number>()
  const vocab = new Set([...tokPos.keys(), ...tokNeg.keys()])
  for (const t of vocab) {
    const p = (tokPos.get(t) ?? 0) + 1
    const n = (tokNeg.get(t) ?? 0) + 1
    const lo = Math.log(p / (pos + 2)) - Math.log(n / (neg + 2))
    if (Math.abs(lo) > 0.4 && p + n >= 3) tokenLogOdds.set(t, lo)
  }
  return { authorScore, tokenLogOdds, authorsLearned: authorScore.size, tokensLearned: tokenLogOdds.size }
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

export interface HeuristicInput {
  tweet: Tweet
  isPriority: boolean
  isFollowing: boolean
  source: string
}

/** Returns a score in [0,1]. */
export function scoreHeuristic(inp: HeuristicInput, model: HeuristicModel, now = Date.now()): number {
  const t = inp.tweet
  let x = 0
  // engagement, log-scaled; views are noisy so weighted lightly
  x += 0.35 * Math.log10(1 + t.likes) + 0.15 * Math.log10(1 + t.reposts) + 0.1 * Math.log10(1 + t.replies)
  if (t.author.followers) x -= 0.15 * Math.log10(1 + t.author.followers) // normalize for audience size
  // recency within the window (hours)
  const ageH = Math.max(0, (now - new Date(t.createdAt).getTime()) / 3.6e6)
  x -= 0.02 * ageH
  // structure
  if (t.inReplyToId) x -= 0.8
  if (t.retweetedBy) x -= 0.3
  if (t.text.length > 180) x += 0.3
  if (t.media.length) x += 0.1
  if (t.quoted) x += 0.1
  if (/^(rt|gm|gn)\b/i.test(t.text) || t.text.length < 25) x -= 0.5
  // topical prior
  const toks = tokenize(t.text)
  const ai = toks.filter((k) => AI_TERMS.includes(k)).length
  x += Math.min(1.2, 0.4 * ai)
  // learned
  const a = model.authorScore.get(t.author.handle.toLowerCase())
  if (a !== undefined) x += 2.0 * a
  let tok = 0
  const seen = new Set<string>()
  for (const k of toks) {
    if (seen.has(k)) continue
    seen.add(k)
    tok += model.tokenLogOdds.get(k) ?? 0
  }
  x += Math.max(-2, Math.min(2, tok * 0.5))
  // source
  if (inp.isPriority) x += 1.5
  else if (inp.isFollowing) x += 0.5
  if (inp.source === 'search') x -= 0.2
  return sigmoid(x - 1.2)
}
