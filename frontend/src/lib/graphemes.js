/**
 * Counting characters the way a person would.
 *
 * `String.length` counts UTF-16 code units, so "🎉" is 2, "🇮🇳" is 4, and a
 * letter from one of Unicode's decorative alphabets is 2 — which means a
 * `maxLength={50}` input silently cuts a 25-emoji name in half, sometimes
 * mid-emoji, leaving a replacement glyph.
 *
 * Mirrors the server's check in setupProfile so the counter you see and the
 * limit that's enforced are the same number.
 */

let segmenter;
try {
  segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
} catch {
  segmenter = null;
}

/** The list of user-perceived characters in `value`. */
export const graphemes = (value) => {
  const text = String(value ?? "");
  if (!segmenter) {
    // No Segmenter: code points at least keep an emoji intact, and only get
    // multi-codepoint sequences like flags wrong.
    return [...text];
  }
  return [...segmenter.segment(text)].map((s) => s.segment);
};

export const graphemeLength = (value) => graphemes(value).length;

/** Truncates without ever splitting a character in half. */
export const clampGraphemes = (value, max) => {
  const list = graphemes(value);
  return list.length <= max ? String(value ?? "") : list.slice(0, max).join("");
};
