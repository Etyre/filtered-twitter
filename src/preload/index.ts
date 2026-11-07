import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ChatDelta, Progress, Thread } from '@shared/types'

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveSecrets: (secrets) => ipcRenderer.invoke('secrets:save', secrets),
  getSessionStatus: () => ipcRenderer.invoke('session:status'),
  openLogin: () => ipcRenderer.invoke('session:login'),
  openSignup: () => ipcRenderer.invoke('session:signup'),
  logout: () => ipcRenderer.invoke('session:logout'),
  checkIp: () => ipcRenderer.invoke('session:checkIp'),
  getWebSessionStatus: () => ipcRenderer.invoke('web:status'),
  openWebLogin: () => ipcRenderer.invoke('web:login'),
  webLogout: () => ipcRenderer.invoke('web:logout'),
  refreshFollowing: () => ipcRenderer.invoke('following:refresh'),
  importArchive: () => ipcRenderer.invoke('history:import'),
  syncHistory: () => ipcRenderer.invoke('history:sync'),
  getHistoryStatus: () => ipcRenderer.invoke('history:status'),
  followSyncNow: () => ipcRenderer.invoke('follow:sync'),
  verifyXApi: () => ipcRenderer.invoke('xapi:verify'),
  verifyBsky: () => ipcRenderer.invoke('bsky:verify'),
  getTodayEdition: () => ipcRenderer.invoke('edition:today'),
  getEdition: (id) => ipcRenderer.invoke('edition:get', id),
  listEditions: () => ipcRenderer.invoke('edition:list'),
  buildEdition: (force) => ipcRenderer.invoke('edition:build', force),
  getProgress: () => ipcRenderer.invoke('edition:progress'),
  vote: (editionId, tweetId, vote) => ipcRenderer.invoke('vote', editionId, tweetId, vote),
  repost: (tweetId) => ipcRenderer.invoke('repost', tweetId),
  unrepost: (tweetId) => ipcRenderer.invoke('unrepost', tweetId),
  voteOnTweet: (tweet, vote) => ipcRenderer.invoke('vote:tweet', tweet, vote),
  getVote: (tweetId) => ipcRenderer.invoke('vote:get', tweetId),
  markOpened: (editionId, tweetId) => ipcRenderer.invoke('opened', editionId, tweetId),
  getThread: (tweetId) => ipcRenderer.invoke('thread', tweetId),
  getTweet: (tweetId, cachedOnly) => ipcRenderer.invoke('tweet:get', tweetId, !!cachedOnly),
  translateTweet: (tweetId) => ipcRenderer.invoke('tweet:translate', tweetId),
  getNotifications: (refresh) => ipcRenderer.invoke('notifications:get', refresh),
  markNotificationsRead: (ids) => ipcRenderer.invoke('notifications:read', ids),
  getDms: (refresh) => ipcRenderer.invoke('dms:get', refresh),
  sendDm: (conversationId, text) => ipcRenderer.invoke('dms:send', conversationId, text),
  postThread: (texts, replyToId, quoteId, network) => ipcRenderer.invoke('post', texts, replyToId, quoteId, network),
  suggestHandles: (prefix, network) => ipcRenderer.invoke('handles:suggest', prefix, network),
  askClaude: (tweetId, messages, requestId) => ipcRenderer.invoke('chat:ask', tweetId, messages, requestId),
  stopClaude: (requestId) => ipcRenderer.invoke('chat:stop', requestId),
  getScorerStats: () => ipcRenderer.invoke('scorer:stats'),
  getBackupStatus: () => ipcRenderer.invoke('backup:status'),
  backupNow: () => ipcRenderer.invoke('backup:now'),
  restoreBackup: () => ipcRenderer.invoke('backup:restore'),
  openBackupFolder: () => ipcRenderer.invoke('backup:open'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  getAnkiGate: () => ipcRenderer.invoke('anki:gate'),
  openAnki: () => ipcRenderer.invoke('anki:open'),
  onChatDelta: (cb) => {
    const handler = (_e: unknown, requestId: string, delta: ChatDelta): void => cb(requestId, delta)
    ipcRenderer.on('chat:delta', handler)
    return () => ipcRenderer.removeListener('chat:delta', handler)
  },
  onNavigate: (cb) => {
    const handler = (_e: unknown, dir: 'back' | 'forward'): void => cb(dir)
    ipcRenderer.on('navigate', handler)
    return () => ipcRenderer.removeListener('navigate', handler)
  },
  onThreadUpdated: (cb) => {
    const handler = (_e: unknown, t: Thread): void => cb(t)
    ipcRenderer.on('thread:updated', handler)
    return () => ipcRenderer.removeListener('thread:updated', handler)
  },
  onNotificationsUpdated: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('notifications:updated', handler)
    return () => ipcRenderer.removeListener('notifications:updated', handler)
  },
  onProgress: (cb) => {
    const handler = (_e: unknown, p: Progress): void => cb(p)
    ipcRenderer.on('progress', handler)
    return () => ipcRenderer.removeListener('progress', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
