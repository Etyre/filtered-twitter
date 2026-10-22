// Types shared between the main process and the renderer.

export interface Media {
  type: 'photo' | 'video' | 'animated_gif'
  url: string // preview image
  videoUrl?: string
  width?: number
  height?: number
}

export interface Author {
  id: string
  handle: string
  name: string
  avatar: string
  verified?: boolean
  followers?: number
}

export interface Poll {
  options: { label: string; votes: number }[]
  totalVotes: number
  endsAt?: string // ISO
  final: boolean // counts are final (poll closed)
}

export interface Tweet {
  id: string
  conversationId: string
  text: string
  createdAt: string // ISO
  author: Author
  likes: number
  reposts: number
  replies: number
  quotes: number
  views: number
  inReplyToId?: string
  inReplyToHandle?: string
  media: Media[]
  quoted?: Tweet
  poll?: Poll
  retweetOf?: Tweet
  retweetedBy?: Author
  urls: { short: string; expanded: string; display: string }[]
  lang?: string
  liked?: boolean
}

export type Source = 'priority' | 'following' | 'search' | 'foryou' | 'notification'
export type Category = 'breaking_news' | 'interesting' | 'discourse' | 'personal' | 'skip'

export interface ScoredTweet {
  tweet: Tweet
  source: Source
  heuristicScore: number // 0..1
  claudeScore: number | null // 0..1
  finalScore: number // 0..1
  category: Category
  reason: string
  priorityAccount: boolean
}

export interface EditionItem extends ScoredTweet {
  rank: number
  vote: 1 | -1 | 0
  opened: boolean
  replied: boolean
}

export interface Edition {
  id: number
  date: string // YYYY-MM-DD
  builtAt: string
  itemCount: number
  candidateCount: number
  priorityCount: number
  notes: string
  items: EditionItem[]
}

export interface EditionSummary {
  id: number
  date: string
  builtAt: string
  itemCount: number
  candidateCount: number
  priorityCount: number
  votesCast: number
}

export interface Notification {
  id: string
  kind: 'reply' | 'mention' | 'quote' | 'other'
  createdAt: string
  tweet?: Tweet
  text?: string
  fromHandles: string[]
  read: boolean
}

export interface NotificationSummary {
  items: Notification[]
  fetchedAt: string | null
}

export interface Thread {
  focal: Tweet
  ancestors: Tweet[]
  replies: ReplyNode[]
}

export interface ReplyNode {
  tweet: Tweet
  children: ReplyNode[]
}

export interface DmMessage {
  id: string
  conversationId: string
  senderId: string
  text: string
  createdAt: string
  mine: boolean
  urls: { short: string; expanded: string; display: string }[]
  tweetIds: string[] // posts shared in this message, rendered as cards
}

export interface DmParticipant {
  id: string
  handle: string
  name: string
  avatar: string
}

export interface DmConversation {
  id: string
  participants: DmParticipant[] // excluding you
  lastAt: string
  messages: DmMessage[]
}

export interface DmSummary {
  conversations: DmConversation[]
  fetchedAt: string | null
  error?: string
}

export interface Settings {
  dailyLimit: number
  buildHour: number // 0-23 local
  autoBuild: boolean
  priorityHandles: string[]
  searchQueries: string[]
  interestProfile: string
  claudeEnabled: boolean
  claudeModel: string
  homePages: number
  searchPages: number
  blendWeights: { bias: number; heuristic: number; claude: number }
  hasAnthropicKey: boolean
  hasXApiKeys: boolean
  /** Your real account: writes and DMs only, through the official API. */
  xUserId: string
  xHandle: string
  /** The disposable browsing account that does all the reading. */
  browsingHandle: string
  proxyUrl: string
  followSync: boolean
  followPerDay: number
  /** Accounts your real account follows, as seen by the browsing account. */
  followingHandles: string[]
  followingFetchedAt: string | null
  /** Accounts the browsing account already follows. */
  browsingFollows: string[]
  lastFollowSyncDate: string | null
  /** Where votes are backed up; empty means the default (iCloud Drive if present, else Documents). */
  backupDir: string
  lastBackupAt: string | null
}

