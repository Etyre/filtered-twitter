import type React from 'react'
import type { Settings } from '@shared/types'
import Composer from './Composer'

export default function ComposeView({ settings }: { settings: Settings | null }): React.JSX.Element {
  return (
    <div className="today narrow">
      <header className="page-head"><h1>Compose</h1></header>
      {!settings?.hasXApiKeys ? (
        <div className="notes muted small">Posts go out through the official X API from your real account. Add your API keys in Settings first.</div>
      ) : (
        <div className="muted small" style={{ marginBottom: 10 }}>Posting as @{settings.xHandle || 'your account'}.</div>
      )}
      <Composer onDone={() => {}} />
    </div>
  )
}
