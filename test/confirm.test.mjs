// Offline test of the contact_eli confirm step in src/main/llm.ts. Model responses are stubbed; the real
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
const { checkContactConfirmed } = await import('../src/main/llm.ts')

const lines = (name) => (existsSync(join(inbox, name)) ? readFileSync(join(inbox, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const tools = [{ name: 'contact_eli', description: 'x', input_schema: { type: 'object', properties: { message: { type: 'string' } } } }]
const messages = [{ role: 'user', content: 'Candidates: ...' }]
// The shared script runs the confirm step only for models in its CONFIRM_MODELS list (today just this one).
const HAIKU = 'claude-haiku-4-5'
const answer = { content: [{ type: 'text', text: '{"ratings":[]}' }], stop_reason: 'end_turn' }
const contact = (message) => ({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'contact_eli', input: { message } }], stop_reason: 'tool_use' })
const decided = (meant) => ({ content: [{ type: 'tool_use', id: 'toolu_2', name: 'contact_eli_decision', input: { meant } }], stop_reason: 'tool_use' })

/** Runs the helper with a stubbed decision call and a stubbed follow-up call, recording what each was sent. */
async function run(response, { decision, again = answer, model = HAIKU } = {}) {
  const seen = { decisions: [], agains: [], logs: [] }
  const client = { messages: { create: async (body) => { seen.decisions.push(body); if (decision instanceof Error) throw decision; return decision } } }
  const result = await checkContactConfirmed(
    { client, model, system: 'SYSTEM', messages, response, tools, again: async (m) => { seen.agains.push(m); return again } },
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
