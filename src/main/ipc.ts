import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { ChatMessage, IpCheck, PostNetwork, Secrets, SessionStatus, Settings, Thread, Tweet, Vote } from '@shared/types'
import * as db from './db'
import { cachedDms, refreshDms, sendDm } from './dms'
import { buildEdition, getProgress, localDate, onProgress } from './edition'
import { followSync, refreshFollowing } from './follow'
import { historyStatus, importArchive, syncHistory } from './history'
import { refreshNotifications, summary } from './notifications'
import { auc } from './ranking/blend'
import { trainHeuristic } from './ranking/heuristic'
import { loadSettings, normalizeBskyHandle, normalizeHandle, saveSettings, writeSecrets } from './settings'
import { loadThread, setThreadNotifier } from './thread'
import * as backup from './backup'
import * as actions from './x/actions'
import { translateOne } from './translate'
import { chatAboutPost, stopChat } from './chat'
import { applyProxy, openLoginWindow, REAL_PARTITION, XBrowser } from './x/browser'
import * as official from './x/official'
import * as bsky from './bsky/client'
import { isBskyId } from '@shared/net'
import { ankiGate, openAnki } from './anki'

export function registerIpc(browser: XBrowser, web: XBrowser, mainWin: () => BrowserWindow | null, log: (m: string) => void): void {
  onProgress((p) => mainWin()?.webContents.send('progress', p))

  ipcMain.handle('settings:get', () => loadSettings())
  // Fields the app maintains itself. The Settings form sends its whole draft, which may be minutes old, so these never come from it.
  const MACHINE_FIELDS: (keyof Settings)[] = [
    'browsingFollows', 'browsingHandle', 'webHandle', 'followingHandles', 'followingFetchedAt', 'lastFollowSyncDate', 'lastBackupAt', 'blendWeights', 'xUserId', 'hasAnthropicKey', 'hasXApiKeys',
    'lastHistorySyncDate', 'historyImportedAt', 'bskyDid', 'hasBskyPassword'
  ]
  ipcMain.handle('settings:save', async (_e, patch: Partial<Settings>) => {
    for (const k of MACHINE_FIELDS) delete patch[k]
    if (patch.priorityHandles) patch.priorityHandles = [...new Set(patch.priorityHandles.map(normalizeHandle).filter(Boolean))]
    if (patch.xHandle !== undefined) patch.xHandle = normalizeHandle(patch.xHandle)
    if (patch.bskyHandle !== undefined) patch.bskyHandle = normalizeBskyHandle(patch.bskyHandle)
    if (patch.bskyPriorityHandles) patch.bskyPriorityHandles = [...new Set(patch.bskyPriorityHandles.map(normalizeBskyHandle).filter(Boolean))]
    const before = loadSettings()
    if (patch.bskyHandle !== undefined && patch.bskyHandle !== before.bskyHandle) {
      bsky.reset()
      patch.bskyDid = ''
    }
    const next = saveSettings(patch)
    if (patch.proxyUrl !== undefined && patch.proxyUrl !== before.proxyUrl) {
      browser.close()
      await applyProxy(next.proxyUrl, log)
    }
    return next
  })
  ipcMain.handle('secrets:save', (_e, secrets: Secrets) => {
    writeSecrets(secrets)
    if (secrets.xAccessToken || secrets.xConsumerKey) saveSettings({ xUserId: '' }) // re-resolve on next use
    if (secrets.bskyAppPassword !== undefined) bsky.reset()
    return loadSettings()
  })

  // ----- browsing account session, and your own account's web session -----
  const statusOf = async (b: XBrowser, field: 'browsingHandle' | 'webHandle', probe: boolean): Promise<SessionStatus> => {
    const loggedIn = await b.isLoggedIn()
    let handle = loadSettings()[field] || null
    if (loggedIn && (probe || !handle)) {
      try {
        const h = await b.currentHandle()
        if (h) {
          handle = h
          saveSettings({ [field]: h })
        }
      } catch (e) {
        log('handle probe failed: ' + String(e))
      }
    }
    if (!loggedIn) handle = null
    return { loggedIn, handle, checkedAt: new Date().toISOString() }
  }
  const sessionStatus = (probe: boolean): Promise<SessionStatus> => statusOf(browser, 'browsingHandle', probe)
  ipcMain.handle('web:status', () => statusOf(web, 'webHandle', false))
  ipcMain.handle('web:login', async () => {
    await openLoginWindow(mainWin() ?? undefined, 'login', REAL_PARTITION)
    return statusOf(web, 'webHandle', true)
  })
  ipcMain.handle('web:logout', async () => {
    await web.logout()
    saveSettings({ webHandle: '' })
    return statusOf(web, 'webHandle', false)
  })
  ipcMain.handle('session:status', () => sessionStatus(false))
  ipcMain.handle('session:login', async () => {
    await openLoginWindow(mainWin() ?? undefined)
    return sessionStatus(true)
  })
  ipcMain.handle('session:signup', async () => {
    await openLoginWindow(mainWin() ?? undefined, 'signup')
    return sessionStatus(true)
  })
  ipcMain.handle('session:logout', async () => {
    await browser.logout()
    saveSettings({ browsingHandle: '', browsingFollows: [] })
    return sessionStatus(false)
  })
  ipcMain.handle('session:checkIp', async (): Promise<IpCheck> => {
    const out: IpCheck = { direct: null, browsing: null }
    try {
      out.direct = (await (await fetch('https://api.ipify.org')).text()).trim()
    } catch (e) {
      out.error = 'Direct check failed: ' + String(e)
    }
    try {
      const t = await browser.fetchTextViaPartition('https://api.ipify.org')
      out.browsing = /^[0-9a-f.:]+$/i.test(t) ? t : null
      if (!out.browsing) out.error = (out.error ? out.error + ' ' : '') + 'Browsing check returned no address (proxy unreachable?).'
    } catch (e) {
      out.error = (out.error ? out.error + ' ' : '') + 'Browsing check failed: ' + String(e)
    }
    return out
  })
  ipcMain.handle('following:refresh', async () => {
    await refreshFollowing(browser, log)
    return loadSettings()
  })
  ipcMain.handle('history:import', async () => {
    const win = mainWin() ?? undefined
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose your X data archive',
      message: 'The zip X sent you, or the folder it unpacks to',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'X archive', extensions: ['zip'] }, { name: 'All files', extensions: ['*'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
    try {
      return { ok: true, ...(await importArchive(r.filePaths[0], log)) }
    } catch (e) {
      log('history import failed: ' + String(e))
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
  ipcMain.handle('history:sync', async () => {
    try {
      return { ok: true, ...(await syncHistory(log)) }
    } catch (e) {
      log('history sync failed: ' + String(e))
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
  ipcMain.handle('history:status', () => historyStatus())
  ipcMain.handle('follow:sync', async () => {
    try {
      return { followed: await followSync(browser, log, true) }
    } catch (e) {
      return { followed: [], error: String(e) }
    }
  })

  // ----- real account (API) -----
  ipcMain.handle('xapi:verify', async () => {
    try {
      const m = await official.me()
      saveSettings({ xUserId: m.id, xHandle: m.username })
      return { ok: true, handle: m.username }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('bsky:verify', async () => {
    try {
      const r = await bsky.verify()
      return { ok: true, handle: r.handle }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ----- editions -----
  // Today's edition, or the last one until today's is built, so the view is never empty between builds.
  ipcMain.handle('edition:today', () => db.getEditionByDate(localDate()) ?? db.getLatestEdition())
  ipcMain.handle('edition:get', (_e, id: number) => db.getEdition(id))
  ipcMain.handle('edition:list', () => db.listEditions())
  ipcMain.handle('edition:build', (_e, force: boolean) => buildEdition(browser, log, force))
  ipcMain.handle('edition:progress', () => getProgress())

  // An upvote or super upvote also likes the post on its network, once: moving between the two keeps the like it already has.
  ipcMain.handle('vote', async (_e, editionId: number, tweetId: string, vote: Vote) => {
    const before = db.getVote(tweetId)
    db.setVote(editionId, tweetId, vote)
    const rec = backup.interactionRecord('vote', editionId, tweetId, vote)
    if (rec) backup.logInteraction(rec, log)
    if (vote >= 1 && before < 1) {
      const r = await actions.like(tweetId)
      return { ok: true, likeError: r.ok ? undefined : r.error }
    }
    return { ok: true }
  })
  ipcMain.handle('vote:tweet', async (_e, tweet: Tweet, vote: Vote) => {
    const before = db.getVote(tweet.id)
    const { editionId } = db.voteOnTweet(tweet, vote)
    const rec = backup.interactionRecord('vote', editionId, tweet.id, vote)
    if (rec) backup.logInteraction(rec, log)
    if (vote >= 1 && before < 1) {
      const r = await actions.like(tweet.id)
      return { ok: true, likeError: r.ok ? undefined : r.error }
    }
    return { ok: true }
  })
  ipcMain.handle('vote:get', (_e, tweetId: string) => db.getVote(tweetId))
  ipcMain.handle('repost', (_e, tweetId: string) => actions.repost(tweetId))
  ipcMain.handle('unrepost', (_e, tweetId: string) => actions.unrepost(tweetId))
  ipcMain.handle('opened', (_e, editionId: number, tweetId: string) => {
    db.setOpened(editionId, tweetId)
    const rec = backup.interactionRecord('opened', editionId, tweetId, 0)
    if (rec) backup.logInteraction(rec, log)
  })
  ipcMain.handle('backup:status', () => backup.status())
  ipcMain.handle('backup:now', () => backup.snapshot('manual', log))
  ipcMain.handle('backup:restore', () => backup.restoreFromFile(mainWin() ?? undefined, log))
  ipcMain.handle('backup:open', () => shell.openPath(backup.backupDir()).then(() => undefined))
  setThreadNotifier((t) => mainWin()?.webContents.send('thread:updated', t))
  const THREAD_FRESH_MS = 15 * 60_000
  ipcMain.handle('thread', (_e, tweetId: string): Promise<Thread> => {
    const hit = db.getCachedThread(tweetId)
    if (!hit) return loadThread(browser, tweetId, log)
    if (Date.now() - new Date(hit.fetchedAt).getTime() > THREAD_FRESH_MS) {
      // Show what we have now; send the fresh version when it arrives.
      void loadThread(browser, tweetId, log)
        .then((t) => mainWin()?.webContents.send('thread:updated', t))
        .catch((e) => log(`thread refresh ${tweetId} failed: ${String(e)}`))
    }
    return Promise.resolve(hit.thread)
  })
  const tweetLoads = new Map<string, Promise<Tweet | null>>() // one page load per post, however many cards ask
  ipcMain.handle('tweet:translate', (_e, tweetId: string) => translateOne(tweetId, log))
  ipcMain.handle('chat:ask', (_e, tweetId: string, messages: ChatMessage[], requestId: string) =>
    chatAboutPost(browser, tweetId, messages, requestId, (d) => mainWin()?.webContents.send('chat:delta', requestId, d), log))
  ipcMain.handle('chat:stop', (_e, requestId: string) => stopChat(requestId))
  ipcMain.handle('tweet:get', (_e, tweetId: string, cachedOnly: boolean): Promise<Tweet | null> => {
    const cached = db.getTweet(tweetId)
    if (cached || cachedOnly) return Promise.resolve(cached)
    let p = tweetLoads.get(tweetId)
    if (!p) {
      p = (isBskyId(tweetId) ? bsky.posts([tweetId]) : browser.tweetDetail(tweetId, 1))
        .then((tweets) => {
          db.upsertTweets(tweets)
          return tweets.find((t) => t.id === tweetId) ?? null
        })
        .catch((e) => {
          log(`tweet ${tweetId} failed: ${String(e)}`)
          return null
        })
        .finally(() => tweetLoads.delete(tweetId))
      tweetLoads.set(tweetId, p)
    }
    return p
  })

  ipcMain.handle('notifications:get', async (_e, refresh: boolean) => (refresh ? refreshNotifications(browser, log) : summary()))
  ipcMain.handle('notifications:read', (_e, ids: string[]) => db.markNotificationsRead(ids))

  ipcMain.handle('dms:get', (_e, refresh: boolean) => (refresh ? refreshDms(log) : cachedDms()))
  ipcMain.handle('dms:send', (_e, conversationId: string, text: string) => sendDm(conversationId, text))

  ipcMain.handle('post', async (_e, texts: string[], replyToId?: string, quoteId?: string, network?: PostNetwork) => {
    const r = await actions.postThread(texts, replyToId, quoteId, network)
    if (r.ok && replyToId) {
      const rec = backup.interactionRecord('replied', null, replyToId, 0)
      if (rec) backup.logInteraction({ ...rec, replied: true }, log)
      // The stored discussions no longer show your reply: forget them and send the parent's fresh one to whatever is open.
      db.expireThreadsWith(replyToId)
      void loadThread(browser, replyToId, log)
        .then((t) => mainWin()?.webContents.send('thread:updated', t))
        .catch((e) => log(`thread refresh after reply ${replyToId} failed: ${String(e)}`))
    }
    return r
  })

  ipcMain.handle('handles:suggest', (_e, prefix: string, network: PostNetwork) => {
    const s = loadSettings()
    return db.suggestHandles(prefix, network, { x: [...s.followingHandles, ...s.priorityHandles], bsky: s.bskyPriorityHandles })
  })

  ipcMain.handle('scorer:stats', () => {
    const history = db.getVoteHistory()
    const s = loadSettings()
    const m = trainHeuristic(history)
    return {
      votes: history.filter((h) => h.vote !== 0).length,
      heuristicAuc: auc(history, (h) => h.heuristic),
      claudeAuc: auc(history, (h) => h.claude),
      blendAuc: auc(history, (h) => h.final),
      weights: s.blendWeights,
      authorsLearned: m.authorsLearned,
      tokensLearned: m.tokensLearned
    }
  })
  ipcMain.handle('openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })
  ipcMain.handle('anki:gate', () => ankiGate())
  ipcMain.handle('anki:open', () => openAnki())
}
