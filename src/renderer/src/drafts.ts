import { useCallback, useEffect, useState } from 'react'

// What the reader has typed but not sent, kept in localStorage so that leaving a screen, closing the
// window or restarting the app finds every text box as it was. Keys name the box: which post a reply
// is to, which conversation a message is for, and so on. A draft is cleared only when it is sent or
// saved. Secrets (API keys being typed) are kept in memory only: pass { durable: false }.

const PREFIX = 'ft:draft:'
const store = new Map<string, unknown>() // what this window has seen, so localStorage is parsed once per key
const memoryOnly = new Set<string>()

function load(key: string): unknown {
  if (store.has(key)) return store.get(key)
  let v: unknown = undefined
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw !== null) v = JSON.parse(raw)
  } catch {
    /* no storage, or an unreadable value: start empty */
  }
  store.set(key, v)
  return v
}

function persist(key: string, value: unknown): void {
  if (memoryOnly.has(key)) return
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* quota or private mode: the in-memory copy still serves this session */
  }
}

/** The value kept under `key`, if any. */
export function readDraft<T>(key: string): T | undefined {
  return load(key) as T | undefined
}

export function writeDraft<T>(key: string, value: T): void {
  store.set(key, value)
  persist(key, value)
}

export function clearDraft(key: string): void {
  store.delete(key)
  persist(key, undefined)
}

/**
 * Like useState, but the value outlives the component (and the app) under `key`, which must not change
 * while mounted. The stored value is read synchronously, so the box never shows empty first.
 */
export function useDraft<T>(key: string, initial: T | (() => T), opts: { durable?: boolean } = {}): [T, React.Dispatch<React.SetStateAction<T>>] {
  if (opts.durable === false) memoryOnly.add(key)
  const [value, setValue] = useState<T>(() => {
    const kept = load(key)
    return kept !== undefined ? (kept as T) : typeof initial === 'function' ? (initial as () => T)() : initial
  })
  useEffect(() => { writeDraft(key, value) }, [key, value])
  return [value, useCallback((v: React.SetStateAction<T>) => setValue(v), [])]
}
