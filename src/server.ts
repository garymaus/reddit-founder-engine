// Review server — the human-in-the-loop gate in front of every Reddit comment.
//
// Capability model: every approval link carries an unguessable HMAC token (?t=)
// that only the holder of APPROVAL_SECRET can produce. That token — delivered
// solely in the digest email — is required to BOTH view the confirmation page
// and submit the post. The server never mints or echoes it for an unauthorized
// caller, so knowing a reply id is not enough to post.
//   GET  /reddit/approve/:id?t=  validates the token, then renders an editable
//        confirmation page (no writes).
//   POST /reddit/post/:id        re-verifies the token, atomically claims the
//        row, posts the comment to Reddit, and records the result.
//   GET  /reddit/replies, /reddit/check  admin-only (ADMIN_TOKEN), fail closed.
//
// Fail-closed: without APPROVAL_SECRET the token cannot be made, so the approve
// and post routes are disabled rather than falling back to a guessable value.

import express from "express";
import crypto from "crypto";
import { postComment, checkConnection } from "./reddit.js";
import { getReply, listReplies, claimForPosting, releaseClaim, markPosted } from "./store.js";
import { verifyNonce } from "./nonce.js";

// Admin routes (listing/connectivity) are gated behind ADMIN_TOKEN. They fail
// closed: with no token configured they return 404 rather than leaking data.
function adminAuthorized(req: express.Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected.length === 0) return false;
  const got = String(req.query.token || req.get("x-admin-token") || "");
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, accent: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:36px 20px;background:#0a0a0a;color:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:${accent};margin-bottom:8px;">Reddit Founder Engine · Review</div>
    ${body}
  </div></body></html>`;
}

export function createServer(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Connectivity probe — confirms which account replies post as.
  // Admin-only: must present ADMIN_TOKEN (?token= or x-admin-token header).
  app.get("/reddit/check", async (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ ok: false, error: "not found" });
    res.json(await checkConnection());
  });

  // List pending/posted replies (simple admin view). Admin-only, fails closed —
  // reply ids are bearer-adjacent, so this is never exposed without ADMIN_TOKEN.
  app.get("/reddit/replies", (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, replies: listReplies() });
  });

  // Step 1 — editable confirmation page. No state change here.
  // Requires the HMAC token from the emailed link (?t=). Without a valid token
  // the page is not rendered and the nonce is never disclosed, so knowing a
  // reply id alone cannot reach the post step.
  app.get("/reddit/approve/:id", (req, res) => {
    const id = String(req.params.id || "").slice(0, 64);
    const token = String(req.query.t || "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!verifyNonce(id, token)) {
      return res
        .status(403)
        .send(page("Invalid link", "#f87171", `<div style="font-size:20px;">This approval link is invalid or has expired. Open the most recent link from your digest email.</div>`));
    }
    const row = getReply(id);
    if (!row) {
      return res
        .status(404)
        .send(page("Reply not found", "#f87171", `<div style="font-size:20px;">Reply not found — it may have expired.</div>`));
    }
    if (row.status === "posted") {
      const link = row.permalink
        ? `<div style="margin-top:18px;"><a href="${esc(row.permalink)}" target="_blank" rel="noopener" style="color:#34d399;">View your comment on Reddit →</a></div>`
        : "";
      return res.send(page("Already posted", "#34d399", `<div style="font-size:20px;">Already posted to Reddit.</div>${link}`));
    }
    // token was already validated above; reuse it as the form nonce.
    const nonce = token;
    return res.send(
      page(
        `Reply on r/${row.subreddit}?`,
        "#2dd4bf",
        `<div style="font-size:22px;font-weight:800;margin-bottom:6px;">Post this reply to Reddit?</div>
         <div style="font-size:13px;color:#9ca3af;margin-bottom:12px;">Replying to <a href="${esc(row.url)}" target="_blank" rel="noopener" style="color:#9ca3af;">${esc(row.title.slice(0, 120))}</a> in <strong>r/${esc(row.subreddit)}</strong>. Edit before posting if you like.</div>
         <form method="POST" action="/reddit/post/${encodeURIComponent(id)}" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').innerText='Posting…';">
           <input type="hidden" name="nonce" value="${esc(nonce)}" />
           <textarea name="text" rows="8" style="width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #1f2937;border-left:3px solid #2dd4bf;border-radius:6px;color:#e5e7eb;font-size:14px;line-height:1.6;padding:14px 16px;margin-bottom:18px;">${esc(row.draft_text)}</textarea>
           <button type="submit" style="background:#2dd4bf;color:#0a0a0a;border:none;font-size:14px;font-weight:700;padding:12px 22px;border-radius:6px;cursor:pointer;">Confirm &amp; post →</button>
         </form>
         <div style="margin-top:24px;font-size:11px;color:#4b5563;line-height:1.6;">This page opens only from the secret link in your digest email, and posting takes a second deliberate click — nothing is posted automatically.</div>`,
      ),
    );
  });

  // Step 2 — the only route that writes to Reddit.
  app.post("/reddit/post/:id", async (req, res) => {
    const id = String(req.params.id || "").slice(0, 64);
    const nonce = String((req.body && req.body.nonce) || "").trim();
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (!verifyNonce(id, nonce)) {
      return res.status(403).send(page("Invalid token", "#f87171", `<div style="font-size:20px;">Invalid confirmation token — open the email link again.</div>`));
    }
    const row = getReply(id);
    if (!row) {
      return res.status(404).send(page("Reply not found", "#f87171", `<div style="font-size:20px;">Reply not found.</div>`));
    }
    if (row.status === "posted") {
      return res.send(page("Already posted", "#34d399", `<div style="font-size:20px;">Already posted.</div>`));
    }

    const text = String((req.body && req.body.text) || "").trim() || String(row.draft_text || "").trim();
    if (!text) {
      return res.status(400).send(page("Empty reply", "#f87171", `<div style="font-size:20px;">Can't post an empty reply.</div>`));
    }

    // Atomic claim — only the first caller proceeds.
    const token = claimForPosting(id);
    if (!token) {
      return res.send(page("In progress", "#fbbf24", `<div style="font-size:20px;">This reply is already being posted.</div>`));
    }

    const result = await postComment(row.thing_id, text);
    if (!result.ok) {
      releaseClaim(id, token, result.error ?? "unknown error");
      return res
        .status(502)
        .send(page("Reddit error", "#f87171", `<div style="font-size:20px;margin-bottom:8px;">Reddit rejected the reply.</div><div style="font-size:14px;color:#fecaca;background:#3a0e0e;border-left:3px solid #f87171;padding:12px 14px;border-radius:4px;">${esc(result.error)}</div><div style="margin-top:14px;color:#9ca3af;">Open the email link again to retry.</div>`));
    }

    markPosted(id, { text, commentId: result.commentId, permalink: result.permalink });
    const link = result.permalink
      ? `<div style="margin-top:18px;"><a href="${esc(result.permalink)}" target="_blank" rel="noopener" style="color:#34d399;">View your comment on Reddit →</a></div>`
      : "";
    return res.send(page("Posted", "#34d399", `<div style="font-size:22px;font-weight:800;margin-bottom:8px;">Reply posted to Reddit.</div><div style="color:#9ca3af;">Your comment is live on the thread.</div>${link}`));
  });

  return app;
}
