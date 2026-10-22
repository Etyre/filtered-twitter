// Learns how much to trust each scorer from the user's votes. A tiny logistic
// regression on [heuristic, claude] -> upvote, refit whenever an edition is built.
import type { VoteRecord } from '../db'

export interface Weights { bias: number; heuristic: number; claude: number }

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

function label(h: VoteRecord): number | null {
  if (h.vote > 0 || h.replied) return 1
  if (h.vote < 0) return 0
  return null
}

export function fitWeights(history: VoteRecord[], prior: Weights): Weights {
  const rows = history
    .map((h) => ({ y: label(h), h: h.heuristic, c: h.claude }))
    .filter((r): r is { y: number; h: number; c: number } => r.y !== null && r.c !== null && r.c !== undefined)
  const pos = rows.filter((r) => r.y === 1).length
  const neg = rows.length - pos
  if (rows.length < 12 || pos < 4 || neg < 4) return prior
  // Center features so bias is interpretable; L2 toward the equal-weight prior.
  let w = { bias: 0, heuristic: 1, claude: 1 }
  const lr = 0.5
  const l2 = 0.02
  for (let it = 0; it < 400; it++) {
    let gb = 0
    let gh = 0
    let gc = 0
    for (const r of rows) {
      const p = sigmoid(w.bias + w.heuristic * (r.h - 0.5) * 4 + w.claude * (r.c - 0.5) * 4)
      const err = p - r.y
      gb += err
      gh += err * (r.h - 0.5) * 4
      gc += err * (r.c - 0.5) * 4
    }
    const n = rows.length
    w = {
      bias: w.bias - lr * (gb / n),
      heuristic: w.heuristic - lr * (gh / n + l2 * (w.heuristic - 1)),
      claude: w.claude - lr * (gc / n + l2 * (w.claude - 1))
    }
  }
  // never let a scorer go negative (that would mean "inverted"), clamp for sanity
  return { bias: w.bias, heuristic: Math.max(0.05, Math.min(4, w.heuristic)), claude: Math.max(0.05, Math.min(4, w.claude)) }
}

export function blend(h: number, c: number | null, w: Weights): number {
  if (c === null) return h
  return sigmoid(w.bias + w.heuristic * (h - 0.5) * 4 + w.claude * (c - 0.5) * 4)
}

/** Area under ROC curve of a scorer against votes. null if not enough data. */
export function auc(history: VoteRecord[], pick: (h: VoteRecord) => number | null): number | null {
  const rows = history
    .map((h) => ({ y: label(h), s: pick(h) }))
    .filter((r): r is { y: number; s: number } => r.y !== null && r.s !== null && r.s !== undefined)
  const pos = rows.filter((r) => r.y === 1)
  const neg = rows.filter((r) => r.y === 0)
  if (pos.length < 3 || neg.length < 3) return null
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p.s > n.s ? 1 : p.s === n.s ? 0.5 : 0
  return wins / (pos.length * neg.length)
}
