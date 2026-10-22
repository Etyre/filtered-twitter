// Claude-based scorer: rates candidate tweets against the user's interest
// profile plus recent up/down votes as examples.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type { Category, Tweet } from '@shared/types'
import type { VoteRecord } from '../db'

const Rating = z.object({
  id: z.string(),
  score: z.number().min(0).max(100),
  category: z.enum(['breaking_news', 'interesting', 'discourse', 'personal', 'skip']),
  reason: z.string()
})
const Output = z.object({ ratings: z.array(Rating) })

export interface ClaudeRating {
  score: number // 0..1
  category: Category
  reason: string
}

export interface ClaudeScorerOpts {
  apiKey: string
  model: string
  profile: string
  history: VoteRecord[]
  priorityHandles: string[]
  log: (m: string) => void
  onProgress?: (done: number, total: number) => void
}

function fmtTweet(t: Tweet, extra = ''): string {
  const parts = [`[${t.id}] @${t.author.handle} (${t.author.name})${extra}`]
  if (t.retweetedBy) parts[0] += ` [reposted by @${t.retweetedBy.handle}]`
  parts.push(t.text.replace(/\s+/g, ' ').slice(0, 700))
  if (t.quoted) parts.push(`  ↳ quoting @${t.quoted.author.handle}: ${t.quoted.text.replace(/\s+/g, ' ').slice(0, 240)}`)
  const stats = `  (${t.likes} likes, ${t.reposts} reposts, ${t.replies} replies${t.media.length ? ', has media' : ''}${t.inReplyToId ? ', is a reply' : ''})`
  parts.push(stats)
  return parts.join('\n')
}

function buildSystem(opts: ClaudeScorerOpts): string {
  const ups = opts.history.filter((h) => h.vote > 0 || h.replied).slice(0, 40)
  const downs = opts.history.filter((h) => h.vote < 0).slice(0, 40)
  const ex = (rows: VoteRecord[]): string => rows.map((h) => `- @${h.tweet.author.handle}: ${h.tweet.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
  return [
    `You curate a strictly limited daily reading list of posts from X (Twitter) for one person. They want to stay engaged with the world without being addicted, so the list must earn every slot: important things they would regret missing, and small things they would genuinely enjoy. Everything else is skipped.`,
    ``,
    `## Their interest profile`,
    opts.profile.trim(),
    opts.priorityHandles.length ? `\nAccounts they explicitly prioritize: ${opts.priorityHandles.map((h) => '@' + h).join(', ')}` : '',
    ups.length ? `\n## Posts they upvoted or replied to recently (positive examples)\n${ex(ups)}` : '',
    downs.length ? `\n## Posts they downvoted recently (negative examples)\n${ex(downs)}` : '',
    ``,
    `## Scoring`,
    `For each candidate return a score from 0 to 100 for how much this person would want it in today's list, a category, and a short reason (under 12 words).`,
    `- 85-100: important breaking news or something they would clearly want to see or engage with.`,
    `- 60-84: genuinely interesting, well worth one of the limited slots.`,
    `- 30-59: fine but forgettable.`,
    `- 0-29: noise, bait, repetitive, off-topic, or low effort.`,
    `Categories: breaking_news (big consequential news), interesting (substantive or delightful), discourse (ongoing debate they may want to weigh in on), personal (updates from people they know or follow closely), skip.`,
    `Judge content, not popularity. Many candidates will restate the same news; score the best-sourced one highest and the restatements low. Return one rating per candidate id, no more and no fewer.`
  ].join('\n')
}

export async function scoreWithClaude(tweets: Tweet[], opts: ClaudeScorerOpts): Promise<Map<string, ClaudeRating>> {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3 })
  const system = buildSystem(opts)
  const out = new Map<string, ClaudeRating>()
  const BATCH = 30
  const batches: Tweet[][] = []
  for (let i = 0; i < tweets.length; i += BATCH) batches.push(tweets.slice(i, i + BATCH))
  let done = 0
  // modest concurrency to stay under rate limits
  const CONC = 3
  const worker = async (): Promise<void> => {
    while (batches.length) {
      const batch = batches.shift()!
      try {
        const res = await client.messages.parse({
          model: opts.model,
          max_tokens: 16000,
          output_config: { effort: 'low', format: zodOutputFormat(Output) },
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: `Candidates:\n\n${batch.map((t) => fmtTweet(t)).join('\n\n')}` }]
        })
        if (res.stop_reason === 'refusal') {
          opts.log(`claude refusal (${res.stop_details?.category ?? 'unknown'})`)
        }
        const parsed = res.parsed_output
        if (parsed) {
          for (const r of parsed.ratings) {
            out.set(r.id, { score: Math.max(0, Math.min(100, r.score)) / 100, category: r.category, reason: r.reason })
          }
        }
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API key was rejected.')
        if (e instanceof Anthropic.RateLimitError) opts.log('claude rate limited; batch skipped')
        else if (e instanceof Anthropic.APIError) opts.log(`claude API error ${e.status}: ${e.message}`)
        else opts.log('claude error: ' + String(e))
      }
      done += batch.length
      opts.onProgress?.(Math.min(done, tweets.length), tweets.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, worker))
  return out
}
