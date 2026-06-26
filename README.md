# Reddit Founder Engine

A **review-first** assistant that helps a single human take part in relevant Reddit
discussions. It discovers recent posts on a configured set of subreddits, drafts a
helpful reply, emails the drafts to a person for approval, and **only posts a comment
to Reddit after that person explicitly approves it with one click**. Nothing is ever
posted automatically.

This repository contains the complete, self-contained code that touches the Reddit
API. The relevance/scoring logic that decides which posts are worth a reply is backed
by a private engine in production; a small, transparent stand-in (`src/relevance.ts`)
is included here so the pipeline is fully runnable and reviewable end to end.

---

## What it does with the Reddit API

| Purpose | Method & endpoint | Auth |
| --- | --- | --- |
| Discover recent posts | `GET https://www.reddit.com/r/<sub>/new.rss` (public Atom feed) | none |
| Obtain an access token | `POST https://www.reddit.com/api/v1/access_token` (script-app password grant) | client id/secret + account |
| Verify the account | `GET https://oauth.reddit.com/api/v1/me` | bearer token |
| Post **one** reply comment | `POST https://oauth.reddit.com/api/comment` | bearer token |

That is the entire surface area. There is no scraping of authenticated endpoints, no
voting, no mass messaging, no automated posting.

## How posting is gated (anti-spam by design)

1. A scan drafts a reply and stores it as **`pending`** (`src/store.ts`).
2. A digest email links to a confirmation page for each draft (`src/email.ts`). Each
   link carries an **HMAC token** (`?t=`) that only the holder of `APPROVAL_SECRET`
   can generate. This token is the bearer capability that authorizes posting, and it
   travels **only** in the email — no route ever discloses it.
3. The confirmation page (`GET /reddit/approve/:id?t=`) validates the token, then lets
   the human **edit** the reply. Without a valid token the page is not rendered.
4. Submitting the page (`POST /reddit/post/:id`) re-verifies the token, **atomically
   claims** the row so it can never be posted twice, then calls `POST /api/comment`.

Because both viewing and submitting require a token that exists only in the emailed
link, neither an email client that auto-follows inbox links nor anyone who merely
guesses a reply id can publish anything. The admin routes (`/reddit/replies`,
`/reddit/check`) are gated behind a separate `ADMIN_TOKEN` and **fail closed** (return
404 when unset). Without an `APPROVAL_SECRET` the posting flow is **disabled**
(fail-closed), never falling back to a guessable value.

## Rate / volume

- A human approves **every** comment individually — that is the real throttle.
- `MAX_DRAFTS_PER_RUN` caps how many drafts a scan surfaces (default 5).
- Access tokens are cached in memory for their ~1h lifetime to avoid re-auth churn.
- A unique, descriptive `REDDIT_USER_AGENT` is sent on every request, per Reddit's API rules.

## Project layout

```
src/
  reddit.ts      Reddit auth + checkConnection + postComment  (the only writer)
  sources.ts     public subreddit RSS discovery (read path)
  relevance.ts   transparent stand-in for the private scoring engine + draft text
  store.ts       JSON-file store of pending/posted replies (atomic claim, no native deps)
  nonce.ts       HMAC approval token shared by the email link and review server
  email.ts       daily digest of drafts with one-click review links (token-bearing)
  server.ts      review server: token-gated approve page + post route (fail-closed)
  scan.ts        one discovery -> draft -> digest cycle
  index.ts       starts the server; optional scheduled scans
```

## Setup

1. Create a **script** app at <https://www.reddit.com/prefs/apps> (redirect uri
   `http://localhost:8080`). Copy the client id and secret.
2. `cp .env.example .env` and fill in the four `REDDIT_*` values, a long random
   `APPROVAL_SECRET`, and your `SUBREDDITS`.
3. Install and run:

   ```bash
   npm install
   npm start          # start the review server
   npm run scan       # run one discovery/draft cycle (writes a digest)
   ```

4. Confirm connectivity: open `http://localhost:8080/reddit/check` — it returns the
   Reddit account replies will be posted as.

## Configuration

| Variable | Purpose |
| --- | --- |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | script-app credentials |
| `REDDIT_USERNAME` / `REDDIT_PASSWORD` | the account that posts replies |
| `REDDIT_USER_AGENT` | unique, descriptive UA required by Reddit |
| `SUBREDDITS` | comma-separated subreddits to scan |
| `MAX_DRAFTS_PER_RUN` | cap on drafts surfaced per scan (default 5) |
| `APPROVAL_SECRET` | signs approval links; required for posting |
| `PUBLIC_BASE_URL` | base URL used to build approval links |
| `DIGEST_TO` | recipient of the digest; if unset, digest is written to a local HTML file |
| `SCAN_INTERVAL_HOURS` | optional; run a scan every N hours while the server is up |

## License

Provided for review. © Axon Integrity LLC.
