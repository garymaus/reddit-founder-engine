// Durable store for pending/posted replies.
//
// One record per discovered post we drafted a reply for. A record moves through:
//   pending  ->  (claimed)  ->  posted   (success)
//                          \->  pending  (released on failure, so a human can retry)
//
// The atomic claim (see claimForPosting) is what prevents a double-submit or an
// email-scanner prefetch from ever posting the same reply twice. The review
// server is a single Node process, so the claim is a synchronous compare-and-set
// guarded in-memory and then flushed to disk.
//
// Persistence is a plain JSON file — zero native dependencies, trivial to clone
// and inspect. Swap in SQLite/Postgres here if you need multi-process writers.

import fs from "fs";
import crypto from "crypto";

export interface ReplyRow {
  id: string;
  item_id: string;
  subreddit: string;
  thing_id: string;
  title: string;
  url: string;
  score: number;
  draft_text: string;
  status: "pending" | "posted";
  claim_token: string | null;
  comment_id: string | null;
  permalink: string | null;
  error: string | null;
  created_at: string;
  posted_at: string | null;
}

const DB_PATH = process.env.DB_PATH || "founder-engine.json";

function load(): Record<string, ReplyRow> {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(data: Record<string, ReplyRow>): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
}

let cache: Record<string, ReplyRow> = load();

// Deterministic, URL-safe id for a reply, derived from the post's item id so
// re-runs map to the same record (and the same approval link). This is an
// identifier, not an auth token — the POST is protected by a separate HMAC.
export function replyId(itemId: string): string {
  return crypto.createHash("sha256").update(itemId).digest("hex").slice(0, 24);
}

// Insert a pending reply. Idempotent on item_id, so a post that reappears across
// scans keeps its original record. Returns true only when a new record is created.
export function insertPending(row: {
  itemId: string;
  subreddit: string;
  thingId: string;
  title: string;
  url: string;
  score: number;
  draftText: string;
}): boolean {
  const id = replyId(row.itemId);
  if (cache[id]) return false; // already exists (item_id is the natural key)
  cache[id] = {
    id,
    item_id: row.itemId,
    subreddit: row.subreddit,
    thing_id: row.thingId,
    title: row.title,
    url: row.url,
    score: row.score,
    draft_text: row.draftText,
    status: "pending",
    claim_token: null,
    comment_id: null,
    permalink: null,
    error: null,
    created_at: new Date().toISOString(),
    posted_at: null,
  };
  save(cache);
  return true;
}

export function getReply(id: string): ReplyRow | null {
  return cache[id] ? { ...cache[id] } : null;
}

export function listReplies(limit = 50): ReplyRow[] {
  return Object.values(cache)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((r) => ({ ...r }));
}

// Atomically claim a pending reply for posting. Only the first caller wins.
export function claimForPosting(id: string): string | null {
  const row = cache[id];
  if (!row || row.status !== "pending" || row.claim_token !== null) return null;
  const token = `claim:${crypto.randomBytes(8).toString("hex")}`;
  row.claim_token = token;
  save(cache);
  return token;
}

export function releaseClaim(id: string, token: string, error: string): void {
  const row = cache[id];
  if (!row || row.claim_token !== token) return;
  row.claim_token = null;
  row.error = error;
  save(cache);
}

export function markPosted(
  id: string,
  data: { text: string; commentId?: string; permalink?: string },
): void {
  const row = cache[id];
  if (!row) return;
  row.status = "posted";
  row.claim_token = null;
  row.draft_text = data.text;
  row.comment_id = data.commentId ?? null;
  row.permalink = data.permalink ?? null;
  row.error = null;
  row.posted_at = new Date().toISOString();
  save(cache);
}
