// Parsers for X's internal GraphQL / REST JSON. We deep-walk responses for tweet
// objects rather than relying on exact timeline shapes, which change often.
import type { Author, Media, Notification, Poll, Tweet } from '@shared/types'

type Any = Record<string, unknown>
const isObj = (v: unknown): v is Any => !!v && typeof v === 'object' && !Array.isArray(v)

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}
function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v) || 0
  return 0
}

export function parseUser(u: unknown): Author | null {
  if (!isObj(u)) return null
  let r: Any = u
  if (isObj(r.result)) r = r.result as Any
  if (r.__typename === 'UserUnavailable') return null
  const legacy = isObj(r.legacy) ? (r.legacy as Any) : {}
  const core = isObj(r.core) ? (r.core as Any) : {}
  const avatar = isObj(r.avatar) ? (r.avatar as Any) : {}
  const id = str(r.rest_id) || str(r.id_str) || str(r.id)
  const handle = str(core.screen_name) || str(legacy.screen_name) || str(r.screen_name)
  if (!id || !handle) return null
  const avatarUrl = str(avatar.image_url) || str(legacy.profile_image_url_https) || str(r.profile_image_url_https)
  return {
    id,
    handle,
    name: str(core.name) || str(legacy.name) || str(r.name) || handle,
    avatar: avatarUrl.replace('_normal.', '_bigger.'),
    verified: !!(r.is_blue_verified || legacy.verified || (isObj(r.verification) && (r.verification as Any).verified)),
    followers: num(legacy.followers_count ?? r.followers_count)
  }
}

function parseMedia(legacy: Any): Media[] {
  const ext = isObj(legacy.extended_entities) ? (legacy.extended_entities as Any) : isObj(legacy.entities) ? (legacy.entities as Any) : {}
  const list = Array.isArray(ext.media) ? (ext.media as Any[]) : []
  return list
    .map((m): Media | null => {
      const type = str(m.type) as Media['type']
      const url = str(m.media_url_https)
      if (!url) return null
      let videoUrl: string | undefined
      if (isObj(m.video_info) && Array.isArray((m.video_info as Any).variants)) {
        const variants = ((m.video_info as Any).variants as Any[])
          .filter((v) => str(v.content_type) === 'video/mp4')
          .sort((a, b) => num(b.bitrate) - num(a.bitrate))
        videoUrl = variants.length ? str(variants[0].url) : undefined
      }
      const sizes = isObj(m.original_info) ? (m.original_info as Any) : {}
      return { type: type || 'photo', url, videoUrl, width: num(sizes.width) || undefined, height: num(sizes.height) || undefined }
    })
    .filter((m): m is Media => !!m)
}

/** A poll lives in the post's card as flat binding values: choice1_label, choice1_count, …, end_datetime_utc, counts_are_final. */
function parsePoll(r: Any): Poll | undefined {
  const card = isObj(r.card) ? (r.card as Any) : null
  const cl = card && isObj(card.legacy) ? (card.legacy as Any) : card
  if (!cl) return undefined
  const name = str(cl.name)
  if (!/poll\d+choice/.test(name)) return undefined
  const values = new Map<string, string>()
  const raw = cl.binding_values
  const take = (key: string, v: unknown): void => {
    if (!isObj(v)) return
    const inner = isObj(v.value) ? (v.value as Any) : v
    const val = str(inner.string_value) || str(inner.boolean_value) || (inner.boolean_value === false ? 'false' : '')
    if (key) values.set(key, val)
  }
  if (Array.isArray(raw)) for (const b of raw) if (isObj(b)) take(str(b.key), b)
  else if (isObj(raw)) for (const k of Object.keys(raw)) take(k, raw[k])
  const options: Poll['options'] = []
  for (let i = 1; i <= 4; i++) {
    const label = values.get(`choice${i}_label`)
    if (!label) break
    options.push({ label, votes: num(values.get(`choice${i}_count`)) })
  }
  if (options.length < 2) return undefined
  const endsAt = values.get('end_datetime_utc')
  return {
    options,
    totalVotes: options.reduce((a, o) => a + o.votes, 0),
    endsAt: endsAt && !isNaN(Date.parse(endsAt)) ? new Date(endsAt).toISOString() : undefined,
    final: values.get('counts_are_final') === 'true'
  }
}

