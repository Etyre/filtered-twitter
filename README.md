# Filtered Twitter

A calm desktop client for X (and optionally Bluesky). One finite edition of about 100 posts a day, chosen for you, with the discussion underneath each one. Replies and mentions that need an answer. Your DMs. A composer for threads. Nothing that scrolls forever. Built from 21 October 2026 (Electron + React + SQLite, a Mac app) so that staying engaged with the world does not mean being pulled into an infinite feed.

## How it works

### Two accounts, kept apart

- **Browsing account.** A disposable X account logged into a hidden browser inside the app. It does all the reading: profiles of priority accounts, batched searches over everyone you follow, AI topic searches, a post's page for its replies, and a search for mentions of you. Reading X this way is against X's terms of service; if X ever objects, this is the account at risk. Its traffic can go through a proxy so it never shares your home address. Optionally it follows the same people you do, a few per day, so its own timeline becomes the main source and it looks like an ordinary account.
- **Your real account.** Touched through the official X API v2 with your developer keys: likes, reposts, replies, posts, and direct messages. The free developer tier covers everything except DMs, which last we knew need the Basic tier. One exception: since February 2026 the self-serve API tiers (Free, Basic, Pro, Pay-Per-Use) reply to or quote only posts whose author mentioned you. For the rest, you can optionally log your own account into a second hidden browser (Settings → Your account's web session); those replies and quotes then go through X's own composer, as if you were on the website. Nothing else uses that session, and it never goes through the proxy.

Bluesky, when enabled in Settings, is read and written through the official AT Protocol API with an app password; its posts are ranked alongside X's.

### Ranking

Two scorers. A local heuristic (engagement, recency, AI keywords, plus per-author and per-word preferences learned from your votes) and Claude, which reads your interest profile and your recent up/down votes as examples. A small logistic regression refit on every build learns how much to trust each scorer; Settings shows each scorer's accuracy against your votes. Every original post from a priority account goes in, uncapped. The rest of the daily budget goes to the top of the blended ranking, with near-duplicate news collapsed. Posts are never shown twice. Upvote sends a like from your real account; downvote just teaches the filter. Opening a discussion is a weak positive, replying a strong one.

### The daily cycle

While the app is running, a scheduler ticks every five minutes: at the configured hour it builds today's edition (candidates from the browsing account's timeline, priority profiles, following sweeps, topic searches and Bluesky; heuristic score; Claude score on the shortlist; blend; select; optional translation), runs the gradual follow sync, checks replies, mentions and quotes on the chosen interval, and pulls your own likes and replies through the API once a day (from 9:00) so the filter learns from them too. Discussions for today's posts are prefetched shortly after launch so opening one is instant. Votes are written to an append-only `votes.jsonl` in the backup folder the moment they happen, with a JSON snapshot and a daily database copy behind them.

If the Anki gate is on, the app stays behind an "Open Anki" screen each day until the chosen deck's review is done (checked through AnkiConnect, falling back to the collection file).

### Claude

Claude is used in three places: scoring candidates in batches of 30 (`src/main/ranking/claude.ts`), translating non-English posts (`src/main/translate.ts`), and "Talk to Claude", a side panel for discussing one post and its replies with web search and fetch (`src/main/chat.ts`). All three go through `src/main/llm.ts`, which keeps the agent-coding LLM contract: every system prompt starts with the shared preamble from `~/Documents/agent-coding/shared/llm-system-prompt-preamble.md` (read at call time, word for word), every call offers the `contact_eli` tool, and every response is piped to `python3 ~/Documents/agent-coding/shared/llm_contact.py check`. If Claude calls the tool or writes an `@ELI:` line, the shared inbox records the whole exchange and notifies Eli, and the task stops: a chat shows a message and ends, scoring sends no further batches (the edition notes say so), translation leaves the remaining posts untranslated.

### Drafts are never lost

Every text box (composer parts, DM replies, the Claude panel, the Settings form) saves on each keystroke to `localStorage` under a key naming the box and what it belongs to (`composer:reply:<id>`, `dm:drafts`, `claude:<post id>`, `settings:draft`), and is restored before it is first shown. Drafts are cleared only when the text is sent or saved. The API keys being typed in Settings are the one exception: they stay in memory until saved into the encrypted database.

## Files

