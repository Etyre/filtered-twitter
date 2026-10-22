# Filtered Twitter

A calm desktop client for X. One finite edition of about 100 posts a day, chosen for you, with the discussion underneath each one. Replies and mentions that need an answer. Your DMs. A composer for threads. Nothing that scrolls forever.

## Two accounts, kept apart

- **Browsing account.** A disposable X account logged into a hidden browser inside the app. It does all the reading: profiles of priority accounts, batched searches over everyone you follow, AI topic searches, a post's page for its replies, and a search for mentions of you. Reading X this way is against X's terms of service; if X ever objects, this is the account at risk. Its traffic can go through a proxy so it never shares your home address. Optionally it follows the same people you do, a few per day, so its own timeline becomes the main source and it looks like an ordinary account.
- **Your real account.** Touched only through the official X API v2 with your developer keys: likes, reposts, replies, posts, and direct messages. The free developer tier covers everything except DMs, which last we knew need the Basic tier.

## Ranking

Two scorers. A local heuristic (engagement, recency, AI keywords, plus per-author and per-word preferences learned from your votes) and Claude, which reads your interest profile and your recent up/down votes as examples. A small logistic regression refit on every build learns how much to trust each scorer; Settings shows each scorer's accuracy against your votes. Every original post from a priority account goes in, uncapped. The rest of the daily budget goes to the top of the blended ranking, with near-duplicate news collapsed. Posts are never shown twice. Upvote sends a like from your real account; downvote just teaches the filter. Opening a discussion is a weak positive, replying a strong one.

## Setup

```bash
npm install
npm run dev        # development, with hot reload
npm run build      # production build into out/
npx electron .     # run the production build
npm run package    # unsigned Filtered Twitter.app in dist/mac-arm64/
npm run install-app  # package, copy into /Applications, and ad-hoc sign it there
```

The installed app shares its data with the dev build: both use `~/Library/Application Support/filtered-twitter/` and the same Keychain entry, so keys, the browsing session, and past editions carry over. Sign in `/Applications` rather than in the project folder: when the project lives in an iCloud-synced folder, the file provider keeps re-adding metadata that makes `codesign` refuse the bundle. Quit the dev app before launching the installed one, since the two cannot share the browser profile at the same time.

1. **Developer keys.** At developer.x.com create a project and app. Under User authentication settings choose Read and Write (Read, Write and Direct Messages if you want Chat). Under Keys and Tokens generate the API key and secret and an Access Token and Secret. Paste all four in Settings and click **Save and verify keys**.
2. **Browsing account.** Create a fresh X account (phone verification will likely be required). Let it age a few days with a little ordinary use. In Settings, optionally set a proxy, then click **Log in** and sign in with that account. Use **Save and check IPs** to confirm the two addresses differ.
3. **Who gets read.** Click **Refresh following list** so the browsing account reads your public following list. Leave follow sync on so it gradually follows the same people.
4. **Anthropic key**, priority handles, interest profile, and topic searches in Settings.
5. Click **Build today's edition**. The first build takes a few minutes. After that it builds itself each morning at the configured hour while the app is running.

Proxy notes: only the browsing account's traffic goes through it. HTTP proxies support a username and password. SOCKS5 proxies must be unauthenticated (a Chromium limitation); a VPN's built-in SOCKS proxy or an SSH tunnel both work:

```bash
ssh -N -D 1080 somehost        # then set socks5://127.0.0.1:1080
```

Data lives in `~/Library/Application Support/filtered-twitter/`: the SQLite database, secrets encrypted with Electron's safeStorage (Keychain-backed), the browsing account's session, and `app.log`.

## Cost

Claude scores about 300 candidates a day in batches of 30 with a cached system prompt. With Opus 5.5 this is on the order of 10 to 20 cents a day; switch the model in Settings to `claude-sonnet-5-5` or `claude-haiku-5-5` for less.

## Caveats

- X changes its internal JSON shapes. The parser deep-walks responses for tweet objects, which is robust to most changes, but if a build returns far fewer candidates than usual, check `app.log`.
- A new browsing account may be rate-limited on search until it has aged. Lower the pages-per-query settings if builds stall.
- Quote-tweet notifications are only found when the quote also mentions you. Like and follow notifications are not shown at all.
- `FT_SMOKE=1 npx electron .` runs a capture smoke test and logs results to `app.log`.
