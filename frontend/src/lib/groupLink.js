/**
 * Group invite links.
 *
 * The token is what the server stores; the URL is composed here so a domain change
 * doesn't orphan every link ever sent — and so the same token renders correctly in a
 * QR code, a share sheet and the clipboard without three places agreeing on a format.
 *
 * `/join/g/<token>` rather than `/g/<token>`: `profileLink.js` treats the first path
 * segment as a username unless it's reserved, and adding one more reserved word is a
 * word nobody can ever use as a handle. A two-segment path under an existing reserved
 * prefix costs nothing.
 */

export const GROUP_INVITE_PATH = "/join/g";

/*
 * Base64url, which is what the server's `randomBytes(12).toString("base64url")`
 * produces: A-Z, a-z, 0-9, `-` and `_`. 16 characters for 12 bytes.
 *
 * Bounded at both ends so a pasted link with trailing punctuation — a full stop from
 * the end of a sentence, a `)` from a markdown link — is rejected rather than sent to
 * the server as a token that can never match.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidInviteToken = (token) =>
  typeof token === "string" && TOKEN_PATTERN.test(token);

/** The absolute URL to share. Falls back to the current origin at runtime. */
export const buildGroupInviteUrl = (token) => {
  if (!isValidInviteToken(token)) return "";
  const origin =
    (typeof window !== "undefined" && window.location?.origin) || "";
  return `${origin}${GROUP_INVITE_PATH}/${token}`;
};

/**
 * The token out of a pasted link, or null.
 *
 * Accepts a bare token as well as a full URL, because people paste both — and rejects
 * a link to a *different* origin, so scanning someone else's QR code can't send this
 * app's session token-shaped string to a group on another deployment.
 */
export const parseGroupInviteToken = (input) => {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (isValidInviteToken(raw)) return raw;

  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    // ["join", "g", "<token>"]
    if (parts.length !== 3 || parts[0] !== "join" || parts[1] !== "g") return null;
    return isValidInviteToken(parts[2]) ? parts[2] : null;
  } catch {
    return null;
  }
};