| File | Purpose |
|---|---|
| `src/main/index.ts` | Electron main process: window, log, context menu, startup (database, proxy, browsers, IPC, scheduler, backups, prefetch, smoke test). |
| `src/main/edition.ts` | Builds the daily edition: gathers candidates, scores, blends, selects, translates. |
| `src/main/scheduler.ts` | Minute tick: auto-build, follow sync, notification checks, history sync. |
| `src/main/ranking/heuristic.ts` | Local scorer and the per-author/per-word model trained from votes. |
| `src/main/ranking/claude.ts` | Claude scorer (structured output, batches of 30, cached system prompt). |
| `src/main/ranking/blend.ts` | Logistic regression over the two scores, refit on every build. |
| `src/main/llm.ts` | Shared LLM contract: preamble, `contact_eli` tool, inbox check after every response. |
| `src/main/chat.ts` | "Talk to Claude" about one post, streamed, with web search and fetch. |
| `src/main/translate.ts` | Translates non-English posts with Claude, at build time or on demand. |
| `src/main/thread.ts` | Loads and caches a post's discussion (ancestors and reply tree). |
| `src/main/notifications.ts` | Replies, mentions and quotes of your posts, from the browsing account's searches. |
| `src/main/dms.ts` | Direct messages through the official API. |
| `src/main/follow.ts` | The browsing account gradually follows the people you follow. |
| `src/main/history.ts` | Imports your own likes and replies as votes. |
| `src/main/anki.ts` | The Anki gate: is today's review done? |
| `src/main/backup.ts` | `votes.jsonl`, JSON snapshots, daily database copies, restore. |
| `src/main/db.ts` | SQLite schema and queries (better-sqlite3). |
| `src/main/settings.ts` | Settings defaults, load/save, secrets via `safeStorage`. |
| `src/main/ipc.ts` | Every IPC handler the renderer can call. |
| `src/main/smoke.ts` | `FT_SMOKE=1` capture smoke test. |
| `src/main/x/browser.ts` | The hidden browser windows (browsing account and your web session), proxy, X's internal JSON endpoints. |
| `src/main/x/parse.ts` | Deep-walks X responses for tweet objects. |
| `src/main/x/official.ts` | X API v2 (OAuth 1.0a): likes, reposts, posts, DMs, following list. |
| `src/main/x/actions.ts` | Posting and replying, through the API or the web session when the API refuses. |
| `src/main/bsky/client.ts`, `src/main/bsky/parse.ts` | Bluesky reading and posting via `@atproto/api`. |
| `src/preload/index.ts` | The `window.api` bridge (contextIsolation on). |
| `src/renderer/src/App.tsx` | Views, navigation history, the Anki gate screen. |
| `src/renderer/src/components/*.tsx` | Today, Thread, Notifications, Chat (DMs), Compose, Composer, Archive, Settings, ClaudePanel, TweetCard, Sidebar, Lightbox. |
| `src/renderer/src/drafts.ts` | Draft persistence (`localStorage`) and the `useDraft` hook. |
| `src/renderer/src/speech.ts` | Read-aloud with the system voice. |
| `src/renderer/src/order.ts` | Edition ordering options. |
| `src/shared/types.ts`, `src/shared/net.ts` | Types and URL helpers shared by main and renderer. |
| `electron.vite.config.ts`, `tsconfig*.json` | Build configuration (electron-vite, three TypeScript projects). |
| `build/icon.icns`, `build/icon.svg` | App icon. |
| `package.json` | Scripts (`dev`, `build`, `typecheck`, `package`, `install-app`) and electron-builder config. |

## Runtime locations

