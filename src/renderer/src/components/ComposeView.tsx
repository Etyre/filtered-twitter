import type React from 'react'
import { useState } from 'react'
import type { PostNetwork, Settings } from '@shared/types'
import Composer from './Composer'

export default function ComposeView({ settings }: { settings: Settings | null }): React.JSX.Element {
  const xReady = !!settings?.hasXApiKeys
  const bskyReady = !!settings?.bskyEnabled && !!settings?.bskyHandle && !!settings?.hasBskyPassword
  const [network, setNetwork] = useState<PostNetwork>(xReady || !bskyReady ? 'x' : 'bsky')
  const as = network === 'x' ? `@${settings?.xHandle || 'your X account'}` : network === 'bsky' ? `@${settings?.bskyHandle || 'your Bluesky account'}` : `@${settings?.xHandle} and @${settings?.bskyHandle}`
  return (
    <div className="today narrow">
      <header className="page-head">
        <h1>Compose</h1>
        {bskyReady ? (
          <div className="segmented">
            <button className={network === 'x' ? 'on' : ''} disabled={!xReady} onClick={() => setNetwork('x')}>X</button>
            <button className={network === 'bsky' ? 'on' : ''} onClick={() => setNetwork('bsky')}>Bluesky</button>
            <button className={network === 'both' ? 'on' : ''} disabled={!xReady} onClick={() => setNetwork('both')}>Both</button>
          </div>
        ) : null}
      </header>
      {!xReady && !bskyReady ? (
        <div className="notes muted small">Posts go out through the official APIs from your own accounts. Add your X API keys, or set up Bluesky, in Settings first.</div>
      ) : (
        <div className="muted small" style={{ marginBottom: 10 }}>Posting as {as}.</div>
      )}
      <Composer key={network} network={network} onDone={() => {}} />
    </div>
  )
}
