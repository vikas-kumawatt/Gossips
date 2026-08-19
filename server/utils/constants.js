/**
 * The placeholder avatar, as a path on the client's own origin.
 *
 * This used to be a hotlinked stock-image CDN URL, which was wrong in three
 * separate ways and only became visible when the CSP started blocking it:
 *
 *   · `models/User.js` already defaults `profilePic` to "/default-avatar.png",
 *     so the app had two different defaults depending on how you signed up —
 *     Google and OTP signups got the CDN, everything else got the local file.
 *   · The asset already ships in `frontend/public/default-avatar.png`. Fetching
 *     a stock-photo site instead meant a third party learned the IP and referrer
 *     of every visitor who saw an avatarless account.
 *   · It was a dependency on a URL nobody here controls. A rate limit, a moved
 *     file or a changed licence would silently blank avatars in production.
 *
 * A root-relative path resolves against whichever origin serves the client, so
 * it needs no configuration and works in development and production alike.
 */
export const DEFAULT_AVATAR_URL = "/default-avatar.png";

// Fields safe to return when listing users publicly
export const USER_PUBLIC_SELECT =
  "username name bio profilePic isVerified isPrivate followers following";

// Fields needed when populating an author reference on a post/comment
export const AUTHOR_SELECT =
  "username name bio profilePic isVerified isPrivate followers";
