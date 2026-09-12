import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed end-user identity, computed on the host's server.
 *
 * The widget carries a publishable key that identifies the tenant and nothing
 * more. Without this signature, a logged-in user's id is just a string the
 * browser sends, so anyone could open devtools, claim to be another user, and
 * read that person's entire support history. The secret never reaches the
 * browser; only the digest does.
 */
export function signUserIdentity(externalId: string, secret: string): string {
  return createHmac("sha256", secret).update(externalId).digest("hex");
}

export function verifyUserIdentity(
  externalId: string,
  userHash: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signUserIdentity(externalId, secret));
  const actual = Buffer.from(userHash);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
