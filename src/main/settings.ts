import { safeStorage } from 'electron'
import type { Secrets, Settings } from '@shared/types'
import { getSecretBlob, getSetting, setSecretBlob, setSetting } from './db'

const DEFAULT_PROFILE = `I want to stay engaged with the world without being addicted to the feed.

Big things I care about: important AI developments (new frontier models, major lab announcements, safety and alignment research, AI policy and regulation, notable papers and benchmarks, compute and chips). Surprising, consequential news in science and technology. Genuinely new arguments or evidence, not hot takes.

Small things I care about: interesting or funny posts from people I follow, personal updates from friends, thoughtful threads, good writing, clever observations.

I don't want: outrage bait, culture war, engagement farming, crypto shilling, generic motivational content, repetitive commentary on the same news, replies-as-dunks.`

const DEFAULT_QUERIES = [
  '(OpenAI OR Anthropic OR DeepMind OR "frontier model") min_faves:300 -filter:replies',
  '(AGI OR "AI safety" OR alignment OR "AI policy") min_faves:200 -filter:replies',
  '(GPT OR Claude OR Gemini OR Llama) (launch OR release OR announce) min_faves:300 -filter:replies'
]

export const DEFAULTS: Settings = {
  dailyLimit: 100,
  buildHour: 7,
  autoBuild: true,
  priorityHandles: [],
  searchQueries: DEFAULT_QUERIES,
  interestProfile: DEFAULT_PROFILE,
  claudeEnabled: true,
  claudeModel: 'claude-opus-5-5',
  homePages: 12,
  searchPages: 2,
  blendWeights: { bias: 0, heuristic: 1, claude: 1 },
  hasAnthropicKey: false,
  hasXApiKeys: false,
  xUserId: '',
  xHandle: '',
  browsingHandle: '',
  proxyUrl: '',
  followSync: true,
  followPerDay: 12,
  followingHandles: [],
  followingFetchedAt: null,
  browsingFollows: [],
  lastFollowSyncDate: null,
  backupDir: '',
  lastBackupAt: null
}

const SECRET_KEYS: (keyof Secrets)[] = ['anthropicApiKey', 'xConsumerKey', 'xConsumerSecret', 'xAccessToken', 'xAccessSecret']

export function readSecret(key: keyof Secrets): string | null {
  const blob = getSecretBlob(key)
  if (!blob) return null
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(blob) : blob.toString('utf8')
  } catch {
    return null
  }
}

export function writeSecrets(secrets: Secrets): void {
  for (const k of SECRET_KEYS) {
    const v = secrets[k]
    if (v === undefined) continue // untouched
    if (v === '') {
      setSecretBlob(k, null)
      continue
    }
    const blob = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(v) : Buffer.from(v, 'utf8')
    setSecretBlob(k, blob)
  }
}

export function loadSettings(): Settings {
  const raw = getSetting('settings')
  const stored = raw ? (JSON.parse(raw) as Partial<Settings>) : {}
  const s: Settings = { ...DEFAULTS, ...stored }
  s.hasAnthropicKey = !!readSecret('anthropicApiKey')
  s.hasXApiKeys = !!(readSecret('xConsumerKey') && readSecret('xConsumerSecret') && readSecret('xAccessToken') && readSecret('xAccessSecret'))
  return s
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings()
  const next: Settings = { ...current, ...patch }
  const { hasAnthropicKey: _a, hasXApiKeys: _b, ...persist } = next
  void _a
  void _b
  setSetting('settings', JSON.stringify(persist))
  return loadSettings()
}

export function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').replace(/\/.*$/, '').toLowerCase()
}
