// One scan cycle: read public subreddit feeds, score for relevance, persist a
// pending reply per relevant post, and send the digest for human review.
//
// Run directly with `npm run scan`, or call runScan() from a scheduler.

import { fetchSubreddits } from "./sources.js";
import { scoreAll } from "./relevance.js";
import { thingIdFromItem } from "./reddit.js";
import { insertPending, getReply, replyId } from "./store.js";
import { sendDigest } from "./email.js";
import type { ReplyRow } from "./store.js";

export async function runScan(): Promise<{ scanned: number; scored: number; drafted: number }> {
  const max = Math.max(1, Number(process.env.MAX_DRAFTS_PER_RUN) || 5);

  const raw = await fetchSubreddits();
  const scored = scoreAll(raw);
  const top = scored.slice(0, max);

  const rows: ReplyRow[] = [];
  for (const item of top) {
    const thingId = thingIdFromItem(item.id);
    if (!thingId) continue; // not a Reddit post
    const subMatch = item.source.match(/^reddit\/r\/(.+)$/);
    const subreddit = subMatch ? subMatch[1] : item.source;
    insertPending({
      itemId: item.id,
      subreddit,
      thingId,
      title: item.title,
      url: item.url,
      score: item.score,
      draftText: item.draft,
    });
    const row = getReply(replyId(item.id));
    if (row) rows.push(row);
  }

  if (rows.length > 0) await sendDigest(rows);

  console.log(`[scan] scanned=${raw.length} scored=${scored.length} drafted=${rows.length}`);
  return { scanned: raw.length, scored: scored.length, drafted: rows.length };
}

// Allow `tsx src/scan.ts` to run a single cycle directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[scan] failed:", err);
      process.exit(1);
    });
}
