// Turns Bluesky API views into the app's Tweet shape, so one post model serves both networks.
import { AppBskyEmbedExternal, AppBskyEmbedImages, AppBskyEmbedRecord, AppBskyEmbedRecordWithMedia, AppBskyEmbedVideo, AppBskyFeedDefs, type AppBskyActorDefs } from '@atproto/api'
import type { Author, LinkCard, Media, Tweet } from '@shared/types'

type Any = Record<string, unknown>
const isObj = (v: unknown): v is Any => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function toAuthor(p: AppBskyActorDefs.ProfileViewBasic | AppBskyActorDefs.ProfileView): Author {
  const v = (p as { verification?: { verifiedStatus?: string } }).verification
  return { id: p.did, handle: p.handle, name: p.displayName || p.handle, avatar: p.avatar ?? '', verified: v?.verifiedStatus === 'valid' }
}

/** The post's text with each shortened link replaced by the full URL its facet points to. */
function expandFacets(text: string, facets: unknown): { text: string; urls: Tweet['urls'] } {
  const urls: Tweet['urls'] = []
  if (!Array.isArray(facets)) return { text, urls }
  const buf = Buffer.from(text, 'utf8')
  const spans: { start: number; end: number; uri: string }[] = []
  for (const f of facets as Any[]) {
    const idx = isObj(f.index) ? (f.index as Any) : null
    const link = Array.isArray(f.features) ? (f.features as Any[]).find((x) => x.$type === 'app.bsky.richtext.facet#link') : undefined
    if (!idx || !link || typeof idx.byteStart !== 'number' || typeof idx.byteEnd !== 'number') continue
    spans.push({ start: idx.byteStart, end: idx.byteEnd, uri: str(link.uri) })
  }
  spans.sort((a, b) => b.start - a.start)
  let out = buf
  for (const s of spans) {
    if (!s.uri || s.start < 0 || s.end > out.length || s.start >= s.end) continue
    const shown = out.subarray(s.start, s.end).toString('utf8')
    urls.unshift({ short: shown, expanded: s.uri, display: shown })
    out = Buffer.concat([out.subarray(0, s.start), Buffer.from(s.uri, 'utf8'), out.subarray(s.end)])
  }
  return { text: out.toString('utf8'), urls }
}

interface Embedded { media: Media[]; card?: LinkCard; quoted?: Tweet }

/** Pictures, a video, a link card, or a quoted post: whatever the post embeds. */
function parseEmbed(embed: unknown, depth: number): Embedded {
  const out: Embedded = { media: [] }
  if (!embed) return out
  // The guards only check $type, so each branch casts to the view it has recognised.
  if (AppBskyEmbedImages.isView(embed)) {
    for (const im of (embed as AppBskyEmbedImages.View).images) out.media.push({ type: 'photo', url: im.fullsize, width: im.aspectRatio?.width, height: im.aspectRatio?.height })
  } else if (AppBskyEmbedVideo.isView(embed)) {
    // The stream is HLS, which the card plays through hls.js.
    const v = embed as AppBskyEmbedVideo.View
    out.media.push({ type: 'video', url: v.thumbnail ?? '', videoUrl: v.playlist, width: v.aspectRatio?.width, height: v.aspectRatio?.height })
  } else if (AppBskyEmbedExternal.isView(embed)) {
    const e = (embed as AppBskyEmbedExternal.View).external
    out.card = { url: e.uri, title: e.title || e.uri, description: e.description ?? '', image: e.thumb }
  } else if (AppBskyEmbedRecord.isView(embed)) {
    const rec = (embed as AppBskyEmbedRecord.View).record
    if (depth === 0 && AppBskyEmbedRecord.isViewRecord(rec)) out.quoted = viewRecordToTweet(rec as AppBskyEmbedRecord.ViewRecord)
  } else if (AppBskyEmbedRecordWithMedia.isView(embed)) {
    const rwm = embed as AppBskyEmbedRecordWithMedia.View
    const m = parseEmbed(rwm.media, depth)
    out.media = m.media
    out.card = m.card
    if (depth === 0 && AppBskyEmbedRecord.isViewRecord(rwm.record.record)) out.quoted = viewRecordToTweet(rwm.record.record as AppBskyEmbedRecord.ViewRecord)
  }
  return out
}

/** createdAt is whatever the author's client said; a post cannot really be newer than when the network saw it. */
function when(record: Any, indexedAt: string): string {
  const c = new Date(str(record.createdAt)).getTime()
  const i = new Date(indexedAt).getTime()
  if (!Number.isFinite(c)) return indexedAt
  return c > i + 60_000 ? indexedAt : new Date(c).toISOString()
}

function base(uri: string, cid: string, author: Author, record: Any, indexedAt: string, counts: { likes?: number; reposts?: number; replies?: number; quotes?: number }): Tweet {
  const { text, urls } = expandFacets(str(record.text), record.facets)
  const reply = isObj(record.reply) ? (record.reply as Any) : null
  const root = reply && isObj(reply.root) ? str((reply.root as Any).uri) : ''
  const parent = reply && isObj(reply.parent) ? str((reply.parent as Any).uri) : ''
  const langs = Array.isArray(record.langs) ? (record.langs as unknown[]).map(str).filter(Boolean) : []
  return {
    id: uri, network: 'bsky', cid, conversationId: root || uri, text, createdAt: when(record, indexedAt), author,
    likes: counts.likes ?? 0, reposts: counts.reposts ?? 0, replies: counts.replies ?? 0, quotes: counts.quotes ?? 0, views: 0,
    inReplyToId: parent || undefined, media: [], urls, lang: langs[0]?.slice(0, 2)
  }
}

function viewRecordToTweet(r: AppBskyEmbedRecord.ViewRecord): Tweet {
  const t = base(r.uri, r.cid, toAuthor(r.author), r.value as Any, r.indexedAt, { likes: r.likeCount, reposts: r.repostCount, replies: r.replyCount, quotes: r.quoteCount })
  const e = parseEmbed(r.embeds?.[0], 1)
  t.media = e.media
  t.card = e.card
  return t
}

export function postToTweet(p: AppBskyFeedDefs.PostView): Tweet {
  const t = base(p.uri, p.cid, toAuthor(p.author), p.record as Any, p.indexedAt, { likes: p.likeCount, reposts: p.repostCount, replies: p.replyCount, quotes: p.quoteCount })
  const e = parseEmbed(p.embed, 0)
  t.media = e.media
  t.card = e.card
  t.quoted = e.quoted
  if (p.viewer?.like) t.liked = true
  if (p.viewer?.repost) t.reposted = true
  return t
}

/** A timeline or profile feed item: the post, who it answers, and who reposted it into the feed. */
export function feedItemToTweet(item: AppBskyFeedDefs.FeedViewPost): Tweet {
  const t = postToTweet(item.post)
  const parent = item.reply?.parent
  if (parent && AppBskyFeedDefs.isPostView(parent)) {
    t.inReplyToId = parent.uri
    t.inReplyToHandle = parent.author.handle
  }
  if (item.reason && AppBskyFeedDefs.isReasonRepost(item.reason)) t.retweetedBy = toAuthor(item.reason.by)
  return t
}
