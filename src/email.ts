// Daily digest email of drafted replies.
//
// Each drafted reply gets an "Approve & post" link that opens the review page
// served by server.ts. Non-Reddit items would simply omit the link; here every
// item is a Reddit post.
//
// Delivery is intentionally pluggable: if DIGEST_TO is set you can wire any
// provider (Resend, SES, Postmark, nodemailer, …) inside sendDigest. With no
// provider configured the digest is written to a local HTML file so the flow is
// fully runnable offline.

import fs from "fs";
import type { ReplyRow } from "./store.js";

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
}

export function renderDigestHtml(rows: ReplyRow[]): string {
  const base = baseUrl();
  const blocks = rows
    .map((r) => {
      const approve = `${base}/reddit/approve/${encodeURIComponent(r.id)}`;
      return `
      <tr><td style="padding:20px 0;border-bottom:1px solid #1f2937;">
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px;">r/${escapeHtml(r.subreddit)} · relevance ${r.score}</div>
        <a href="${escapeHtml(r.url)}" style="color:#f9fafb;font-size:16px;font-weight:600;text-decoration:none;display:block;margin-bottom:10px;">${escapeHtml(r.title.slice(0, 160))}</a>
        <div style="background:#0f172a;border-left:3px solid #2dd4bf;padding:12px 14px;border-radius:4px;margin-bottom:12px;color:#e5e7eb;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(r.draft_text)}</div>
        <a href="${escapeHtml(approve)}" style="display:inline-block;background:#2dd4bf;color:#0a0a0a;font-size:13px;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:6px;">Review &amp; post reply →</a>
      </td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Daily reply digest</title></head>
<body style="margin:0;background:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#f9fafb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;">
      <tr><td style="padding-bottom:20px;border-bottom:2px solid #2dd4bf;font-size:20px;font-weight:800;">${rows.length} drafted ${rows.length === 1 ? "reply" : "replies"} for review</td></tr>
      ${rows.length ? blocks : `<tr><td style="padding:40px 0;color:#6b7280;">Nothing relevant today.</td></tr>`}
      <tr><td style="padding-top:24px;font-size:11px;color:#4b5563;line-height:1.6;">Every reply is reviewed and approved by a person before it is posted. Nothing is posted automatically.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export async function sendDigest(rows: ReplyRow[]): Promise<{ ok: boolean; via: string }> {
  const html = renderDigestHtml(rows);
  const to = process.env.DIGEST_TO;

  if (!to) {
    const file = `digest-${new Date().toISOString().slice(0, 10)}.html`;
    fs.writeFileSync(file, html, "utf8");
    console.log(`[email] DIGEST_TO not set — wrote digest to ${file}`);
    return { ok: true, via: `file:${file}` };
  }

  // Wire your provider of choice here, e.g.:
  //   await resend.emails.send({ from, to, subject, html });
  // Left unimplemented so this repo has no provider dependency or credentials.
  console.log(`[email] would send digest to ${to} (${rows.length} replies). Wire a provider in src/email.ts.`);
  return { ok: true, via: `stub:${to}` };
}
