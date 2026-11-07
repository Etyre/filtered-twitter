import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AnkiGate, Edition, Progress, SessionStatus, Settings } from '@shared/types'
import Sidebar, { type View } from './components/Sidebar'
import TodayView from './components/TodayView'
import ArchiveView from './components/ArchiveView'
import NotificationsView from './components/NotificationsView'
import ComposeView from './components/ComposeView'
import ChatView from './components/ChatView'
import SettingsView from './components/SettingsView'
import ThreadView from './components/ThreadView'
import { OpenThreadContext } from './components/TweetCard'
import Lightbox from './components/Lightbox'
import ClaudePanel from './components/ClaudePanel'

/** Where the reader is: a page, possibly a past edition within it, possibly a discussion on top. */
interface Loc {
  view: View
  thread: { tweetId: string; editionId?: number } | null
  archiveId: number | null
}
/** A place in the history, with how far down it was scrolled when the reader left it. */
interface Entry extends Loc {
  scroll: number
}
const sameLoc = (a: Loc, b: Loc): boolean => a.view === b.view && a.archiveId === b.archiveId && a.thread?.tweetId === b.thread?.tweetId

export default function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [edition, setEdition] = useState<Edition | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const content = useRef<HTMLElement>(null)

  // Nothing shows until today's Anki review is done. Check often while waiting, rarely once open (to close again when Anki's day turns).
  const [gate, setGate] = useState<AnkiGate | null>(null)
  const gateOpen = gate?.open ?? false
  useEffect(() => {
    let alive = true
    const check = async (): Promise<void> => {
      const g = await window.api.getAnkiGate()
      if (alive) setGate(g)
    }
    void check()
    const timer = setInterval(() => void check(), gateOpen ? 5 * 60_000 : 5000)
    window.addEventListener('focus', check)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', check) }
  }, [gateOpen, settings?.ankiGate])

  // Navigation history, like a browser's: every page, edition or discussion opened is an entry,
  // and back/forward return to it at the same scroll position.
  const [hist, setHist] = useState<{ entries: Entry[]; index: number }>({ entries: [{ view: 'today', thread: null, archiveId: null, scroll: 0 }], index: 0 })
  const loc = hist.entries[hist.index]
  const { view, thread, archiveId } = loc
  const restore = useRef<number | null>(null) // scroll to land at after a back/forward step
  const fromHistory = useRef(false) // the current location was reached by back/forward, not by opening something
  const scrollNow = (): number => content.current?.scrollTop ?? 0
  const navigate = useCallback((patch: Partial<Loc>): void => {
    setHist((h) => {
      const cur: Entry = { ...h.entries[h.index], scroll: scrollNow() }
      const next: Entry = { ...cur, ...patch, scroll: 0 }
      if (sameLoc(cur, next)) return h
      fromHistory.current = false
      restore.current = 0
      return { entries: [...h.entries.slice(0, h.index), cur, next], index: h.index + 1 }
    })
  }, [])
  const step = useCallback((d: -1 | 1): void => {
    setHist((h) => {
      const i = h.index + d
      if (i < 0 || i >= h.entries.length) return h
      const entries = [...h.entries]
      entries[h.index] = { ...entries[h.index], scroll: scrollNow() }
      fromHistory.current = true
      restore.current = entries[i].scroll
      return { entries, index: i }
    })
  }, [])
  const back = useCallback(() => step(-1), [step])
  const forward = useCallback(() => step(1), [step])
  const canBack = hist.index > 0
  const canForward = hist.index < hist.entries.length - 1
  useLayoutEffect(() => {
    const el = content.current
    const target = restore.current
    if (!el || target === null) return
    restore.current = null
    el.scrollTop = target
    if (!target) return
    // The page may still be loading (a discussion, say); keep trying until it is tall enough, for a little while.
    let raf = 0
    const deadline = performance.now() + 2500
    const tick = (): void => {
      if (el.scrollHeight - el.clientHeight >= target) el.scrollTop = target
      else if (performance.now() < deadline) raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [loc])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey && e.key === '[') || (e.altKey && e.key === 'ArrowLeft')) { e.preventDefault(); back() }
      if ((e.metaKey && e.key === ']') || (e.altKey && e.key === 'ArrowRight')) { e.preventDefault(); forward() }
    }
    window.addEventListener('keydown', onKey)
    const off = window.api.onNavigate((dir) => (dir === 'back' ? back() : forward()))
    return () => { window.removeEventListener('keydown', onKey); off() }
  }, [back, forward])
  const openThread = (tweetId: string, editionId?: number): void => navigate({ thread: { tweetId, editionId } })
  const setView = (v: View): void => navigate({ view: v, thread: null, archiveId: null })
  const [unread, setUnread] = useState(0)
  const refreshUnread = useCallback(async () => {
    const n = await window.api.getNotifications(false)
    setUnread(n.items.filter((x) => !x.read).length)
  }, [])
  useEffect(() => {
    void refreshUnread()
    return window.api.onNotificationsUpdated(() => void refreshUnread())
  }, [refreshUnread])

  const refreshEdition = useCallback(async () => {
    setEdition(await window.api.getTodayEdition())
  }, [])

  useEffect(() => {
    void (async () => {
      setSettings(await window.api.getSettings())
      setSession(await window.api.getSessionStatus())
      setProgress(await window.api.getProgress())
      await refreshEdition()
    })()
    return window.api.onProgress((p) => {
      setProgress(p)
      if (p.done && !p.error) void refreshEdition()
    })
  }, [refreshEdition])

  const bskyReady = !!settings?.bskyEnabled && !!settings.bskyHandle && settings.hasBskyPassword
  const needsSetup = settings && session && (!session.loggedIn || !settings.hasXApiKeys) && !bskyReady

  if (!gate) return <div className="anki-gate" />
  if (!gate.open) return <AnkiWall gate={gate} />

  return (
    <div className="app">
      <Sidebar view={view} setView={setView} session={session} settings={settings} unread={unread} />
      <div className="main-col">
        <div className="topbar">
          <button className="navbtn" disabled={!canBack} onClick={back} title="Back (⌘[)">‹</button>
          <button className="navbtn" disabled={!canForward} onClick={forward} title="Forward (⌘])">›</button>
        </div>
      <main className="content" ref={content}>
        <OpenThreadContext.Provider value={(tweetId) => openThread(tweetId)}>
        {thread ? (
          <ThreadView tweetId={thread.tweetId} editionId={thread.editionId} centerFocal={!fromHistory.current} onBack={() => (canBack ? back() : navigate({ thread: null }))} />
        ) : view === 'today' ? (
          needsSetup ? (
            <Welcome settings={settings!} session={session!} onLogin={async () => setSession(await window.api.openLogin())} goSettings={() => setView('settings')} />
          ) : (
            <TodayView
              edition={edition}
              settings={settings}
              progress={progress}
              onBuild={async (force) => { setProgress({ phase: 'Starting', detail: '', done: false }); await window.api.buildEdition(force); await refreshEdition() }}
              onOpenThread={openThread}
              onChange={refreshEdition}
            />
          )
        ) : view === 'archive' ? (
          <ArchiveView selectedId={archiveId} onSelect={(id) => navigate({ archiveId: id })} onOpenThread={openThread} settings={settings} />
        ) : view === 'notifications' ? (
          <NotificationsView onOpenThread={(tweetId) => openThread(tweetId)} onChange={refreshUnread} />
        ) : view === 'chat' ? (
          <ChatView settings={settings} />
        ) : view === 'compose' ? (
          <ComposeView settings={settings} />
        ) : (
          <SettingsView settings={settings} session={session} onSettings={setSettings} onSession={setSession} />
        )}
        </OpenThreadContext.Provider>
      </main>
      </div>
      <ClaudePanel />
      <Lightbox />
    </div>
  )
}

