// Relevance + draft generation.
//
// NOTE: In production this is backed by a private scoring engine that is NOT
// part of this repository. What lives here is a small, transparent stand-in so
// the rest of the pipeline is runnable and reviewable end to end. It does two
// things:
//   1. score a post for topical relevance (simple keyword overlap), and
//   2. draft a helpful, non-promotional reply for a human to review.
//
// The drafting rules below are deliberately conservative: replies are meant to
// be genuinely useful answers, NOT advertisements. A human edits and approves
// every reply before it is posted (see server.ts), so nothing here ever reaches
// Reddit without review.

import type { RawItem } from "./sources.js";

export interface ScoredItem extends RawItem {
  score: number;
  matchedTerms: string[];
  draft: string;
}

// Topics this assistant can speak to helpfully. Replace with your own.
const KEYWORDS = [
  "verification",
  "verify",
  "background check",
  "trust",
  "scam",
  "fraud",
  "vetting",
  "licensed",
  "insured",
  "credential",
  "identity",
  "due diligence",
];

function scoreText(text: string): { score: number; matched: string[] } {
  const haystack = text.toLowerCase();
  const matched = KEYWORDS.filter((k) => haystack.includes(k));
  // Score is just the count of distinct matched topics, capped at 100.
  return { score: Math.min(matched.length * 20, 100), matched };
}

// Compose a short, helpful reply. This is intentionally generic and reads like
// a person offering practical advice, not a sales pitch.
function draftReply(matched: string[]): string {
  const topic = matched[0] || "this";
  return [
    `A few practical things that tend to help with ${topic}:`,
    "",
    "1. Ask for documentation up front (license number, proof of insurance) and confirm it against the issuing authority's public lookup.",
    "2. Get references you can actually call, not just names on a page.",
    "3. Put the scope and milestones in writing before any money changes hands.",
    "",
    "Happy to expand on any of these if it's useful.",
  ].join("\n");
}

export function scoreItem(item: RawItem): ScoredItem | null {
  const { score, matched } = scoreText(`${item.title} ${item.excerpt}`);
  if (score <= 0) return null;
  return { ...item, score, matchedTerms: matched, draft: draftReply(matched) };
}

export function scoreAll(items: RawItem[]): ScoredItem[] {
  const scored: ScoredItem[] = [];
  for (const it of items) {
    const s = scoreItem(it);
    if (s) scored.push(s);
  }
  // Highest relevance first.
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
