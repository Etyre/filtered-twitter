import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Edition, Progress, SessionStatus, Settings } from '@shared/types'
import Sidebar, { type View } from './components/Sidebar'
import TodayView from './components/TodayView'
import ArchiveView from './components/ArchiveView'
import NotificationsView from './components/NotificationsView'
import ComposeView from './components/ComposeView'
import ChatView from './components/ChatView'
import SettingsView from './components/SettingsView'
import ThreadView from './components/ThreadView'
import { OpenThreadContext } from './components/TweetCard'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('today')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [edition, setEdition] = useState<Edition | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [thread, setThread] = useState<{ tweetId: string; editionId?: number } | null>(null)
  const content = useRef<HTMLElement>(null)
  const savedScroll = useRef(0) // where the list was when a discussion was opened
  const openThread = (tweetId: string, editionId?: number): void => {
    if (!thread) savedScroll.current = content.current?.scrollTop ?? 0 // only on leaving the list, not when hopping between discussions
    setThread({ tweetId, editionId })
  }
  useLayoutEffect(() => {
    if (!content.current) return
    content.current.scrollTop = thread ? 0 : savedScroll.current // a discussion starts at its top; back lands where you were
  }, [thread])
  const [archiveId, setArchiveId] = useState<number | null>(null)

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

  const needsSetup = settings && session && (!session.loggedIn || !settings.hasXApiKeys)

  return (
    <div className="app">
      <Sidebar view={view} setView={(v) => { setView(v); setThread(null); setArchiveId(null) }} session={session} settings={settings} />
      <main className="content" ref={content}>
        <OpenThreadContext.Provider value={(tweetId) => openThread(tweetId)}>
        {thread ? (
          <ThreadView tweetId={thread.tweetId} editionId={thread.editionId} onBack={() => setThread(null)} />
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
          <ArchiveView selectedId={archiveId} onSelect={setArchiveId} onOpenThread={openThread} />
        ) : view === 'notifications' ? (
          <NotificationsView onOpenThread={(tweetId) => openThread(tweetId)} />
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
      <p className="muted">Also in Settings: a proxy for the browsing account, your Anthropic key, and the accounts you want to prioritize.</p>
    </div>
  )
}
