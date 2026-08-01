/**
 * Profile links, and the rule for what a scanned QR is allowed to open.
 *
 * The QR side is trivial; the scan side is the part that matters. A scanned code
 * is text supplied by whoever printed it, so treating it as a destination is the
 * same as following an untrusted link: a crafted QR could point at a phishing
 * page, or carry a `javascript:` URL. Nothing is navigated to unless it parses
 * as a profile on *this* origin.
 */

// Mirrors User.username in the schema: 3-30 of letters, numbers, underscore.
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,30}$/;

/*
 * `/:profileId` is a catch-all route, so these single-segment paths are real
 * pages rather than profiles. Without this a QR for "/settings" would parse as
 * a profile named "settings" and the scanner would claim it found an account.
 */
const RESERVED_PATHS = new Set([
  "login",
  "signup",
  "search",
  "activity",
  "followrequests",
  "profile-setup",
  "saved",
  "liked",
  "scheduled",
  "settings",
  "chat",
  "group",
  "reset-password",
  "admin",
  "terms",
  "privacy",
  "cookies",
  "ai-labels",
]);

// Long enough for any real link, short enough that a malformed payload can't be
// used to make URL parsing do a lot of work.
const MAX_SCAN_LENGTH = 2048;

export const isValidUsername = (username) =>
  typeof username === "string" && USERNAME_PATTERN.test(username);

export const buildProfileUrl = (username) => `${window.location.origin}/${username}`;

/**
 * The username a scanned code points at, or null.
 *
 * Deliberately strict — URLs on this origin only. Being liberal here (accepting
 * a bare handle, or any https URL) is exactly how a scanner turns into an open
 * redirect.
 */
export const parseProfileUrl = (text) => {
  if (typeof text !== "string") return null;

  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_SCAN_LENGTH) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // Blocks javascript:, data:, file: and app-scheme payloads before origin is
  // even considered — `origin` is "null" for those, but this is the explicit check.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // The control: same origin as the running app. A QR for another host is not
  // ours to follow, however plausible it looks.
  if (url.origin !== window.location.origin) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;

  // Percent-encoding is resolved before validating, so "%2e%2e" can't slip a
  // traversal past the charset check.
  let candidate;
  try {
    candidate = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }

  if (RESERVED_PATHS.has(candidate.toLowerCase())) return null;
  if (!isValidUsername(candidate)) return null;

  return candidate;
};