function AnkiWall({ gate }: { gate: Extract<AnkiGate, { open: false }> }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="anki-gate">
      <button className="anki-button" onClick={() => window.api.openAnki().then(() => setError(null), (e: unknown) => setError(String(e)))}>Open Anki</button>
      <p className="muted">
        Today’s review first: clear “{gate.deck}” down to learning cards, or answer {gate.target} of its cards
        {gate.reviewed !== null ? ` (${gate.reviewed} so far)` : ''}.
      </p>
      {(error ?? gate.note) && <p className="error">{error ?? gate.note}</p>}
    </div>
  )
}

function Welcome({ settings, session, onLogin, goSettings }: { settings: Settings; session: SessionStatus; onLogin: () => Promise<void>; goSettings: () => void }): React.JSX.Element {
  return (
    <div className="welcome">
      <h1>A quieter Twitter.</h1>
      <p>One finite edition a day, chosen for you. No infinite scroll. No algorithm deciding how long you stay.</p>
      <p>Two accounts are involved, kept strictly apart:</p>
      <ol>
        <li>
          <strong>A browsing account</strong>, disposable, does all the reading inside the app.{' '}
          {session.loggedIn ? <span className="muted">Logged in{session.handle ? ' as @' + session.handle : ''}.</span> : <button className="primary" onClick={() => void onLogin()}>Log in with the browsing account</button>}
        </li>
        <li>
          <strong>Your real account</strong> only ever likes, reposts, replies, posts and reads DMs through the official X API.{' '}
          {settings.hasXApiKeys ? <span className="muted">Keys saved.</span> : <button className="secondary" onClick={goSettings}>Add API keys in Settings</button>}
        </li>
      </ol>
      <p className="muted">Also in Settings: a proxy for the browsing account, your Anthropic key, the accounts you want to prioritize, and Bluesky, which needs only your own account.</p>
    </div>
  )
}
