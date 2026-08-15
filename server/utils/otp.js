import crypto from "crypto";

/**
 * The cryptographic core of the signup OTP, kept apart from the controller.
 *
 * Not for tidiness: everything here is pure, and `authController.js` cannot be
 * imported without SMTP credentials and a Firebase service account, so logic left
 * inside it is logic no test can reach. These three functions are where the
 * feature is actually breakable — a biased generator, a leaky comparison, or a
 * hash an attacker with the database can invert — so they are the part that has
 * to be exercised directly.
 */

export const OTP_LENGTH = 6;
export const OTP_RE = /^\d{6}$/;

/**
 * A uniformly random six-digit code, leading zeros included.
 *
 * `crypto.randomInt` and not `Math.random`: the latter is a PRNG whose output is
 * predictable from previous outputs, which for a code that authorises account
 * creation means an attacker who watches a few of their own signups can guess
 * somebody else's. `randomInt` is also rejection-sampled, so it is uniform over
 * the range rather than biased low the way `% 1000000` would be.
 */
export const generateOtp = () =>
  String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");

/**
 * How a code is stored: an HMAC, keyed on the server secret and bound to a scope.
 *
 * Not a bare sha256. There are only a million six-digit codes, so a plain digest
 * is a rainbow table somebody has already built — anyone reading the collection
 * recovers every live code in the time it takes to hash a million integers. The
 * key is the part an attacker holding the database does not have.
 *
 * `scopeId` is the pending-signup row's id, so a hash lifted from one row cannot
 * be replayed against another. The `otp:v1:` prefix domain-separates this use of
 * the secret from the JWTs signed with it, so no input to one can be made to
 * collide with the other.
 *
 * @param {string} secret  the server secret; `JWT_SECRET` at the call site
 */
export const hashOtp = (secret, scopeId, code) =>
  crypto.createHmac("sha256", secret).update(`otp:v1:${scopeId}:${code}`).digest("hex");

/**
 * Compare two hashes in constant time.
 *
 * `===` on hex strings leaks, through how long it takes to fail, how many leading
 * characters matched. Inverting an HMAC from that is not practical, but it costs
 * a line to remove the signal. `timingSafeEqual` throws on a length mismatch, so
 * that case is handled first — and it is not itself a leak, because the length of
 * a sha256 hex digest is a constant.
 */
export const otpMatches = (storedHash, candidateHash) => {
  const stored = Buffer.from(String(storedHash), "utf8");
  const candidate = Buffer.from(String(candidateHash), "utf8");
  if (stored.length !== candidate.length) return false;
  return crypto.timingSafeEqual(stored, candidate);
};