/** One vote, open, or reply, recorded with the post it was about so a backup stands on its own. */
export interface Interaction {
  at: string
  kind: 'vote' | 'opened' | 'replied'
  editionId: number
  editionDate: string
  tweetId: string
  vote: 1 | -1 | 0
  opened: boolean
  replied: boolean
  heuristic: number
  claude: number | null
  final: number
  source: string
  tweet: Tweet
}

export interface BackupStatus {
  dir: string
  lastBackupAt: string | null
  interactions: number // votes, opens, and replies in the database
  loggedEvents: number // lines in votes.jsonl
  files: number
}

export interface Secrets {
  anthropicApiKey?: string
  xConsumerKey?: string
  xConsumerSecret?: string
  xAccessToken?: string
  xAccessSecret?: string
}

export interface ScorerStats {
  votes: number
  heuristicAuc: number | null
  claudeAuc: number | null
  blendAuc: number | null
  weights: { bias: number; heuristic: number; claude: number }
  authorsLearned: number
  tokensLearned: number
}

export interface Progress {
  phase: string
  detail: string
  done: boolean
  error?: string
}

export interface SessionStatus {
  loggedIn: boolean
  handle: string | null
  checkedAt: string
}

export interface PostResult {
  ok: boolean
  ids: string[]
  error?: string
}

export interface IpCheck {
  direct: string | null
  browsing: string | null
  error?: string
}

export interface Api {
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  saveSecrets(secrets: Secrets): Promise<Settings>
  getSessionStatus(): Promise<SessionStatus>
  openLogin(): Promise<SessionStatus>
  openSignup(): Promise<SessionStatus>
  logout(): Promise<SessionStatus>
  checkIp(): Promise<IpCheck>
  refreshFollowing(): Promise<Settings>
  followSyncNow(): Promise<{ followed: string[]; error?: string }>
  verifyXApi(): Promise<{ ok: boolean; handle?: string; error?: string }>

  getTodayEdition(): Promise<Edition | null>
  getEdition(id: number): Promise<Edition | null>
  listEditions(): Promise<EditionSummary[]>
  buildEdition(force: boolean): Promise<Edition | null>
  getProgress(): Promise<Progress | null>

  vote(editionId: number, tweetId: string, vote: 1 | -1 | 0): Promise<{ ok: boolean; likeError?: string }>
  repost(tweetId: string): Promise<{ ok: boolean; error?: string }>
  /** Vote on any post, whether or not it is in an edition. */
  voteOnTweet(tweet: Tweet, vote: 1 | -1 | 0): Promise<{ ok: boolean; likeError?: string }>
  getVote(tweetId: string): Promise<1 | -1 | 0>
  markOpened(editionId: number, tweetId: string): Promise<void>
  getThread(tweetId: string): Promise<Thread>
  getTweet(tweetId: string, cachedOnly?: boolean): Promise<Tweet | null> // cachedOnly: never load a page, just what is already known

  getNotifications(refresh: boolean): Promise<NotificationSummary>
  markNotificationsRead(ids: string[]): Promise<void>

  getDms(refresh: boolean): Promise<DmSummary>
  sendDm(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>

  postThread(texts: string[], replyToId?: string): Promise<PostResult>
  getScorerStats(): Promise<ScorerStats>
  getBackupStatus(): Promise<BackupStatus>
  backupNow(): Promise<{ ok: boolean; error?: string }>
  restoreBackup(): Promise<{ ok: boolean; imported: number; error?: string }>
  openBackupFolder(): Promise<void>
  openExternal(url: string): Promise<void>

  onProgress(cb: (p: Progress) => void): () => void
  onThreadUpdated(cb: (t: Thread) => void): () => void // a stored discussion was refreshed from X
}
