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

/** Where a post lives. X posts have numeric ids; Bluesky posts use their at:// URI as id. */
export type Network = 'x' | 'bsky'

/** A link preview a post carries (Bluesky attaches these to posts as cards). */
export interface LinkCard {
  url: string
  title: string
  description: string
  image?: string
}

/** A Community Note X is showing under a post: context other readers rated helpful. */
export interface CommunityNote {
  text: string
  url?: string
}

export interface Tweet {
  id: string
  /** Absent means X. */
  network?: Network
  /** Bluesky: the content hash the API needs to like, repost, reply to, or quote this post. */
  cid?: string
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
  /** Reposted from your real account, through this app. */
  reposted?: boolean
  /** English translation, when the post is in another language and was translated. */
  translation?: string
  card?: LinkCard
  communityNote?: CommunityNote
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

/** A vote: 2 is a super upvote for a post that was extremely valuable, 1 an upvote (also a like), -1 a downvote. */
export type Vote = 2 | 1 | -1 | 0

export interface EditionItem extends ScoredTweet {
  rank: number
  vote: Vote
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

/** One turn of a Talk-to-Claude conversation about a post. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

/** A piece of a streamed reply: text to append, or a note on what Claude is doing (searching, reading a page). */
export interface ChatDelta {
  text?: string
  status?: string
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
  /** Handle seen in your own account's optional web session, used only for replies and quotes the API refuses. */
  webHandle: string
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
  /** How the edition is laid out: priority accounts first then by score, oldest first, or newest first. */
  ordering: Ordering
  /** Translate posts not in English while building the edition. Needs the Anthropic key. */
  autoTranslate: boolean
  /** How often to check for replies, mentions, and quotes, in minutes; 0 means only by hand. */
  notifyEveryMinutes: number
  /** Pull recent likes and replies from your real account daily, through the API, as training signal. */
  historySync: boolean
  lastHistorySyncDate: string | null
  historyImportedAt: string | null
  /** Bluesky, read and written through its API with your own account; posts join the same edition. */
  bskyEnabled: boolean
  bskyHandle: string
  bskyDid: string
  hasBskyPassword: boolean
  bskyPriorityHandles: string[]
  bskySearchQueries: string[]
  /** Pages of the Bluesky following feed to read (100 posts each). */
  bskyPages: number
}

export interface HistoryStatus {
  importedAt: string | null
  lastSyncDate: string | null
  likes: number
  replies: number
}

export type Ordering = 'priority' | 'chronological' | 'newest'

/** One vote, open, or reply, recorded with the post it was about so a backup stands on its own. */
export interface Interaction {
  at: string
  kind: 'vote' | 'opened' | 'replied'
  editionId: number
  editionDate: string
  tweetId: string
  vote: Vote
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
  bskyAppPassword?: string
  /** The Bluesky session tokens, kept by the app itself so it rarely has to log in again. */
  bskySession?: string
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

export type PostNetwork = Network | 'both'

/** An account the composer can offer when you type @ and a few letters. */
export interface HandleSuggestion {
  handle: string
  name: string
  avatar: string
  network: Network
}

export interface PostResult {
  ok: boolean
  ids: string[]
  error?: string
  /** web: at least one part went through your own web session because the API refused it. */
  via?: 'api' | 'web'
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
  /** Your own account's web session: opt-in, for the replies and quotes X's API refuses. */
  getWebSessionStatus(): Promise<SessionStatus>
  openWebLogin(): Promise<SessionStatus>
  webLogout(): Promise<SessionStatus>
  refreshFollowing(): Promise<Settings>
  /** Picks the X data archive (zip or folder) and files its likes and replies as history. */
  importArchive(): Promise<{ ok: boolean; likes?: number; replies?: number; error?: string }>
  syncHistory(): Promise<{ ok: boolean; likes?: number; replies?: number; error?: string }>
  getHistoryStatus(): Promise<HistoryStatus>
  followSyncNow(): Promise<{ followed: string[]; error?: string }>
  verifyXApi(): Promise<{ ok: boolean; handle?: string; error?: string }>
  verifyBsky(): Promise<{ ok: boolean; handle?: string; error?: string }>

  getTodayEdition(): Promise<Edition | null>
  getEdition(id: number): Promise<Edition | null>
  listEditions(): Promise<EditionSummary[]>
  buildEdition(force: boolean): Promise<Edition | null>
  getProgress(): Promise<Progress | null>

  vote(editionId: number, tweetId: string, vote: Vote): Promise<{ ok: boolean; likeError?: string }>
  repost(tweetId: string): Promise<{ ok: boolean; error?: string }>
  /** Takes back a repost made from your account. */
  unrepost(tweetId: string): Promise<{ ok: boolean; error?: string }>
  /** Vote on any post, whether or not it is in an edition. */
  voteOnTweet(tweet: Tweet, vote: Vote): Promise<{ ok: boolean; likeError?: string }>
  getVote(tweetId: string): Promise<Vote>
  markOpened(editionId: number, tweetId: string): Promise<void>
  getThread(tweetId: string): Promise<Thread>
  getTweet(tweetId: string, cachedOnly?: boolean): Promise<Tweet | null> // cachedOnly: never load a page, just what is already known
  /** Translates a post into English with Claude and returns the updated post. */
  translateTweet(tweetId: string): Promise<Tweet | null>

  getNotifications(refresh: boolean): Promise<NotificationSummary>
  markNotificationsRead(ids: string[]): Promise<void>

  getDms(refresh: boolean): Promise<DmSummary>
  sendDm(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>

  /** quoteId: the first post quotes that post. network: where a fresh post goes; a reply or quote follows the post it answers. */
  postThread(texts: string[], replyToId?: string, quoteId?: string, network?: PostNetwork): Promise<PostResult>
  /** Accounts whose handle or name starts with what was typed after an @, from everything the app has read, best first. */
  suggestHandles(prefix: string, network: PostNetwork): Promise<HandleSuggestion[]>
  /** Asks Claude about a post and its discussion; the reply streams through onChatDelta under requestId, and arrives whole here. */
  askClaude(tweetId: string, messages: ChatMessage[], requestId: string): Promise<{ ok: boolean; text?: string; error?: string }>
  stopClaude(requestId: string): Promise<void>
  getScorerStats(): Promise<ScorerStats>
  getBackupStatus(): Promise<BackupStatus>
  backupNow(): Promise<{ ok: boolean; error?: string }>
  restoreBackup(): Promise<{ ok: boolean; imported: number; error?: string }>
  openBackupFolder(): Promise<void>
  openExternal(url: string): Promise<void>

  onProgress(cb: (p: Progress) => void): () => void
  onChatDelta(cb: (requestId: string, delta: ChatDelta) => void): () => void
  onNavigate(cb: (dir: 'back' | 'forward') => void): () => void // a trackpad swipe asked to go back or forward
  onThreadUpdated(cb: (t: Thread) => void): () => void // a stored discussion was refreshed from X
  onNotificationsUpdated(cb: () => void): () => void // the scheduled check found something new
}
