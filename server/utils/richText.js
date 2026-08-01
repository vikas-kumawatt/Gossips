/**
 * What counts as an @mention and a #hashtag.
 *
 * One tokeniser, because three different regexes for "a mention" is how you
 * end up notifying someone the renderer never made a link, or linking someone
 * who was never notified. The client mirrors this file exactly — see
 * frontend/src/lib/richText.js.
 *
 * The rules, and why:
 *
 *   - A token must start at a boundary. `foo@bar` is an email address, not a
 *     mention of @bar, and `C#` is a language, not a hashtag. So the character
 *     before must be absent or non-word and not itself a `@`/`#`.
 *   - Handles match User.username: letters, digits, underscore, 3–30. A
 *     trailing `.` or `,` therefore falls outside the token naturally, which is
 *     what you want at the end of a sentence.
 *   - A token must also *end* at a boundary. Without a trailing lookahead,
 *     `{3,30}` matches the first 30 characters of a 40-character run and
 *     invents a handle nobody typed — the parser would then go looking for a
 *     user whose name is a truncation of somebody's word.
 *   - Hashtags allow 1–100 characters but must contain a non-digit. `#1` and
 *     `#2024` are years and rankings, not topics, and indexing them is noise.
 *   - Case is preserved for display and lowercased for lookup. `#Coffee` and
 *     `#coffee` are the same tag; the page shows whichever you typed.
 */

const MENTION_RE = /(^|[^\w@#])@([a-zA-Z0-9_]{3,30})(?![a-zA-Z0-9_])/g;
const HASHTAG_RE = /(^|[^\w@#])#([a-zA-Z0-9_]{1,100})(?![a-zA-Z0-9_])/g;

const MAX_SCAN_LENGTH = 20000;

/** Deduped, lowercased handles. */
export const parseMentionUsernames = (content = "") => {
  if (typeof content !== "string" || !content) return [];

  const found = new Set();
  MENTION_RE.lastIndex = 0;
  let match;
  while ((match = MENTION_RE.exec(content.slice(0, MAX_SCAN_LENGTH))) !== null) {
    found.add(match[2].toLowerCase());
  }
  return [...found];
};

/** Deduped, lowercased tags, without the leading #. */
export const parseHashtags = (content = "") => {
  if (typeof content !== "string" || !content) return [];

  const found = new Set();
  HASHTAG_RE.lastIndex = 0;
  let match;
  while ((match = HASHTAG_RE.exec(content.slice(0, MAX_SCAN_LENGTH))) !== null) {
    const tag = match[2].toLowerCase();
    // All-digit tags are years and rankings, not topics.
    if (!/^\d+$/.test(tag)) found.add(tag);
  }
  return [...found];
};

/**
 * A tag as it appears in a URL, and as a storage key.
 *
 * Exported so route handlers normalise the same way the parser does — a page
 * for "#Coffee" and one for "#coffee" must be the same page.
 */
export const normalizeTag = (value) => {
  if (typeof value !== "string") return "";
  const tag = value.trim().replace(/^#/, "").toLowerCase();
  return /^[a-z0-9_]{1,100}$/.test(tag) && !/^\d+$/.test(tag) ? tag : "";
};