function expandText(text: string, legacy: Any, media: Media[]): { text: string; urls: Tweet['urls'] } {
  const entities = isObj(legacy.entities) ? (legacy.entities as Any) : {}
  const urls: Tweet['urls'] = []
  let out = text
  for (const u of Array.isArray(entities.urls) ? (entities.urls as Any[]) : []) {
    const short = str(u.url)
    const expanded = str(u.expanded_url)
    const display = str(u.display_url)
    if (!short) continue
    urls.push({ short, expanded, display })
    out = out.split(short).join(expanded || display || short)
  }
  // strip trailing media t.co links
  const mediaEnts = Array.isArray(entities.media) ? (entities.media as Any[]) : []
  for (const m of mediaEnts) {
    const short = str(m.url)
    if (short) out = out.split(short).join('')
  }
  void media
  return { text: out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(), urls }
}

/** Parse a single tweet result object (Tweet / TweetWithVisibilityResults). */
export function parseTweet(input: unknown, depth = 0): Tweet | null {
  if (!isObj(input) || depth > 3) return null
  let r: Any = input
  if (isObj(r.result)) r = r.result as Any
  if (r.__typename === 'TweetWithVisibilityResults' && isObj(r.tweet)) r = r.tweet as Any
  if (r.__typename === 'TweetTombstone' || r.__typename === 'TweetUnavailable') return null
  const legacy = isObj(r.legacy) ? (r.legacy as Any) : null
  if (!legacy) return null
  const id = str(r.rest_id) || str(legacy.id_str)
  if (!id) return null
  const core = isObj(r.core) ? (r.core as Any) : {}
  const author = parseUser(core.user_results)
  if (!author) return null

  // Retweet: surface the original, remember who reposted.
  const rtRes = isObj(legacy.retweeted_status_result) ? (legacy.retweeted_status_result as Any) : null
  if (rtRes) {
    const original = parseTweet(rtRes, depth + 1)
    if (original) {
      return { ...original, retweetedBy: author, retweetOf: undefined }
    }
  }

  let text = str(legacy.full_text) || str(legacy.text)
  const note = isObj(r.note_tweet) && isObj((r.note_tweet as Any).note_tweet_results) ? ((r.note_tweet as Any).note_tweet_results as Any) : null
  const noteResult = note && isObj(note.result) ? (note.result as Any) : null
  let noteLegacyLike: Any = legacy
  if (noteResult && str(noteResult.text)) {
    text = str(noteResult.text)
    noteLegacyLike = { ...legacy, entities: isObj(noteResult.entity_set) ? noteResult.entity_set : legacy.entities }
  }
  const media = parseMedia(legacy)
  const expanded = expandText(text, noteLegacyLike, media)

  const quoted = isObj(r.quoted_status_result) ? parseTweet(r.quoted_status_result, depth + 1) : null
  const poll = parsePoll(r)
  const views = isObj(r.views) ? num((r.views as Any).count) : 0
  const createdAt = new Date(str(legacy.created_at)).toISOString()
  return {
    id,
    conversationId: str(legacy.conversation_id_str) || id,
    text: expanded.text,
    createdAt,
    author,
    likes: num(legacy.favorite_count),
    reposts: num(legacy.retweet_count),
    replies: num(legacy.reply_count),
    quotes: num(legacy.quote_count),
    views,
    inReplyToId: str(legacy.in_reply_to_status_id_str) || undefined,
    inReplyToHandle: str(legacy.in_reply_to_screen_name) || undefined,
    media,
    quoted: quoted ?? undefined,
    poll,
    urls: expanded.urls,
    lang: str(legacy.lang) || undefined,
    liked: !!legacy.favorited
  }
}

