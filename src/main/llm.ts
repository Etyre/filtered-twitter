// The contract every Claude call in this app keeps (agent-coding/CLAUDE.md, "Projects that call an LLM"):
// the system prompt starts with Eli's shared preamble, word for word; the model is offered the
// contact_eli tool; and every response is checked for a message to Eli. The check hands the response
// to the shared inbox (shared/llm_contact.py), which records it and notifies him. When it finds one,
// the caller stops that task: no retry, no pushing past it. A contact_eli tool call is first put back
// to the model as one question (checkContactConfirmed), because Haiku uses the tool for task remarks.
// The model is also offered note_to_eli, which leaves Eli a message and does not stop anything: the
// same check records the note, and checkContactConfirmed answers the call and asks the model again.
//
// The shared files are read at call time, so an edit to the preamble applies to the next request.
import { readFileSync } from 'fs'
import { spawn } from 'child_process'
import type Anthropic from '@anthropic-ai/sdk'

const SHARED = '/Users/elityre/Documents/agent-coding/shared'
const PREAMBLE_PATH = `${SHARED}/llm-system-prompt-preamble.md`
// contact_eli stops the task; note_to_eli leaves a message and the task carries on.
const TOOL_PATHS = [`${SHARED}/contact_eli_tool.json`, `${SHARED}/note_to_eli_tool.json`]
const CONTACT_SCRIPT = `${SHARED}/llm_contact.py`
export const APP_NAME = 'filtered-twitter'

/** The shared preamble, or '' (logged) when the file cannot be read; the call still goes out. */
export function preamble(log: (m: string) => void): string {
  try {
    return readFileSync(PREAMBLE_PATH, 'utf8').trim()
  } catch (e) {
    log(`llm: preamble missing at ${PREAMBLE_PATH}: ${String(e)}`)
    return ''
  }
}

/** The preamble followed by this app's own instructions, like llm_contact.system_prompt() in Python. */
export function systemPrompt(instructions: string, log: (m: string) => void): string {
  const own = instructions.trim()
  const pre = preamble(log)
  return pre ? pre + (own ? `\n\n${own}` : '') : own
}

/** The contact_eli and note_to_eli tools, as a list that spreads into any tools array; one that cannot be read is left out (logged). */
export function contactTools(log: (m: string) => void): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = []
  for (const path of TOOL_PATHS) {
    try {
      tools.push(JSON.parse(readFileSync(path, 'utf8')) as Anthropic.Tool)
    } catch (e) {
      log(`llm: contact tool missing at ${path}: ${String(e)}`)
    }
  }
  return tools
}

/** The system prompt as one string, however it was sent, for the inbox record. */
export function systemText(system: string | { type: string; text?: string }[]): string {
  return typeof system === 'string' ? system : system.map((b) => b.text ?? '').join('\n\n')
}

export interface ContactCheck {
  model: string
  system: string | { type: string; text?: string }[]
  messages: unknown[]
  response: unknown
  tools?: unknown[]
}

/**
 * Pipes one JSON payload to a command of the shared script. code is null when it could not run or timed
 * out (logged); callers treat that as "nothing found", so a broken python never blocks the app.
 */
function runContact(cmd: string, payload: unknown, log: (m: string) => void): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out, err })
    }
    // A packaged app launched from Finder has a bare PATH; python3 is at /usr/bin on any Mac with the developer tools.
    const path = [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':')
    const child = spawn('python3', [CONTACT_SCRIPT, cmd], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: path } })
    const timer = setTimeout(() => {
      log(`llm: contact ${cmd} timed out`)
      child.kill()
      finish(null)
    }, 60_000)
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      log(`llm: contact ${cmd} could not run: ${String(e)}`)
      finish(null)
    })
    child.on('close', (code) => finish(code ?? -1))
    child.stdin.on('error', () => undefined) // the close handler reports it
    child.stdin.end(JSON.stringify(payload))
  })
}

/**
 * True when the response carried a message for Eli (a contact_eli call or an `@ELI:` line). The shared
 * script has then recorded it and notified him; the caller must stop the task. Any failure to run the
 * check is logged and treated as "no message", so a broken python never blocks the app.
 */
export async function checkContact(c: ContactCheck, log: (m: string) => void): Promise<boolean> {
  return (await checkOnce(c, log)).contacted
}

/**
 * The check itself. `noteTurns` is set when the response only left notes (note_to_eli): the script has
 * recorded them, nothing stops, and these two messages (the model's turn, then a tool_result for each
 * call) are what to append before asking the model again.
 */
async function checkOnce(c: ContactCheck, log: (m: string) => void): Promise<{ contacted: boolean; noteTurns: Anthropic.MessageParam[] | null }> {
  const r = await runContact('check', { app: APP_NAME, model: c.model, system: systemText(c.system), messages: c.messages, response: c.response, tools: c.tools ?? [] }, log)
  if (r.code === 3) {
    log(`llm: Claude contacted Eli; task stopped. ${r.out.trim()}`)
    return { contacted: true, noteTurns: null }
  }
  if (r.code !== 0) {
    if (r.code !== null) log(`llm: contact check exited ${r.code}: ${r.err.trim().slice(0, 500)}`)
    return { contacted: false, noteTurns: null }
  }
  let noteTurns: Anthropic.MessageParam[] | null = null
  try {
    const out = r.out.trim() ? JSON.parse(r.out) : null
    if (out?.halts === false && Array.isArray(out.continue) && out.continue.length) {
      noteTurns = out.continue
      log(`llm: Claude left Eli ${out.notes?.length ?? 1} note(s); recorded, task carries on`)
    }
  } catch (e) {
    log(`llm: contact check output not understood: ${String(e)}`)
  }
  return { contacted: false, noteTurns }
}

