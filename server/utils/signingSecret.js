import crypto from "crypto";

/**
 * The HMAC key for the server's own short signatures, and the domain separator
 * that keeps those signatures from being interchangeable.
 *
 * Two callers — utils/mediaToken.js and utils/chatLock.js. They had the same two
 * defects in the same two lines, which is the argument for one copy rather than
 * two: the same argument config/origins.js and config/jwt.js already make.
 *
 * ── Why it throws ───────────────────────────────────────────────────────────
 *
 * Both read `process.env.JWT_SECRET || ""`. An empty HMAC key is a perfectly
 * valid HMAC key — `createHmac("sha256", "")` signs and verifies quite happily —
 * so an instance booted without the variable kept minting tokens and kept
 * accepting them, signed with a key that is public knowledge. Nothing threw,
 * nothing logged, and every signature checked out. That is the worst shape a
 * security control can fail in.
 *
 * utils/keyVault.js already refuses to derive a key without its secret, and says
 * why: a fallback secret is not a secret. This is that rule applied to the other
 * two call sites.
 *
 * ── Why the domain ──────────────────────────────────────────────────────────
 *
 * Both callers signed a three-line `\n`-joined payload with the same key:
 * `url\ntype\nfileSize` for an attachment, `userId\nchatId\nexpiresAt` for a
 * chat-lock grant. Identical shape and identical key, so a signature over one is
 * arithmetically a valid signature over the other — an attachment token whose
 * three fields happened to read as a user id, a chat id and a future timestamp
 * would unlock that conversation.
 *
 * That is not reachable today. `url` is always a Cloudinary URL this server
 * chose, and a user id is 24 hex characters, so the two payload spaces do not
 * overlap. But that is a property of the current call sites rather than of the
 * design, and it holds only until something signs a descriptor from a different
 * source. The domain prefix makes the separation structural instead, and costs
 * one line — after which the paragraph above no longer has to stay true.
 */

/**
 * @returns {string} JWT_SECRET
 * @throws if it is unset or empty.
 */
export const signingSecret = () => {
  const secret = process.env.JWT_SECRET;

  if (typeof secret !== "string" || !secret) {
    throw new Error(
      "JWT_SECRET must be set. It signs access and refresh tokens, the OTP " +
        "HMAC, chat-lock grants and attachment tokens — an unset value means " +
        "every one of those is signed with an empty key. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }

  return secret;
};

/**
 * Sign `payload` under `domain`.
 *
 * The domain is part of the signed input rather than a separate field, so a
 * signature minted for one purpose does not verify under another. Domains are
 * fixed constants containing no newline, so prefixing is unambiguous.
 */
export const signFor = (domain, payload) =>
  crypto
    .createHmac("sha256", signingSecret())
    .update(`${domain}\n${payload}`)
    .digest("base64url");
