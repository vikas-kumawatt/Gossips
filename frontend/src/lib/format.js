/**
 * Number formatting for counts shown to people.
 */

/*
 * Built by Intl rather than by hand. A hand-rolled `/1000 + "K"` is wrong in
 * every locale that doesn't group by thousands — Hindi groups by lakh and crore
 * and would want "1.2 लाख" — and Intl already knows all of that.
 */
let compactFormatter;
try {
  compactFormatter = new Intl.NumberFormat(undefined, {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  });
} catch {
  compactFormatter = null;
}

let plainFormatter;
try {
  plainFormatter = new Intl.NumberFormat();
} catch {
  plainFormatter = null;
}

/**
 * A count, the way social apps write them: exact below a thousand, abbreviated
 * above it. 0 → "0", 999 → "999", 1234 → "1.2K", 12345 → "12.3K", 2400000 → "2.4M".
 *
 * Exact below 1,000 because at that size the precise number is the interesting
 * part — "847 views" says something "800 views" doesn't.
 */
export const compactCount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "0";

  if (n < 1000) return plainFormatter ? plainFormatter.format(n) : String(n);
  if (compactFormatter) return compactFormatter.format(n);

  // No Intl.NumberFormat compact notation (very old engines).
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 100) / 10}K`;
};