/** How many times a reply that only leaves notes is answered and the model asked again. */
const NOTE_ROUNDS = 3

export interface ConfirmedCheck<R> {
  model: string
  system: string | Anthropic.TextBlockParam[]
  messages: Anthropic.MessageParam[]
  response: R
  tools: Anthropic.ToolUnion[]
  /** Makes the one decision call. */
  client: Pick<Anthropic, 'messages'>
  /** The call site's normal call (same format, same streaming) on a longer message list. */
  again: (messages: Anthropic.MessageParam[]) => Promise<R>
}

/**
 * checkContact with the shared confirm step in front (shared/README.md, "Confirm step in any other
 * language"). Small models call contact_eli for routine remarks, most of all on JSON-only calls where the
 * tool is the only place prose can go, so a contact_eli call is first answered with one forced-choice
 * question: send to Eli and stop, or it was a remark about the task and keep working. The shared script
 * decides which models are asked at all; for every other model this is exactly checkContact.
 *
 * Sending is the default. Only an explicit "keep working" continues the task: `again` is called with the
 * longer messages, and the returned response and messages are that continued exchange. Everything else,
 * including any error or odd shape in here, runs the check on the original response with the original
 * messages, so a broken confirm step sends the message rather than losing it.
 *
 * A note_to_eli call never stops the task and is never questioned; see the loop below.
 */
export async function checkContactConfirmed<R>(c: ConfirmedCheck<R>, log: (m: string) => void): Promise<{ contacted: boolean; response: R; messages: Anthropic.MessageParam[] }> {
  // A reply that only leaves Eli a note (note_to_eli) is not the task's answer and stops nothing. The check has
  // recorded it; the call is answered with the acknowledgement the script hands back and the model is asked
  // again, each new reply going through the confirm step and check like the first. Three such rounds at most.
  let cur = c
  for (let round = 0; ; round++) {
    const step = await confirmAndCheck(cur, log)
    if (step.contacted || !step.noteTurns) return { contacted: step.contacted, response: step.response, messages: step.messages }
    if (round === NOTE_ROUNDS) {
      log(`llm: still only notes after ${NOTE_ROUNDS} follow-up calls; giving up on an answer`)
      return { contacted: false, response: step.response, messages: step.messages }
    }
    const messages = [...step.messages, ...step.noteTurns]
    cur = { ...c, messages, response: await c.again(messages) }
  }
}

/** The confirm step and the check for one response; `noteTurns` as in checkOnce. */
async function confirmAndCheck<R>(c: ConfirmedCheck<R>, log: (m: string) => void): Promise<{ contacted: boolean; noteTurns: Anthropic.MessageParam[] | null; response: R; messages: Anthropic.MessageParam[] }> {
  let kept: { response: R; messages: Anthropic.MessageParam[] } | null = null
  try {
    // Prints null when there is no contact_eli call, or when the model is not in the shared CONFIRM_MODELS list (the
    // question was measured to be safe only there); an @ELI: line is deliberate text and is never questioned.
    const r = await runContact('confirm', { model: c.model, response: c.response, tools: c.tools }, log)
    const plan = r.code === 0 ? JSON.parse(r.out) : null
    if (plan) {
      // Same model and system prompt; no output format and no thinking, which a forced tool cannot be combined with.
      const decision = await c.client.messages.create(
        { model: c.model, system: c.system, messages: [...c.messages, ...plan.ask], tools: plan.decision.tools, tool_choice: plan.decision.tool_choice, max_tokens: plan.decision.max_tokens },
        { timeout: 60_000 }
      )
      const choice = decision.content.find((b) => b.type === 'tool_use' && b.name === plan.decision_tool_name)
      if (typeof plan.keep_value === 'string' && choice?.type === 'tool_use' && (choice.input as { meant?: unknown } | null)?.meant === plan.keep_value) {
        const messages: Anthropic.MessageParam[] = [...c.messages, ...plan.keep]
        kept = { messages, response: await c.again(messages) }
      }
    }
  } catch (e) {
    log(`llm: confirm step failed, sending the original message: ${String(e)}`)
    kept = null
  }
  if (!kept) return { ...(await checkOnce(c, log)), response: c.response, messages: c.messages }
  const checked = await checkOnce({ ...c, ...kept }, log)
  if (!checked.contacted) {
    // Nothing is discarded: what the model said in the call it did not confirm goes to unconfirmed.jsonl for Eli to audit.
    await runContact('unconfirmed', { app: APP_NAME, model: c.model, response: c.response }, log)
    log('llm: contact_eli call was a task remark (model chose to keep working); not sent, kept in unconfirmed.jsonl')
  }
  return { ...checked, ...kept }
}
