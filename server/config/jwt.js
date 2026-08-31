/**
 * How this API verifies and signs its tokens.
 *
 * Cryptographic Domain Separation:
 * Different token categories (access, refresh, verification tickets) derive separate
 * cryptographic signing secrets. This prevents signature reuse across token classes,
 * ensuring that a refresh token or verification token signature cannot verify against
 * an access token verification site even if a caller forgets to check `typ === "access"`.
 */
export const JWT_ALGORITHMS = ["HS256"];

export const JWT_VERIFY_OPTIONS = { algorithms: JWT_ALGORITHMS };

/**
 * Secret used for short-lived (15m) access tokens.
 */
export const getAccessTokenSecret = () =>
  process.env.JWT_ACCESS_SECRET || process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;

/**
 * Secret used for long-lived (7d) refresh tokens.
 */
export const getRefreshTokenSecret = () =>
  process.env.JWT_REFRESH_SECRET ||
  process.env.REFRESH_TOKEN_SECRET ||
  (process.env.JWT_SECRET ? process.env.JWT_SECRET + "_refresh" : undefined);

/**
 * Secret used for short-lived (10m) OTP verification tickets.
 */
export const getVerificationTicketSecret = () =>
  process.env.JWT_VERIFY_SECRET ||
  process.env.VERIFICATION_TICKET_SECRET ||
  (process.env.JWT_SECRET ? process.env.JWT_SECRET + "_verify" : undefined);

/**
 * Which token may authenticate an ordinary request — an allow-list, not a denylist.
 *
 * In addition to cryptographic secret separation, `isAccessToken` verifies the token
 * explicitly asserts `typ: "access"`.
 */
export const isAccessToken = (decoded) => decoded?.typ === "access";
