// Discovery (read path) — pulls recent posts from public subreddit feeds.
//
// Reads the openly-cached Atom feed at https://www.reddit.com/r/<sub>/new.rss.
// No auth is needed for these public feeds, and the .rss endpoint is served to
// non-browser clients where the unauthenticated .json endpoint is not. The
// authenticated API (oauth.reddit.com) is used only for the write path in
// reddit.ts, after a human approves a reply.

export interface RawItem {
  id: string; // "reddit:<sub>:<base36 id>"
  source: string; // "reddit/r/<sub>"
  title: string;
  excerpt: string;
  url: string;
  author?: string;
  postedAt: number;
}

const FETCH_TIMEOUT_MS = 12_000;

function userAgent(): string {
  return (
    process.env.REDDIT_USER_AGENT ||
    "web:com.example.reddit-founder-engine:v1.0 (by /u/your_username)"
  );
}

// The communities this bot operates in. Override with the SUBREDDITS env var.
const DEFAULT_SUBREDDITS =
  "HomeImprovement,Contractor,smallbusiness,Entrepreneur,TrustAndSafety,marketing,datacenters";

function subreddits(): string[] {
  return (process.env.SUBREDDITS || DEFAULT_SUBREDDITS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#32;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function stripHtml(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

interface RedditEntry {
  id: string;
  title: string;
  content: string;
  author: string;
  link: string;
  updated: number;
}

// Minimal Atom parser tuned to Reddit's RSS shape — avoids an XML dependency.
function parseRedditAtom(xml: string): RedditEntry[] {
  const entries: RedditEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const idMatch = block.match(/<id>([^<]+)<\/id>/);
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const contentMatch = block.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    const authorMatch = block.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/);
    const linkMatch = block.match(/<link[^>]+href="([^"]+)"/);
    const updatedMatch = block.match(/<updated>([^<]+)<\/updated>/);
    if (!idMatch || !titleMatch) continue;

    const author = authorMatch ? authorMatch[1].replace(/^\/u\//, "") : "";
    const updatedTs = updatedMatch ? Date.parse(updatedMatch[1]) : Date.now();
    entries.push({
      id: idMatch[1].trim(),
      title: stripHtml(stripCdata(titleMatch[1].trim())),
      content: contentMatch ? stripHtml(stripCdata(contentMatch[1].trim())) : "",
      author,
      link: linkMatch ? linkMatch[1] : "",
      updated: Number.isFinite(updatedTs) ? updatedTs : Date.now(),
    });
  }
  return entries;
}

export async function fetchSubreddits(): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (const sub of subreddits()) {
    try {
      const res = await fetchWithTimeout(
        `https://www.reddit.com/r/${sub}/new.rss?limit=50`,
        {
          headers: {
            "User-Agent": userAgent(),
            Accept: "application/atom+xml, application/xml, text/xml, */*",
          },
        },
      );
      if (!res.ok) {
        console.warn(`[sources] r/${sub} HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      for (const e of parseRedditAtom(xml)) {
        // Reddit Atom IDs look like "t3_1abcdef" or a tag URI; normalize so
        // dedupe across runs is stable even if Reddit changes the prefix.
        const shortId = (e.id.split("/").pop() || e.id).replace(/^tag:[^,]+,\d+:/, "");
        out.push({
          id: `reddit:${sub}:${shortId}`,
          source: `reddit/r/${sub}`,
          title: e.title.slice(0, 280),
          excerpt: e.content.slice(0, 800),
          url: e.link,
          author: e.author || undefined,
          postedAt: e.updated,
        });
      }
    } catch (err: any) {
      console.warn(`[sources] r/${sub} fetch failed:`, err?.message || err);
    }
  }
  return out;
}
