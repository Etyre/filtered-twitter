import type React from 'react'
import type { SessionStatus, Settings } from '@shared/types'

export type View = 'today' | 'archive' | 'notifications' | 'chat' | 'compose' | 'settings'

const items: { id: View; label: string; glyph: string }[] = [
  { id: 'today', label: 'Today', glyph: '☀' },
  { id: 'notifications', label: 'Notifications', glyph: '◎' },
  { id: 'chat', label: 'Chat', glyph: '✉' },
  { id: 'compose', label: 'Compose', glyph: '✎' },
  { id: 'archive', label: 'Past editions', glyph: '▤' },
  { id: 'settings', label: 'Settings', glyph: '⚙' }
]

export default function Sidebar({ view, setView, session, settings, unread = 0 }: { view: View; setView: (v: View) => void; session: SessionStatus | null; settings: Settings | null; unread?: number }): React.JSX.Element {
  return (
    <nav className="sidebar">
      <div className="brand">Filtered</div>
      {items.map((it) => (
        <button key={it.id} className={'nav' + (view === it.id ? ' active' : '')} onClick={() => setView(it.id)}>
          <span className="glyph">{it.glyph}</span>
          {it.label}
          {it.id === 'notifications' && unread ? <span className="badge">{unread}</span> : null}
        </button>
      ))}
      <div className="spacer" />
      <div className="session">
        <div>You: {settings?.xHandle ? '@' + settings.xHandle : settings?.hasXApiKeys ? 'keys saved' : 'no API keys'}</div>
        <div>Reader: {session?.loggedIn ? (session.handle ? '@' + session.handle : 'logged in') : 'not logged in'}</div>
        {settings?.bskyEnabled ? <div>Bluesky: {settings.bskyHandle ? '@' + settings.bskyHandle : 'not set up'}</div> : null}
      </div>
    </nav>
  )
}
