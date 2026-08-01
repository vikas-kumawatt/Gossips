/**
 * Splitting text into the parts that are links and the parts that aren't.
 *
 * A deliberate mirror of server/utils/richText.js — the two regexes must agree,
 * or the app links a handle the server never notified, or notifies someone
 * whose handle renders as plain text.
 *
 * The rules, and why:
 *
 *   - A token starts at a boundary. `foo@bar` is an email address, `C#` is a
 *     language. The character before must be absent or non-word.
 *   - Handles match User.username: letters, digits, underscore, 3–30. A
 *     trailing full stop therefore falls outside the token, which is what you
 *     want at the end of a sentence.
 *   - Hashtags allow 1–100 characters but must contain a non-digit. `#2024` is
 *     a year, not a topic.
 *   - A token ends at a boundary too, or a run longer than the limit would be
 *     silently truncated into a token nobody typed.
 */

// One pass, so the tokens come out in document order and can't overlap.
const TOKEN_RE = /(^|[^\w@#])([@#])([a-zA-Z0-9_]{1,100})(?![a-zA-Z0-9_])/g;

const MENTION_MIN = 3;
const MENTION_MAX = 30;

/**
 * @param {string} text
 * @param {object} [options]
 * @param {string[]} [options.mentionUsernames] the handles that are allowed to
 *        be links. Omit to link every handle — used for direct messages, where
 *        there is no permission to check.
 * @returns {Array<{type: "text"|"mention"|"hashtag", value: string, key?: string}>}
 */
export const tokenizeRichText = (text, { mentionUsernames } = {}) => {
  const source = typeof text === "string" ? text : "";
  if (!source) return [];

  /*
   * `undefined` and `[]` mean different things and the difference matters. No
   * list at all is "don't check" (a DM); an empty list is "checked, and none of
   * them are allowed" — the state of a post whose every mention was refused.
   */
  const allowed = Array.isArray(mentionUsernames)
    ? new Set(mentionUsernames.map((name) => String(name).toLowerCase()))
    : null;

  const tokens = [];
  let lastIndex = 0;

  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(source)) !== null) {
    const [, prefix, sigil, word] = match;
    // Where the sigil is, not where the match is: the match includes the
    // boundary character before it, which belongs to the preceding text.
    const start = match.index + prefix.length;

    const lower = word.toLowerCase();
    const isMention =
      sigil === "@" && word.length >= MENTION_MIN && word.length <= MENTION_MAX;
    const isHashtag = sigil === "#" && !/^\d+$/.test(word);

    // A handle nobody allowed, an all-digit tag, a too-short @ — all just text.
    const linked = isMention ? !allowed || allowed.has(lower) : isHashtag;
    if (!linked) continue;

    if (start > lastIndex) {
      tokens.push({ type: "text", value: source.slice(lastIndex, start) });
    }
    tokens.push({
      type: isMention ? "mention" : "hashtag",
      value: `${sigil}${word}`,
      key: lower,
    });
    lastIndex = start + 1 + word.length;
  }

  if (lastIndex < source.length) {
    tokens.push({ type: "text", value: source.slice(lastIndex) });
  }

  return tokens;
};

/** A tag as it appears in a URL. Mirrors normalizeTag on the server. */
export const normalizeTag = (value) => {
  if (typeof value !== "string") return "";
  const tag = value.trim().replace(/^#/, "").toLowerCase();
  return /^[a-z0-9_]{1,100}$/.test(tag) && !/^\d+$/.test(tag) ? tag : "";
};
