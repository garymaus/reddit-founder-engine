// HMAC approval token shared by the email link and the review server.
//
// The token is a keyed HMAC of the reply id. Because it can only be produced
// with APPROVAL_SECRET, it acts as an unguessable bearer capability: it is
// embedded in the approval link we email to the owner and is required to both
// VIEW the confirmation page and SUBMIT the post. The server never mints or
// echoes it for an unauthenticated caller, so knowing a reply id is not enough
// to post — you must also hold the secret link from the email.
//
// Fail-closed: with no APPROVAL_SECRET the token cannot be made, so the approve
// and post routes are disabled rather than falling back to a guessable value.

import crypto from "crypto";

export function approvalSecret(): string | null {
  const s = process.env.APPROVAL_SECRET;
  return s && s.length > 0 ? s : null;
}

export function makeNonce(id: string): string | null {
  const secret = approvalSecret();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(`reddit:${id}`).digest("hex").slice(0, 32);
}

export function verifyNonce(id: string, nonce: string): boolean {
  if (!nonce || nonce.length !== 32) return false;
  const expected = makeNonce(id);
  if (!expected) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(nonce, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}
