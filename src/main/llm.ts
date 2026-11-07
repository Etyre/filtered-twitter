// The contract every Claude call in this app keeps (agent-coding/CLAUDE.md, "Projects that call an LLM"):
// the system prompt starts with Eli's shared preamble, word for word; the model is offered the
// contact_eli tool; and every response is checked for a message to Eli. The check hands the response
// to the shared inbox (shared/llm_contact.py), which records it and notifies him. When it finds one,
// the caller stops that task: no retry, no pushing past it.
//
// The shared files are read at call time, so an edit to the preamble applies to the next request.
import { readFileSync } from 'fs'
import { spawn } from 'child_process'
import type Anthropic from '@anthropic-ai/sdk'

const SHARED = '/Users/elityre/Documents/agent-coding/shared'
const PREAMBLE_PATH = `${SHARED}/llm-system-prompt-preamble.md`
const TOOL_PATH = `${SHARED}/contact_eli_tool.json`
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

/** The contact_eli tool, as a one-element list so it spreads into any tools array; empty (logged) if unreadable. */
export function contactTools(log: (m: string) => void): Anthropic.Tool[] {
  try {
    return [JSON.parse(readFileSync(TOOL_PATH, 'utf8')) as Anthropic.Tool]
  } catch (e) {
    log(`llm: contact_eli tool missing at ${TOOL_PATH}: ${String(e)}`)
    return []
  }
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
 * True when the response carried a message for Eli (a contact_eli call or an `@ELI:` line). The shared
 * script has then recorded it and notified him; the caller must stop the task. Any failure to run the
 * check is logged and treated as "no message", so a broken python never blocks the app.
 */
export function checkContact(c: ContactCheck, log: (m: string) => void): Promise<boolean> {
  const payload = JSON.stringify({ app: APP_NAME, model: c.model, system: systemText(c.system), messages: c.messages, response: c.response, tools: c.tools ?? [] })
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (v: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    // A packaged app launched from Finder has a bare PATH; python3 is at /usr/bin on any Mac with the developer tools.
    const path = [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':')
    const child = spawn('python3', [CONTACT_SCRIPT, 'check'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: path } })
    const timer = setTimeout(() => {
      log('llm: contact check timed out')
      child.kill()
      finish(false)
    }, 60_000)
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      log(`llm: contact check could not run: ${String(e)}`)
      finish(false)
    })
    child.on('close', (code) => {
      if (code === 3) {
        log(`llm: Claude contacted Eli; task stopped. ${out.trim()}`)
        finish(true)
      } else {
        if (code !== 0) log(`llm: contact check exited ${code}: ${err.trim().slice(0, 500)}`)
        finish(false)
      }
    })
    child.stdin.on('error', () => undefined) // the close handler reports it
    child.stdin.end(payload)
  })
}