/** Deep-walk any response and collect every tweet found. Order is document order. */
export function collectTweets(json: unknown): Tweet[] {
  const out: Tweet[] = []
  const seen = new Set<string>()
  const walk = (v: unknown, depth: number): void => {
    if (depth > 40) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (!isObj(v)) return
    if (v.__typename === 'Tweet' || v.__typename === 'TweetWithVisibilityResults') {
      const t = parseTweet(v)
      if (t && !seen.has(t.id)) {
        seen.add(t.id)
        out.push(t)
      }
      // still descend for quoted tweets
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1)
  }
  walk(json, 0)
  return out
}

/** Legacy REST shape (globalObjects) used by /i/api/2/notifications/*.json */
export function collectFromGlobalObjects(json: unknown): { tweets: Tweet[]; notifications: Notification[] } {
  if (!isObj(json) || !isObj(json.globalObjects)) return { tweets: [], notifications: [] }
  const go = json.globalObjects as Any
  const users = isObj(go.users) ? (go.users as Record<string, Any>) : {}
  const tweetsRaw = isObj(go.tweets) ? (go.tweets as Record<string, Any>) : {}
  const tweets: Tweet[] = []
  for (const id of Object.keys(tweetsRaw)) {
    const t = tweetsRaw[id]
    const u = users[str(t.user_id_str)]
    if (!u) continue
    // Shape the legacy object into the GraphQL-ish layout parseTweet expects.
    const shaped = { __typename: 'Tweet', rest_id: id, legacy: t, core: { user_results: { result: { rest_id: str(u.id_str), legacy: u } } } }
    const parsed = parseTweet(shaped)
    if (parsed) tweets.push(parsed)
  }
  const notifications: Notification[] = []
  const notifRaw = isObj(go.notifications) ? (go.notifications as Record<string, Any>) : {}
  for (const id of Object.keys(notifRaw)) {
    const n = notifRaw[id]
    const msg = isObj(n.message) ? (n.message as Any) : {}
    const icon = isObj(n.icon) ? str((n.icon as Any).id) : ''
    const fromHandles: string[] = []
    const ents = Array.isArray(msg.entities) ? (msg.entities as unknown[]) : []
    for (const e of Array.isArray(ents) ? ents : []) {
      const ref = isObj(e) && isObj(e.ref) && isObj((e.ref as Any).user) ? ((e.ref as Any).user as Any) : null
      if (ref) {
        const u = users[str(ref.id)]
        if (u) fromHandles.push(str(u.screen_name))
      }
    }
    const ts = num(n.timestampMs)
    notifications.push({
      id,
      kind: classifyIcon(icon),
      createdAt: new Date(ts || Date.now()).toISOString(),
      text: str(msg.text),
      fromHandles,
      read: false
    })
  }
  return { tweets, notifications }
}

export function classifyIcon(icon: string): Notification['kind'] {
  const i = icon.toLowerCase()
  if (i.includes('reply')) return 'reply'
  if (i.includes('mention') || i.includes('bird')) return 'mention'
  if (i.includes('quote') || i.includes('retweet_with_comment')) return 'quote'
  return 'other'
}

/** Count notification kinds (likes/reposts/follows) from a REST or GraphQL notification payload. */
export function countNotificationKinds(json: unknown): { likes: number; reposts: number; follows: number; other: number } {
  const counts = { likes: 0, reposts: 0, follows: 0, other: 0 }
  const walk = (v: unknown, depth: number): void => {
    if (depth > 40) return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
    if (!isObj(v)) return
    if (isObj(v.icon) && typeof (v.icon as Any).id === 'string') {
      const id = ((v.icon as Any).id as string).toLowerCase()
      if (id.includes('heart')) counts.likes++
      else if (id.includes('retweet') && !id.includes('comment')) counts.reposts++
      else if (id.includes('person')) counts.follows++
      else counts.other++
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1)
  }
  walk(json, 0)
  return counts
}
