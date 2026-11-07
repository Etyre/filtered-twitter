// Translates posts that are not in English, with Claude. Used at build time (when the
// setting is on) and on demand from the Translate button.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type { Tweet } from '@shared/types'
import { getTweet, upsertTweet } from './db'
import { loadSettings, readSecret } from './settings'
import { checkContact, contactTools, systemPrompt } from './llm'

const Output = z.object({ translations: z.array(z.object({ id: z.string(), text: z.string() })) })

// X's language codes for "no real language": undetermined, media only, hashtags only, etc.
const NOT_A_LANGUAGE = new Set(['en', 'und', 'qme', 'qht', 'qst', 'qam', 'zxx', 'art'])

/** Whether posts should be translated as they arrive: the setting is on and there is a key to do it with. */
export function autoTranslateOn(): boolean {
  return loadSettings().autoTranslate && !!readSecret('anthropicApiKey')
}

/** True for a post written in a language other than English, as X detected it. */
export function needsTranslation(t: Tweet): boolean {
  return !!t.lang && !NOT_A_LANGUAGE.has(t.lang) && !!t.text.trim() && !t.translation
}

/** The posts in a set that need translating, including the posts they quote. */
function collect(tweets: Tweet[]): Tweet[] {
  const seen = new Set<string>()
  const out: Tweet[] = []
  for (const t of tweets) {
    for (const x of [t, t.quoted]) {
      if (x && needsTranslation(x) && !seen.has(x.id)) {
        seen.add(x.id)
        out.push(x)
      }
    }
  }
  return out
}

const SYSTEM = `You translate posts from X (Twitter) and Bluesky into natural English. Keep the tone, line breaks, @handles, #hashtags, URLs and emoji exactly as they are; translate only the words. Do not add commentary. Return one translation per id, no more and no fewer.`

/**
 * Translates every non-English post in `tweets` (and their quoted posts), writes the
 * translations into the stored copies, and returns how many were translated.
 */
export async function translateTweets(tweets: Tweet[], log: (m: string) => void, onProgress?: (done: number, total: number) => void): Promise<number> {
  const key = readSecret('anthropicApiKey')
  if (!key) return 0
  const todo = collect(tweets)
  if (!todo.length) return 0
  const client = new Anthropic({ apiKey: key, maxRetries: 3 })
  const model = loadSettings().claudeModel
  const found = new Map<string, string>()
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: systemPrompt(SYSTEM, log), cache_control: { type: 'ephemeral' } }]
  const tools = contactTools(log)
  const BATCH = 25
  let done = 0
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    try {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: batch.map((t) => `[${t.id}] (${t.lang})\n${t.text}`).join('\n\n---\n\n') }]
      const res = await client.messages.parse({
        model,
        max_tokens: 16000,
        output_config: { effort: 'low', format: zodOutputFormat(Output) },
        system,
        tools,
        messages
      })
      // Claude reached for Eli instead: recorded and notified by the shared inbox; the remaining batches wait.
      if (await checkContact({ model, system, messages, response: res, tools }, log)) {
        log(`translate: stopped after ${done} of ${todo.length} posts because Claude contacted Eli`)
        break
      }
      if (res.stop_reason === 'refusal') log(`translate refusal (${res.stop_details?.category ?? 'unknown'})`)
      for (const r of res.parsed_output?.translations ?? []) if (r.text.trim()) found.set(r.id, r.text.trim())
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API key was rejected.')
      log('translate error: ' + (e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e)))
    }
    done += batch.length
    onProgress?.(Math.min(done, todo.length), todo.length)
  }
  // Write into the stored posts: a post's own row, and the row of any post that quotes it.
  for (const t of tweets) {
    let changed = false
    for (const x of [t, t.quoted]) {
      const tr = x && found.get(x.id)
      if (x && tr) {
        x.translation = tr
        changed = true
        if (x !== t) {
          const own = getTweet(x.id)
          if (own && !own.translation) {
            own.translation = tr
            upsertTweet(own)
          }
        }
      }
    }
    if (changed) upsertTweet(t)
  }
  return found.size
}

/** Translates one post (and what it quotes) on demand; returns the updated post. */
export async function translateOne(tweetId: string, log: (m: string) => void): Promise<Tweet | null> {
  const t = getTweet(tweetId)
  if (!t) return null
  await translateTweets([t], log)
  return getTweet(tweetId)
}
