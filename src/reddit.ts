// Reddit API client — the only module that authenticates to and writes to Reddit.
//
// Auth model: a personal-use "script" app (https://www.reddit.com/prefs/apps)
// authenticated with the OAuth2 "password" grant. This needs no interactive
// authorize screen because the app posts only as its own owner.
//
// What it touches on the Reddit API:
//   POST https://www.reddit.com/api/v1/access_token   (obtain a bearer token)
//   GET  https://oauth.reddit.com/api/v1/me           (verify the account)
//   POST https://oauth.reddit.com/api/comment         (post ONE reply comment)
//
// A comment is only ever posted after a human approves the drafted reply from
// the daily email (see server.ts). This client never posts autonomously.

const REDDIT_API = "https://oauth.reddit.com";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const FETCH_TIMEOUT_MS = 15_000;

function userAgent(): string {
  return (
    process.env.REDDIT_USER_AGENT ||
    "web:com.example.reddit-founder-engine:v1.0 (by /u/your_username)"
  );
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function requireCredentials(): {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
} {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;
  if (!clientId || !clientSecret || !username || !password) {
    throw new Error(
      "Missing Reddit script credentials — set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD",
    );
  }
  return { clientId, clientSecret, username, password };
}

// Password-grant tokens last ~1h. Cache in-memory and refresh a minute early so
// we are not re-authenticating on every reply (and to stay under Reddit's auth
// rate limits).
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const { clientId, clientSecret, username, password } = requireCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetchWithTimeout(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "User-Agent": userAgent(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "password",
      username,
      password,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Reddit token HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data: any = await res.json();
  if (data?.error || !data?.access_token) {
    throw new Error(
      `Reddit token error: ${data?.error || "no access_token"} — check the credentials and that the app type is "script"`,
    );
  }
  const ttlMs = (Number(data.expires_in) || 3600) * 1000;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
  return data.access_token;
}

export interface RedditConnectionInfo {
  ok: boolean;
  username?: string;
  totalKarma?: number;
  error?: string;
}

// Connectivity probe — confirms the token works and reports which account
// replies will be posted as.
export async function checkConnection(): Promise<RedditConnectionInfo> {
  try {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(`${REDDIT_API}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent() },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Reddit HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const me: any = await res.json();
    return { ok: true, username: me?.name, totalKarma: me?.total_karma };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface RedditPostResult {
  ok: boolean;
  commentId?: string; // t1_xxxx fullname of the created comment
  permalink?: string; // absolute URL to the comment
  error?: string;
}

// Post a comment reply to a Reddit submission (a "thing" with a t3_ fullname).
// Reddit surfaces validation/rate-limit problems inside json.errors even on an
// HTTP 200, so we check that array explicitly.
export async function postComment(thingId: string, text: string): Promise<RedditPostResult> {
  const body = (text || "").trim();
  if (!thingId || !thingId.startsWith("t3_")) {
    return { ok: false, error: `invalid thing_id "${thingId}" (expected t3_…)` };
  }
  if (!body) return { ok: false, error: "empty comment text" };

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err: any) {
    return { ok: false, error: `Reddit auth failed: ${err?.message || err}` };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${REDDIT_API}/api/comment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        api_type: "json",
        thing_id: thingId,
        text: body.slice(0, 9000), // Reddit comment hard cap is 10k chars
      }).toString(),
    });
  } catch (err: any) {
    return { ok: false, error: `Reddit network error: ${err?.message || err}` };
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    return { ok: false, error: `Reddit HTTP ${res.status}: ${raw.slice(0, 300)}` };
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch (err: any) {
    return { ok: false, error: `Reddit non-JSON response: ${err?.message || err}` };
  }

  const errors: any[] = payload?.json?.errors ?? [];
  if (errors.length > 0) {
    const msg = errors
      .map((e) => (Array.isArray(e) ? e.slice(0, 2).join(": ") : String(e)))
      .join("; ");
    return { ok: false, error: `Reddit rejected the comment: ${msg}` };
  }

  const thing = payload?.json?.data?.things?.[0]?.data;
  if (!thing?.name) {
    return {
      ok: false,
      error: `Reddit returned no comment (unexpected shape): ${JSON.stringify(payload).slice(0, 200)}`,
    };
  }
  const permalink = thing.permalink ? `https://www.reddit.com${thing.permalink}` : undefined;
  return { ok: true, commentId: thing.name, permalink };
}

// Derive the submission fullname (t3_xxxx) from an internal item id of the form
// "reddit:<subreddit>:<base36 id>".
export function thingIdFromItem(itemId: string): string | null {
  if (!itemId.startsWith("reddit:")) return null;
  const parts = itemId.split(":");
  const shortId = parts.slice(2).join(":").trim();
  if (!shortId) return null;
  return shortId.startsWith("t3_") ? shortId : `t3_${shortId}`;
}
