import type { DmConversation, DmMessage, DmSummary } from '@shared/types'
import { getKv, setKv } from './db'
import * as official from './x/official'
import { ensureUserId } from './x/actions'

/** Users looked up by ID earlier, so each costs one API request ever. */
function knownUsers(): Map<string, official.RawUser> {
  const raw = getKv('dmUsers')
  return new Map(raw ? (JSON.parse(raw) as official.RawUser[]).map((u) => [u.id, u]) : [])
}

export async function refreshDms(log: (m: string) => void): Promise<DmSummary> {
  official.setLogger(log)
  try {
    const myId = await ensureUserId()
    const users = knownUsers()
    const events: official.RawDmEvent[] = []
    let next: string | undefined
    for (let page = 0; page < 3; page++) {
      const r = await official.dmEvents(next)
      r.users.forEach((u) => users.set(u.id, u))
      events.push(...r.events)
      next = r.next
      if (!next) break
    }
    const convs = new Map<string, DmConversation>()
    for (const e of events) {
      if (!e.text) continue
      const c = convs.get(e.dm_conversation_id) ?? { id: e.dm_conversation_id, participants: [], lastAt: e.created_at, messages: [] }
      const urls = (e.entities?.urls ?? []).map((u) => ({ short: u.url, expanded: u.expanded_url ?? u.url, display: u.display_url ?? u.expanded_url ?? u.url }))
      const tweetIds = new Set<string>((e.referenced_tweets ?? []).map((r) => r.id))
      for (const u of urls) {
        const m = u.expanded.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/(\d+)/)
        if (m) tweetIds.add(m[1])
      }
      const msg: DmMessage = { id: e.id, conversationId: e.dm_conversation_id, senderId: e.sender_id ?? '', text: e.text, createdAt: e.created_at, mine: e.sender_id === myId, urls, tweetIds: [...tweetIds] }
      c.messages.push(msg)
      if (e.created_at > c.lastAt) c.lastAt = e.created_at
      const ids = new Set<string>(c.participants.map((p) => p.id))
      // A one-to-one conversation's id is the two user ids joined by a dash; the other id names the person even when only you have spoken.
      const fromConvId = e.dm_conversation_id.split('-').filter((x) => /^\d+$/.test(x) && x !== myId)
      for (const pid of [...(e.participant_ids ?? []), e.sender_id ?? '', ...fromConvId]) {
        if (!pid || pid === myId || ids.has(pid)) continue
        const u = users.get(pid)
        ids.add(pid)
        c.participants.push({ id: pid, handle: u?.username ?? pid, name: u?.name ?? '', avatar: (u?.profile_image_url ?? '').replace('_normal.', '_bigger.') })
      }
      convs.set(c.id, c)
    }
    // Name anyone the events did not describe, and remember them.
    const unnamed = [...convs.values()].flatMap((c) => c.participants.filter((p) => p.handle === p.id).map((p) => p.id))
    if (unnamed.length) {
      try {
        const found = await official.usersByIds([...new Set(unnamed)])
        found.forEach((u) => users.set(u.id, u))
        for (const c of convs.values()) {
          for (const p of c.participants) {
            const u = users.get(p.id)
            if (u && p.handle === p.id) Object.assign(p, { handle: u.username, name: u.name, avatar: (u.profile_image_url ?? '').replace('_normal.', '_bigger.') })
          }
        }
      } catch (e) {
        log('dm user lookup failed: ' + String(e))
      }
    }
    setKv('dmUsers', JSON.stringify([...users.values()]))
    const conversations = [...convs.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    conversations.forEach((c) => c.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    const out: DmSummary = { conversations, fetchedAt: new Date().toISOString() }
    setKv('dms', JSON.stringify(out))
    log(`dms: ${conversations.length} conversations, ${events.length} events`)
    return out
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    log('dms failed: ' + err)
    const cached = cachedDms()
    let hint = err
    if (e instanceof official.XApiError && (e.status === 403 || e.status === 402)) {
      hint = `${err}. Direct-message endpoints are not included in every X API plan; last known, they need the Basic tier or above.`
    }
    return { ...cached, error: hint }
  }
}

export function cachedDms(): DmSummary {
  const raw = getKv('dms')
  return raw ? (JSON.parse(raw) as DmSummary) : { conversations: [], fetchedAt: null }
}

export async function sendDm(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await official.sendDm(conversationId, text)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
