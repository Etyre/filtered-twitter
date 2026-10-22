import type React from 'react'
import { useEffect, useState } from 'react'
import type { BackupStatus, IpCheck, ScorerStats, Secrets, SessionStatus, Settings } from '@shared/types'

export default function SettingsView({
  settings,
  session,
  onSettings,
  onSession
}: {
  settings: Settings | null
  session: SessionStatus | null
  onSettings: (s: Settings) => void
  onSession: (s: SessionStatus) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Settings | null>(settings)
  const [secrets, setSecrets] = useState<Secrets>({})
  const [stats, setStats] = useState<ScorerStats | null>(null)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [ip, setIp] = useState<IpCheck | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // Raw text for the list fields, so typing a newline is not parsed away mid-keystroke.
  const [priorityText, setPriorityText] = useState(settings?.priorityHandles.join('\n') ?? '')
  const [searchText, setSearchText] = useState(settings?.searchQueries.join('\n') ?? '')
  useEffect(() => {
    setDraft(settings)
    setPriorityText(settings?.priorityHandles.join('\n') ?? '')
    setSearchText(settings?.searchQueries.join('\n') ?? '')
  }, [settings])
  useEffect(() => {
    void window.api.getScorerStats().then(setStats)
    void window.api.getBackupStatus().then(setBackup)
  }, [])
  if (!draft) return <div className="today"><p className="muted">Loading…</p></div>

  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => setDraft({ ...draft, [k]: v })
  const save = async (): Promise<Settings> => {
    let next = await window.api.saveSettings(draft)
    if (Object.keys(secrets).length) {
      next = await window.api.saveSecrets(secrets)
      setSecrets({})
    }
    onSettings(next)
    setDraft(next)
    setSaved('Saved.')
    setTimeout(() => setSaved(null), 1500)
    return next
  }
  const run = async (label: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(label)
    setMsg(null)
    try {
      setMsg(await fn())
    } catch (e) {
      setMsg(String(e))
    }
    setBusy(null)
  }

  return (
    <div className="today narrow settings">
      <header className="page-head">
        <h1>Settings</h1>
        <div className="head-actions">
          {saved ? <span className="muted small">{saved}</span> : null}
          <button className="primary" onClick={() => void save()}>Save</button>
        </div>
      </header>
      {msg ? <div className="notes small">{msg}</div> : null}

      <section>
        <h2>Your account (official API only)</h2>
        <p className="muted small">
          Your real account is touched only through the X API: likes, reposts, replies, posts, and direct messages. Create a project and app at developer.x.com,
          set User authentication settings to Read and Write (Read, Write and Direct Messages if you want Chat), then under Keys and Tokens generate the API key and secret and an Access Token and Secret.
        </p>
        <label>API key (consumer key) <input type="password" value={secrets.xConsumerKey ?? ''} placeholder={draft.hasXApiKeys ? '(saved)' : ''} onChange={(e) => setSecrets({ ...secrets, xConsumerKey: e.target.value })} /></label>
        <label>API key secret <input type="password" value={secrets.xConsumerSecret ?? ''} placeholder={draft.hasXApiKeys ? '(saved)' : ''} onChange={(e) => setSecrets({ ...secrets, xConsumerSecret: e.target.value })} /></label>
        <label>Access token <input type="password" value={secrets.xAccessToken ?? ''} placeholder={draft.hasXApiKeys ? '(saved)' : ''} onChange={(e) => setSecrets({ ...secrets, xAccessToken: e.target.value })} /></label>
        <label>Access token secret <input type="password" value={secrets.xAccessSecret ?? ''} placeholder={draft.hasXApiKeys ? '(saved)' : ''} onChange={(e) => setSecrets({ ...secrets, xAccessSecret: e.target.value })} /></label>
        <div className="row">
          <span>{draft.xHandle ? `Verified as @${draft.xHandle}` : draft.hasXApiKeys ? 'Keys saved, not verified yet' : 'No keys yet'}</span>
          <button className="secondary" disabled={!!busy} onClick={() => void run('verify', async () => {
            await save()
            const r = await window.api.verifyXApi()
            if (r.ok) onSettings(await window.api.getSettings())
            return r.ok ? `Keys work. You are @${r.handle}.` : `Verification failed: ${r.error}`
          })}>{busy === 'verify' ? 'Checking…' : 'Save and verify keys'}</button>
        </div>
        <label>Your handle (if not verified) <input value={draft.xHandle} onChange={(e) => set('xHandle', e.target.value)} placeholder="yourname" /></label>
      </section>

      <section>
        <h2>Browsing account (does all the reading)</h2>
        <p className="muted small">
          A separate, disposable X account logged into a hidden browser inside the app. It reads timelines, profiles, searches, and replies. If X ever objects, only this account is at risk.
        </p>
        <div className="row">
          <span>{session?.loggedIn ? `Logged in${session.handle ? ' as @' + session.handle : ''}` : 'Not logged in'}</span>
          {session?.loggedIn ? (
            <button className="secondary" onClick={async () => onSession(await window.api.logout())}>Log out</button>
          ) : (
            <span className="head-actions">
              <button className="secondary" onClick={async () => onSession(await window.api.openSignup())}>Create one</button>
              <button className="primary" onClick={async () => onSession(await window.api.openLogin())}>Log in</button>
            </span>
          )}
        </div>
        {!session?.loggedIn ? <p className="muted small">Create one opens X's own signup inside the app, already routed through the proxy if you set one. X will ask for an email or phone and a puzzle; after that the account stays logged in and everything else is automatic.</p> : null}
        <label>Proxy for this account <input value={draft.proxyUrl} placeholder="socks5://host:1080  or  http://user:pass@host:port" onChange={(e) => set('proxyUrl', e.target.value)} /></label>
        <p className="muted small">
          Only the browsing account's traffic goes through the proxy; your real account's API calls do not, so the two never share an address. HTTP proxies support a username and password. SOCKS5 proxies must be unauthenticated (Chromium's limitation); a VPN's built-in SOCKS proxy or an SSH tunnel (<code>ssh -N -D 1080 somehost</code>, then <code>socks5://127.0.0.1:1080</code>) both work.
        </p>
        <div className="row">
          <span className="small">
            {ip ? <>App: <strong>{ip.direct ?? '?'}</strong> · Browsing account: <strong>{ip.browsing ?? '?'}</strong>{ip.direct && ip.browsing ? (ip.direct === ip.browsing ? ' (same address: proxy is not working)' : ' (different: good)') : ''}{ip.error ? ` ${ip.error}` : ''}</> : 'Check that the addresses differ after saving a proxy.'}
          </span>
          <button className="secondary" disabled={!!busy} onClick={() => void run('ip', async () => { await save(); setIp(await window.api.checkIp()); return 'IP check done.' })}>{busy === 'ip' ? 'Checking…' : 'Save and check IPs'}</button>
        </div>
      </section>

      <section>
        <h2>Who gets read</h2>
        <p className="muted small">
          The browsing account reads your real account's public following list once, then sweeps those people daily by search. Optionally it follows them gradually so its own timeline becomes the main source and it looks like an ordinary account.
        </p>
        <div className="row">
          <span>{draft.followingHandles.length} accounts you follow{draft.followingFetchedAt ? `, fetched ${new Date(draft.followingFetchedAt).toLocaleDateString()}` : ''} · browsing account follows {draft.browsingFollows.length}</span>
          <button className="secondary" disabled={!!busy || !session?.loggedIn} onClick={() => void run('following', async () => { await save(); const s = await window.api.refreshFollowing(); onSettings(s); setDraft(s); return `Found ${s.followingHandles.length} accounts you follow.` })}>{busy === 'following' ? 'Reading…' : 'Refresh following list'}</button>
        </div>
        <label><input type="checkbox" checked={draft.followSync} onChange={(e) => set('followSync', e.target.checked)} /> Browsing account gradually follows the same people</label>
        <label>Follows per day <input type="number" min={0} max={50} value={draft.followPerDay} onChange={(e) => set('followPerDay', Number(e.target.value))} />
          <button className="link" disabled={!!busy || !session?.loggedIn} onClick={() => void run('follow', async () => { await save(); const r = await window.api.followSyncNow(); return r.error ? r.error : `Followed ${r.followed.length} account(s) this run.` })}>{busy === 'follow' ? 'Following… (this takes a few minutes)' : 'Run a batch now'}</button>
        </label>
      </section>

      <section>
        <h2>Daily edition</h2>
        <label>Posts per day <input type="number" min={10} max={500} value={draft.dailyLimit} onChange={(e) => set('dailyLimit', Number(e.target.value))} /></label>
        <label>Build automatically at <input type="number" min={0} max={23} value={draft.buildHour} onChange={(e) => set('buildHour', Number(e.target.value))} /> :00
          <input type="checkbox" checked={draft.autoBuild} onChange={(e) => set('autoBuild', e.target.checked)} /> enabled</label>
        <label>Timeline pages to read <input type="number" min={2} max={40} value={draft.homePages} onChange={(e) => set('homePages', Number(e.target.value))} /> <span className="muted small">(roughly 25 posts each)</span></label>
        <label>Search pages per query <input type="number" min={1} max={5} value={draft.searchPages} onChange={(e) => set('searchPages', Number(e.target.value))} /></label>
      </section>

      <section>
        <h2>Priority accounts</h2>
        <p className="muted small">Every original post from these accounts goes in, no cap. One handle per line.</p>
        <textarea rows={6} value={priorityText} onChange={(e) => { setPriorityText(e.target.value); set('priorityHandles', e.target.value.split(/\n|,/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean)) }} placeholder={'@someone\n@someone_else'} />
      </section>

      <section>
        <h2>AI topic searches</h2>
        <p className="muted small">X search syntax. Each is run against the last 24 hours, Top results, from anyone on X. One per line.</p>
        <textarea rows={5} value={searchText} onChange={(e) => { setSearchText(e.target.value); set('searchQueries', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)) }} />
      </section>

      <section>
        <h2>Interest profile</h2>
        <p className="muted small">Claude reads this when ranking. Your upvotes and downvotes are added as examples automatically.</p>
        <textarea rows={10} value={draft.interestProfile} onChange={(e) => set('interestProfile', e.target.value)} />
        <label><input type="checkbox" checked={draft.claudeEnabled} onChange={(e) => set('claudeEnabled', e.target.checked)} /> Use Claude for ranking</label>
        <label>Model <input value={draft.claudeModel} onChange={(e) => set('claudeModel', e.target.value)} /></label>
        <label>Anthropic API key <input type="password" placeholder={draft.hasAnthropicKey ? '•••••••• (saved)' : 'sk-ant-…'} value={secrets.anthropicApiKey ?? ''} onChange={(e) => setSecrets({ ...secrets, anthropicApiKey: e.target.value })} /></label>
      </section>

      <section>
        <h2>Backups</h2>
        <p className="muted small">
          Your votes are what the filter learns from, and they cannot be rebuilt. Every vote is appended to <code>votes.jsonl</code> the moment it happens,
          a JSON snapshot of all votes and settings follows shortly after, and a copy of the whole database is kept after each build (the newest seven).
          The default folder is in iCloud Drive when you have it, so it survives this Mac.
        </p>
        <label>Backup folder <input value={draft.backupDir} placeholder={backup?.dir ?? ''} onChange={(e) => set('backupDir', e.target.value)} /></label>
        <div className="row">
          <span className="small">
            {backup
              ? `${backup.interactions} interactions in the database · ${backup.loggedEvents} logged · ${backup.files} files · last backup ${backup.lastBackupAt ? new Date(backup.lastBackupAt).toLocaleString() : 'never'}`
              : 'Checking…'}
          </span>
          <span className="head-actions">
            <button className="link" onClick={() => void window.api.openBackupFolder()}>Show in Finder</button>
            <button className="link" disabled={!!busy} onClick={() => void run('restore', async () => { const r = await window.api.restoreBackup(); setBackup(await window.api.getBackupStatus()); return r.ok ? `Restored ${r.imported} interactions.` : r.error === 'cancelled' ? '' : `Restore failed: ${r.error}` })}>Restore from a file…</button>
            <button className="secondary" disabled={!!busy} onClick={() => void run('backup', async () => { await save(); const r = await window.api.backupNow(); setBackup(await window.api.getBackupStatus()); return r.ok ? 'Backed up.' : `Backup failed: ${r.error}` })}>{busy === 'backup' ? 'Backing up…' : 'Back up now'}</button>
          </span>
        </div>
      </section>

      <section>
        <h2>How the filter is learning</h2>
        {stats ? (
          <table className="table">
            <tbody>
              <tr><td>Votes cast</td><td>{stats.votes}</td></tr>
              <tr><td>Heuristic scorer accuracy (AUC)</td><td>{fmt(stats.heuristicAuc)}</td></tr>
              <tr><td>Claude scorer accuracy (AUC)</td><td>{fmt(stats.claudeAuc)}</td></tr>
              <tr><td>Blended accuracy (AUC)</td><td>{fmt(stats.blendAuc)}</td></tr>
              <tr><td>Current trust weights</td><td>heuristic {stats.weights.heuristic.toFixed(2)} · Claude {stats.weights.claude.toFixed(2)}</td></tr>
              <tr><td>Authors with learned preference</td><td>{stats.authorsLearned}</td></tr>
              <tr><td>Topic words with learned preference</td><td>{stats.tokensLearned}</td></tr>
            </tbody>
          </table>
        ) : null}
        <p className="muted small">AUC is the chance a random upvoted post was scored above a random downvoted one. 0.5 is a coin flip; it needs a dozen or so votes of each kind to mean anything. Weights are refit every time an edition is built.</p>
      </section>
    </div>
  )
}

const fmt = (x: number | null): string => (x === null ? 'not enough votes yet' : x.toFixed(2))
