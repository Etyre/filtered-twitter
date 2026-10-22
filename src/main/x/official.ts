// Official X API v2 with OAuth 1.0a user context. This is the ONLY thing that
// ever touches your real account.
import { createHmac, randomBytes } from 'crypto'
import { readSecret } from '../settings'

interface Creds { consumerKey: string; consumerSecret: string; accessToken: string; accessSecret: string }

export function getCreds(): Creds | null {
  const consumerKey = readSecret('xConsumerKey')
  const consumerSecret = readSecret('xConsumerSecret')
  const accessToken = readSecret('xAccessToken')
  const accessSecret = readSecret('xAccessSecret')
  if (!consumerKey || !consumerSecret || !accessToken || !accessSecret) return null
  return { consumerKey, consumerSecret, accessToken, accessSecret }
}

const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

function authHeader(method: string, url: string, creds: Creds): string {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0'
  }
  const u = new URL(url)
  const all: [string, string][] = Object.entries(params).map(([k, v]) => [enc(k), enc(v)])
  u.searchParams.forEach((v, k) => all.push([enc(k), enc(v)]))
  all.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  const paramStr = all.map(([k, v]) => `${k}=${v}`).join('&')
  const base = [method.toUpperCase(), enc(u.origin + u.pathname), enc(paramStr)].join('&')
  const key = `${enc(creds.consumerSecret)}&${enc(creds.accessSecret)}`
  const sig = createHmac('sha1', key).update(base).digest('base64')
  params.oauth_signature = sig
  return 'OAuth ' + Object.keys(params).sort().map((k) => `${enc(k)}="${enc(params[k])}"`).join(', ')
}

export class XApiError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(`X API ${status}: ${msg}`)
    this.status = status
  }
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const creds = getCreds()
  if (!creds) throw new Error('X API keys are not configured (Settings → Your account).')
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader(method, url, creds), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const j = json as { detail?: string; title?: string; errors?: { message?: string }[] } | null
    const msg = j?.detail || j?.title || j?.errors?.[0]?.message || text.slice(0, 200) || res.statusText
    throw new XApiError(res.status, msg)
  }
  return json as T
}

export async function me(): Promise<{ id: string; username: string }> {
  const r = await call<{ data: { id: string; username: string } }>('GET', 'https://api.x.com/2/users/me')
  return r.data
}

/** Public profile fields for up to 100 user IDs (one request). */
export async function usersByIds(ids: string[]): Promise<RawUser[]> {
  if (!ids.length) return []
  const u = new URL('https://api.x.com/2/users')
  u.searchParams.set('ids', ids.slice(0, 100).join(','))
  u.searchParams.set('user.fields', 'id,username,name,profile_image_url')
  const r = await call<{ data?: RawUser[] }>('GET', u.toString())
  return r.data ?? []
}

export async function createPost(text: string, replyToId?: string): Promise<string> {
  const body: Record<string, unknown> = { text }
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId }
  const r = await call<{ data: { id: string } }>('POST', 'https://api.x.com/2/tweets', body)
  return r.data.id
}

export async function like(userId: string, tweetId: string): Promise<void> {
  await call('POST', `https://api.x.com/2/users/${userId}/likes`, { tweet_id: tweetId })
}

export async function unlike(userId: string, tweetId: string): Promise<void> {
  await call('DELETE', `https://api.x.com/2/users/${userId}/likes/${tweetId}`)
}

export async function retweet(userId: string, tweetId: string): Promise<void> {
  await call('POST', `https://api.x.com/2/users/${userId}/retweets`, { tweet_id: tweetId })
}

// ---------- Direct messages (requires a plan that includes DM endpoints) ----------
export interface RawDmEvent {
  id: string
  event_type: string
  text?: string
  created_at: string
  sender_id?: string
  dm_conversation_id: string
  participant_ids?: string[]
  entities?: { urls?: { url: string; expanded_url?: string; display_url?: string }[] }
  referenced_tweets?: { type: string; id: string }[]
}
export interface RawUser { id: string; username: string; name: string; profile_image_url?: string }

let log: (m: string) => void = () => {}
export function setLogger(fn: (m: string) => void): void {
  log = fn
}

export async function dmEvents(paginationToken?: string): Promise<{ events: RawDmEvent[]; users: RawUser[]; next?: string }> {
  const u = new URL('https://api.x.com/2/dm_events')
  u.searchParams.set('max_results', '100')
  u.searchParams.set('event_types', 'MessageCreate')
  u.searchParams.set('dm_event.fields', 'id,text,event_type,created_at,sender_id,dm_conversation_id,participant_ids,entities,referenced_tweets')
  u.searchParams.set('expansions', 'sender_id,participant_ids,referenced_tweets.id')
  u.searchParams.set('user.fields', 'id,username,name,profile_image_url')
  if (paginationToken) u.searchParams.set('pagination_token', paginationToken)
  const r = await call<{ data?: RawDmEvent[]; includes?: { users?: RawUser[] }; meta?: { next_token?: string; result_count?: number } }>('GET', u.toString())
  const events = r.data ?? []
  const dates = events.map((e) => e.created_at).sort()
  log(`dm_events page: ${events.length} events (meta ${r.meta?.result_count ?? '?'}), ${dates[0] ?? '-'} to ${dates[dates.length - 1] ?? '-'}, next ${r.meta?.next_token ? 'yes' : 'no'}`)
  return { events, users: r.includes?.users ?? [], next: r.meta?.next_token }
}

export async function sendDm(conversationId: string, text: string): Promise<void> {
  await call('POST', `https://api.x.com/2/dm_conversations/${conversationId}/messages`, { text })
}
