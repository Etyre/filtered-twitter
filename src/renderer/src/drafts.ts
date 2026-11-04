import { useCallback, useEffect, useState } from 'react'

// What the reader has typed but not sent, kept for the life of the window so that leaving a
// screen and coming back finds every text box as it was. Keys name the box: which post a reply
// is to, which conversation a message is for, and so on.

const store = new Map<string, unknown>()

/** The value kept under `key`, if any. */
export function readDraft<T>(key: string): T | undefined {
  return store.get(key) as T | undefined
}

export function writeDraft<T>(key: string, value: T): void {
  store.set(key, value)
}

export function clearDraft(key: string): void {
  store.delete(key)
}

/** Like useState, but the value outlives the component under `key`, which must not change while mounted. */
export function useDraft<T>(key: string, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : typeof initial === 'function' ? (initial as () => T)() : initial))
  useEffect(() => { store.set(key, value) }, [key, value])
  return [value, useCallback((v: React.SetStateAction<T>) => setValue(v), [])]
}
