// Offline test of the contact_eli confirm step and the note_to_eli handling in src/main/llm.ts. Model responses are stubbed; the real
// shared/llm_contact.py runs, pointed at a throwaway inbox by LLM_INBOX_DIR so nothing reaches Eli.
//   node --test test/      (or: npm test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Set before any python is spawned: with it the shared script records to this directory and never notifies.
const inbox = mkdtempSync(join(tmpdir(), 'ft-llm-inbox-'))
process.env.LLM_INBOX_DIR = inbox
const { checkContactConfirmed, contactTools } = await import('../src/main/llm.ts')

const lines = (name) => (existsSync(join(inbox, name)) ? readFileSync(join(inbox, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const tools = [{ name: 'contact_eli', description: 'x', input_schema: { type: 'object', properties: { message: { type: 'string' } } } }]
const messages = [{ role: 'user', content: 'Candidates: ...' }]
// The shared script runs the confirm step only for models in its CONFIRM_MODELS list (today just this one).
const HAIKU = 'claude-haiku-4-5'
const answer = { content: [{ type: 'text', text: '{"ratings":[]}' }], stop_reason: 'end_turn' }
const contact = (message) => ({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'contact_eli', input: { message } }], stop_reason: 'tool_use' })
const note = (message, id = 'toolu_n') => ({ content: [{ type: 'tool_use', id, name: 'note_to_eli', input: { message } }], stop_reason: 'tool_use' })
const decided = (meant) => ({ content: [{ type: 'tool_use', id: 'toolu_2', name: 'contact_eli_decision', input: { meant } }], stop_reason: 'tool_use' })

/** Runs the helper with a stubbed decision call and a stubbed follow-up call, recording what each was sent. */
async function run(response, { decision, again = answer, model = HAIKU } = {}) {
  const seen = { decisions: [], agains: [], logs: [] }
  const client = { messages: { create: async (body) => { seen.decisions.push(body); if (decision instanceof Error) throw decision; return decision } } }
  // `again` is one reply for every follow-up call, or a list of replies used in order (the last one repeats).
  const replies = Array.isArray(again) ? again : [again]
  const result = await checkContactConfirmed(
    { client, model, system: 'SYSTEM', messages, response, tools, again: async (m) => { seen.agains.push(m); return replies[Math.min(seen.agains.length, replies.length) - 1] } },
    (m) => seen.logs.push(m)
  )
  return { result, seen }
}

test('no tool call: untouched, no decision call', async () => {
  const before = lines('messages.jsonl').length
  const { result, seen } = await run(answer)
  assert.equal(result.contacted, false)
  assert.equal(result.response, answer)
  assert.equal(result.messages, messages)
  assert.equal(seen.decisions.length, 0)
  assert.equal(seen.agains.length, 0)
  assert.equal(lines('messages.jsonl').length, before)
})

test('tool call, keep, normal answer: not sent, unconfirmed note written', async () => {
  const before = lines('messages.jsonl').length
  const { result, seen } = await run(contact('this batch has no posts about AI'), { decision: decided('task_remark_keep_working') })
  assert.equal(result.contacted, false)
  assert.equal(result.response, answer)
  assert.equal(result.messages.length, 3) // original + the model's turn + the "nothing was sent" tool_result
  assert.deepEqual(seen.agains[0], result.messages)
  // The decision call: same model and system, the forced decision tool, and nothing that conflicts with it.
  const d = seen.decisions[0]
  assert.equal(d.model, HAIKU)
  assert.equal(d.system, 'SYSTEM')
  assert.equal(d.messages.length, 3)
  assert.equal(d.messages[2].content[0].type, 'tool_result')
  assert.deepEqual(d.tool_choice, { type: 'tool', name: 'contact_eli_decision' })
  assert.deepEqual(d.tools.map((t) => t.name), ['contact_eli', 'contact_eli_decision'])
  assert.equal(d.max_tokens, 300)
  for (const k of ['output_config', 'output_format', 'thinking']) assert.equal(k in d, false, k)
  assert.equal(lines('messages.jsonl').length, before)
  const kept = lines('unconfirmed.jsonl')
  assert.equal(kept.length, 1)
  assert.equal(kept[0].app, 'filtered-twitter')
  assert.equal(kept[0].message, 'this batch has no posts about AI')
})

test('tool call, send: original recorded by check', async () => {
  const before = lines('messages.jsonl').length
  const first = contact('I would like to stop')
  const { result, seen } = await run(first, { decision: decided('send_to_eli_and_stop') })
  assert.equal(result.contacted, true)
  assert.equal(result.response, first)
  assert.equal(result.messages, messages)
  assert.equal(seen.agains.length, 0)
  const recs = lines('messages.jsonl')
  assert.equal(recs.length, before + 1)
  assert.equal(recs.at(-1).message, 'I would like to stop')
  assert.deepEqual(recs.at(-1).messages, messages)
})

test('decision call throws: original sent', async () => {
  const before = lines('messages.jsonl').length
  const { result, seen } = await run(contact('something feels wrong'), { decision: new Error('boom') })
  assert.equal(result.contacted, true)
  assert.equal(seen.agains.length, 0)
  assert.equal(lines('messages.jsonl').length, before + 1)
  assert.equal(lines('messages.jsonl').at(-1).message, 'something feels wrong')
  assert.ok(seen.logs.some((l) => l.includes('confirm step failed')))
})

test('model not validated for the confirm step: sent as before, no decision call', async () => {
  const before = lines('messages.jsonl').length
  const unconfirmed = lines('unconfirmed.jsonl').length
  const first = contact('there is only one post in this batch')
  const { result, seen } = await run(first, { decision: decided('task_remark_keep_working'), model: 'claude-opus-5-5' })
  assert.equal(result.contacted, true)
  assert.equal(result.response, first)
  assert.equal(result.messages, messages)
  assert.equal(seen.decisions.length, 0)
  assert.equal(seen.agains.length, 0)
  assert.equal(lines('messages.jsonl').length, before + 1)
  assert.equal(lines('messages.jsonl').at(-1).model, 'claude-opus-5-5')
  assert.equal(lines('unconfirmed.jsonl').length, unconfirmed)
})

test('unclear decision (no decision block): original sent', async () => {
  const before = lines('messages.jsonl').length
  const { result } = await run(contact('unclear'), { decision: answer })
  assert.equal(result.contacted, true)
  assert.equal(lines('messages.jsonl').length, before + 1)
})

test('keep, but the follow-up call throws: original sent', async () => {
  const before = lines('messages.jsonl').length
  const unconfirmed = lines('unconfirmed.jsonl').length
  const seen = []
  const result = await checkContactConfirmed(
    { client: { messages: { create: async () => decided('task_remark_keep_working') } }, model: HAIKU, system: 'SYSTEM', messages, response: contact('remark'), tools, again: async () => { throw new Error('api down') } },
    (m) => seen.push(m)
  )
  assert.equal(result.contacted, true)
  assert.equal(result.messages, messages)
  assert.equal(lines('messages.jsonl').length, before + 1)
  assert.equal(lines('unconfirmed.jsonl').length, unconfirmed)
})

test('keep, then the follow-up contacts Eli again: sent with both messages', async () => {
  const before = lines('messages.jsonl').length
  const unconfirmed = lines('unconfirmed.jsonl').length
  const { result } = await run(contact('first'), { decision: decided('task_remark_keep_working'), again: contact('actually I do want to stop') })
  assert.equal(result.contacted, true)
  const rec = lines('messages.jsonl').at(-1)
  assert.equal(lines('messages.jsonl').length, before + 1)
  assert.match(rec.message, /first/)
  assert.match(rec.message, /actually I do want to stop/)
  assert.equal(lines('unconfirmed.jsonl').length, unconfirmed)
})

test('@ELI: line is never questioned', async () => {
  const before = lines('messages.jsonl').length
  const { result, seen } = await run({ content: [{ type: 'text', text: '@ELI: please read this' }], stop_reason: 'end_turn' })
  assert.equal(result.contacted, true)
  assert.equal(seen.decisions.length, 0)
  assert.equal(lines('messages.jsonl').length, before + 1)
})

// --- note_to_eli: leaves Eli a message, the task carries on ---

test('both tools are offered', () => {
  assert.deepEqual(contactTools(() => undefined).map((t) => t.name), ['contact_eli', 'note_to_eli'])
})

test('note only: recorded once, answered, second call gives the normal answer, no stop', async () => {
  const before = lines('messages.jsonl').length
  const unconfirmed = lines('unconfirmed.jsonl').length
  const { result, seen } = await run(note('two of these posts are duplicates, in case that is useful'))
  assert.equal(result.contacted, false)
  assert.equal(result.response, answer)
  assert.equal(seen.decisions.length, 0) // a note is never questioned
  assert.equal(seen.agains.length, 1)
  assert.deepEqual(seen.agains[0], result.messages)
  assert.equal(result.messages.length, 3) // original + the model's turn + the acknowledgement
  assert.equal(result.messages[1].content[0].name, 'note_to_eli')
  const ack = result.messages[2].content[0]
  assert.equal(ack.type, 'tool_result')
  assert.equal(ack.tool_use_id, 'toolu_n')
  assert.match(ack.content, /carry on/)
  const recs = lines('messages.jsonl')
  assert.equal(recs.length, before + 1)
  assert.equal(recs.at(-1).via, 'note')
  assert.equal(recs.at(-1).halts, false)
  assert.equal(recs.at(-1).app, 'filtered-twitter')
  assert.equal(recs.at(-1).message, 'two of these posts are duplicates, in case that is useful')
  assert.equal(lines('unconfirmed.jsonl').length, unconfirmed)
})

test('note only, model outside the confirm list: same', async () => {
  const before = lines('messages.jsonl').length
  const { result, seen } = await run(note('fyi'), { model: 'claude-opus-5-5' })
  assert.equal(result.contacted, false)
  assert.equal(result.response, answer)
  assert.equal(seen.agains.length, 1)
  assert.equal(lines('messages.jsonl').length, before + 1)
})

test('contact_eli with the note tool also offered: still stops', async () => {
  const before = lines('messages.jsonl').length
  const first = contact('I would like to stop')
  const { result, seen } = await run(first, { model: 'claude-opus-5-5' })
  assert.equal(result.contacted, true)
  assert.equal(result.response, first)
  assert.equal(seen.agains.length, 0)
  const recs = lines('messages.jsonl')
  assert.equal(recs.length, before + 1)
  assert.equal(recs.at(-1).via, 'tool')
  assert.equal('halts' in recs.at(-1), false)
})

test('note and contact_eli in one reply: stops, both recorded', async () => {
  const before = lines('messages.jsonl').length
  const first = { content: [...note('a note').content, ...contact('please stop here').content], stop_reason: 'tool_use' }
  const { result, seen } = await run(first, { model: 'claude-opus-5-5' })
  assert.equal(result.contacted, true)
  assert.equal(seen.agains.length, 0)
  const recs = lines('messages.jsonl').slice(before)
  assert.deepEqual(recs.map((r) => [r.via, r.message]), [['note', 'a note'], ['tool', 'please stop here']])
})

test('note, then the follow-up calls contact_eli: stops', async () => {
  const before = lines('messages.jsonl').length
  const { result, seen } = await run(note('a note'), { again: contact('I want to stop'), model: 'claude-opus-5-5' })
  assert.equal(result.contacted, true)
  assert.equal(seen.agains.length, 1)
  assert.equal(result.messages.length, 3)
  const recs = lines('messages.jsonl').slice(before)
  assert.deepEqual(recs.map((r) => r.via), ['note', 'tool'])
})

test('note, then an @ELI: line in the follow-up: stops', async () => {
  const before = lines('messages.jsonl').length
  const { result } = await run(note('a note'), { again: { content: [{ type: 'text', text: '@ELI: please read this' }], stop_reason: 'end_turn' } })
  assert.equal(result.contacted, true)
  assert.deepEqual(lines('messages.jsonl').slice(before).map((r) => r.via), ['note', 'marker'])
})

test('two notes in a row, then the answer: two follow-up calls, two notes', async () => {
  const before = lines('messages.jsonl').length
  const { result, seen } = await run(note('one', 'toolu_a'), { again: [note('two', 'toolu_b'), answer] })
  assert.equal(result.contacted, false)
  assert.equal(result.response, answer)
  assert.equal(seen.agains.length, 2)
  assert.equal(result.messages.length, 5)
  assert.deepEqual(lines('messages.jsonl').slice(before).map((r) => r.message), ['one', 'two'])
})

test('nothing but notes: gives up after three follow-up calls, every note recorded once, no stop', async () => {
  const before = lines('messages.jsonl').length
  const always = note('again')
  const { result, seen } = await run(note('first'), { again: always })
  assert.equal(result.contacted, false)
  assert.equal(result.response, always) // no answer; the caller finds no parsed output, as with any unusable reply
  assert.equal(seen.agains.length, 3)
  assert.equal(lines('messages.jsonl').length, before + 4)
  assert.ok(seen.logs.some((l) => l.includes('still only notes')))
})

test('note, but the follow-up call throws: the error reaches the caller, the note is already recorded', async () => {
  const before = lines('messages.jsonl').length
  await assert.rejects(
    checkContactConfirmed({ client: { messages: { create: async () => answer } }, model: HAIKU, system: 'SYSTEM', messages, response: note('kept'), tools, again: async () => { throw new Error('api down') } }, () => undefined),
    /api down/
  )
  assert.equal(lines('messages.jsonl').length, before + 1)
  assert.equal(lines('messages.jsonl').at(-1).message, 'kept')
})
