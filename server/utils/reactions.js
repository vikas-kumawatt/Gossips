/**
 * What may be stored as a reaction.
 *
 * `emoji` used to be taken verbatim at all three entry points — the HTTP
 * `toggleReaction`, the socket `addReaction`, and `Message.addReaction` itself.
 * Nothing checked its type, its length, or that it was an emoji at all, and the
 * upsert in `addReaction` ran without `runValidators`, so the schema's
 * `required` never fired either: omitting the field entirely stored the literal
 * string "undefined".
 *
 * The size is what made it more than cosmetic. A one-megabyte "emoji" is stored
 * on the MessageReaction row, copied into the message's cached
 * `reactionSummary.top`, and then rebroadcast to the whole room on every
 * subsequent reaction to that message — one write buys unbounded fan-out.
 *
 * So this is an allowlist, and a narrow one: exactly one grapheme cluster, made
 * only of emoji code points, and it has to actually be pictographic rather than
 * merely emoji-adjacent (a bare "1" is Emoji_Component).
 */

/*
 * Checked before segmenting, not after.
 *
 * Intl.Segmenter walks the whole string, so validating length afterwards would
 * mean doing linear work on a payload sized by the attacker. The longest
 * legitimate reaction is a four-person ZWJ family sequence at eleven UTF-16
 * code units; 64 leaves room for anything Unicode adds without being a budget.
 */
export const MAX_EMOJI_LENGTH = 64;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Everything a legitimate emoji is built from: the pictograph itself, the
// components (skin-tone modifiers, keycap digits, regional indicators), the
// zero-width joiner that binds a sequence, and the variation selector that
// asks for the emoji rather than the text presentation.
const EMOJI_CODEPOINTS = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u;

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Keycaps and flags carry no pictograph, so they need naming separately.
const KEYCAP = /^[0-9#*]️?⃣$/u;
const FLAG = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;

/**
 * The emoji to store, or null if it isn't one.
 *
 * Returns rather than throws so each caller can shape its own refusal — the
 * HTTP path wants a 400, the socket path an `error` event.
 */
export const parseReactionEmoji = (raw) => {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_EMOJI_LENGTH) return null;

  if ([...graphemes.segment(value)].length !== 1) return null;
  if (!EMOJI_CODEPOINTS.test(value)) return null;
  if (!PICTOGRAPHIC.test(value) && !KEYCAP.test(value) && !FLAG.test(value)) {
    return null;
  }
  return value;
};

/**
 * Skin tone rides along as a separate integer and was equally untrusted — it is
 * only ever 1..6 in every picker, and a non-integer reached the schema as a
 * cast error surfaced from a catch block as "failed to react".
 */
export const parseSkinTone = (raw) => {
  const tone = Number(raw);
  if (!Number.isInteger(tone) || tone < 1 || tone > 6) return 1;
  return tone;
};