- Data: `~/Library/Application Support/filtered-twitter/`: the SQLite database (`filtered-twitter.sqlite`: settings, editions, votes, cached discussions, and secrets encrypted with Electron's safeStorage, Keychain-backed), the browsing account's and your web session's Chromium partitions, and the log, `app.log` (ISO timestamps on every line; also printed to stdout in dev). The installed app and the dev build share all of it.
- Backups: the folder in Settings → Backups, by default `~/Library/Mobile Documents/com~apple~CloudDocs/Filtered Twitter backups` (iCloud Drive) or `~/Documents/Filtered Twitter backups` without iCloud.
- Installed app: `/Applications/Filtered Twitter.app` (unsigned, ad-hoc signed on install). Packaging output: `dist/mac-arm64/`. Production build: `out/`.
- LLM inbox (shared): `~/Library/Application Support/LLMInbox/messages.jsonl` and `~/Library/Logs/llm-inbox.log`; read with `llm-inbox`.
- Drafts: the renderer's `localStorage`, inside the app's `Local Storage/` folder under the data directory.

## Common tasks

```bash
npm install
npm run dev        # development, with hot reload
npm run typecheck  # tsc over main/preload and renderer
npm run build      # production build into out/
npx electron .     # run the production build
npm run package    # unsigned Filtered Twitter.app in dist/mac-arm64/
npm run install-app  # package, copy into /Applications, and ad-hoc sign it there

FT_SMOKE=1 npx electron .              # capture smoke test; results go to app.log as "SMOKE ..." lines
FT_SMOKE=1 FT_SMOKE_QUIT=1 npx electron .   # same, then quit
tail -f ~/Library/Application\ Support/filtered-twitter/app.log
llm-inbox list                         # messages Claude sent to Eli from this or any app

ssh -N -D 1080 somehost        # a SOCKS proxy for the browsing account; then set socks5://127.0.0.1:1080
```

The installed app shares its data with the dev build: both use `~/Library/Application Support/filtered-twitter/` and the same Keychain entry, so keys, the browsing session, and past editions carry over. Quit the dev app before launching the installed one, since the two cannot share the browser profile at the same time.

Testing without the real trigger: `FT_SMOKE=1` runs the capture pipeline (login check, a priority profile, the following list, a sweep, a search, the home timeline, a post's detail page) and logs each result. In the app, **Build today's edition** in Settings builds on demand instead of waiting for the morning hour, and **Check now** runs the notifications check.

## Settings that matter

1. **Developer keys.** At developer.x.com create a project and app. Under User authentication settings choose Read and Write (Read, Write and Direct Messages if you want Chat). Under Keys and Tokens generate the API key and secret and an Access Token and Secret. Paste all four in Settings and click **Save and verify keys**.
2. **Browsing account.** Create a fresh X account (phone verification will likely be required). Let it age a few days with a little ordinary use. In Settings, optionally set a proxy, then click **Log in** and sign in with that account. Use **Save and check IPs** to confirm the two addresses differ.
3. **Who gets read.** Click **Refresh following list** so the browsing account reads your public following list. Leave follow sync on so it gradually follows the same people.
4. **Anthropic key**, priority handles, interest profile, and topic searches in Settings.
5. Click **Build today's edition**. The first build takes a few minutes. After that it builds itself each morning at the configured hour while the app is running.

Proxy notes: only the browsing account's traffic goes through it. HTTP proxies support a username and password. SOCKS5 proxies must be unauthenticated (a Chromium limitation); a VPN's built-in SOCKS proxy or an SSH tunnel both work (see the `ssh -D` line above).

Cost: Claude scores about 300 candidates a day in batches of 30 with a cached system prompt. With Opus 5.5 this is on the order of 10 to 20 cents a day; switch the model in Settings to `claude-sonnet-5-5` or `claude-haiku-5-5` for less. The same model is used for translation and Talk to Claude.

Anki gate: needs Anki running with the AnkiConnect add-on for a live check; otherwise the collection file is read. The deck name and target are in Settings.

LLM inbox: the shared `~/Library/Application Support/LLMInbox/config.env` decides how Eli is notified when Claude contacts him (see `~/Documents/agent-coding/shared/README.md`). The app only needs `python3` on the Mac, which it has.

## Gotchas learned

- X changes its internal JSON shapes. The parser deep-walks responses for tweet objects, which is robust to most changes, but if a build returns far fewer candidates than usual, check `app.log`.
- A new browsing account may be rate-limited on search until it has aged. Lower the pages-per-query settings if builds stall.
- Quote-tweet notifications come from two searches by the browsing account (X's `quoted_user_id:` operator and a `url:` search for your post permalinks), so if X stops indexing either, quotes that do not mention you will be missed. Like and follow notifications are not shown at all.
- Sign in `/Applications` rather than in the project folder: when the project lives in an iCloud-synced folder, the file provider keeps re-adding metadata that makes `codesign` refuse the bundle. `install-app` refuses to install a packaged bundle whose asar lacks `out/renderer`, so a half-built package never replaces a working app.
- The dev app and the installed app cannot run at the same time: they share the Chromium profile in the data directory.
- Since February 2026 the self-serve X API tiers refuse replies to and quotes of posts whose author never mentioned you; the app routes those through your own web session when you have logged it in, or offers the x.com intent URL with the text filled in.
- Drafts live in `localStorage`, so clearing the app's data directory clears them too; the Settings draft is compared to the saved settings by value, because after a restart the objects are no longer the same.
- Every Claude call must go through `src/main/llm.ts`; a new call site that builds its own system prompt or skips `checkContact` breaks the shared contract silently. `translate.ts` and `ranking/claude.ts` pass the `contact_eli` tool alongside `output_config.format`; a tool call there leaves `parsed_output` null, which the code already tolerates.
