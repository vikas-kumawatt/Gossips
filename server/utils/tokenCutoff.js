import User from "../models/User.js";

/**
 * "Everything issued before this moment is void", per account.
 *
 * ── Why a denylist wasn't enough ────────────────────────────────────────────
 *
 * `utils/tokenRevocation.js` blocks *one named token*, which works for logout
 * because logout is holding the token it wants to kill. The security actions
 * are the opposite shape: resetting a password, "log out everywhere", and
 * refresh-token reuse detection all mean "void every access token this account
 * has anywhere", and none of them can enumerate those tokens — they are bearer
 * strings held on devices the server never sees.
 *
 * Deleting the `UserSession` rows, which is what those paths did, only stops
 * *refresh*. An access token already in an attacker's hands stayed valid for
 * the rest of its 15 minutes, so the three actions a person takes precisely
 * because they believe they are compromised each left the attacker in for up to
 * a quarter of an hour. This is the cutoff that closes that window.
 *
 * One timestamp on the user, compared against the token's own `iat`.
 */

/**
 * Void every access token issued for this account up to now.
 *
 * Call alongside — not instead of — deleting the account's `UserSession` rows:
 * this stops existing access tokens, those stop new ones being minted.
 */
export const invalidateIssuedTokens = (userId) =>
  User.updateOne({ _id: userId }, { $set: { sessionsValidFrom: new Date() } });

/**
 * Was this token issued before its account's cutoff?
 *
 * Compared in whole seconds, because `iat` has one-second granularity while the
 * cutoff is a millisecond timestamp. Flooring the cutoff rather than scaling
 * `iat` up is what keeps a token minted *during* the same second as the cutoff
 * valid — otherwise signing in immediately after a password reset could hand
 * out a token this check rejects, and the user could not get back in.
 *
 * @param {{iat?: number}} decoded a verified access token payload
 * @param {{sessionsValidFrom?: Date|null}} user
 */
export const isTokenBeforeCutoff = (decoded, user) => {
  const cutoff = user?.sessionsValidFrom;
  if (!cutoff) return false;
  if (typeof decoded?.iat !== "number") return true; // no `iat` to judge — refuse
  return decoded.iat < Math.floor(new Date(cutoff).getTime() / 1000);
};
