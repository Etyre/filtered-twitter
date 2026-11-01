/** Reads text aloud with the system voice (the Web Speech API, which Electron backs with macOS's voices). No key, no network. */

const PREFERRED = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Flo', 'Reed']

let chosen: SpeechSynthesisVoice | null | undefined // undefined: not looked up yet

function voice(): SpeechSynthesisVoice | null {
  if (chosen !== undefined) return chosen
  const all = speechSynthesis.getVoices()
  if (!all.length) return null // the list is not in yet; try again next time
  const english = all.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const pool = english.length ? english : all
  // An enhanced or premium copy of a voice, if the system has one, sounds much better than the compact one.
  const rich = pool.find((v) => /enhanced|premium/i.test(v.name))
  chosen = rich ?? PREFERRED.map((n) => pool.find((v) => v.name.startsWith(n))).find(Boolean) ?? pool.find((v) => v.default) ?? pool[0] ?? null
  return chosen
}
if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', () => { chosen = undefined })

/** What a post sounds like: links become the word "link", handles lose their @ so they are read as names. */
const spoken = (text: string): string => text.replace(/https?:\/\/\S+/g, 'link').replace(/(^|[\s(])@(\w)/g, '$1$2')

/**
 * Reads the parts one after another, with a short breath between them, and calls onEnd when done or stopped.
 * Returns a function that stops the reading.
 */
export function speak(parts: string[], onEnd: () => void): () => void {
  const texts = parts.map((p) => spoken(p.trim())).filter(Boolean)
  speechSynthesis.cancel()
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    onEnd()
  }
  const utterances = texts.map((t, i) => {
    const u = new SpeechSynthesisUtterance(i < texts.length - 1 ? t + ' .' : t) // the pause between parts of a thread
    const v = voice()
    if (v) u.voice = v
    u.rate = 1
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') finish() }
    return u
  })
  if (!utterances.length) {
    finish()
    return () => {}
  }
  utterances[utterances.length - 1].onend = finish
  utterances.forEach((u) => speechSynthesis.speak(u))
  return () => {
    speechSynthesis.cancel()
    finish()
  }
}
