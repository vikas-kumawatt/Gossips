/**
 * Turning "IN" into "India".
 *
 * `Intl.DisplayNames` ships with the browser and knows every ISO 3166-1 code
 * in the user's own language, so bundling a country-name table would be adding
 * ~4KB to reimplement something already there — and it would only ever be in
 * English.
 *
 * The instance is created once: constructing it parses locale data, which is
 * not something to do on every render.
 */

let displayNames;
try {
  displayNames = new Intl.DisplayNames(undefined, { type: "region" });
} catch {
  // Very old browsers, or a locale the engine has no data for.
  displayNames = null;
}

/**
 * @param {string} code ISO 3166-1 alpha-2, e.g. "IN"
 * @returns {string} the country's name, or "" when the code is missing or junk
 */
export const countryName = (code) => {
  if (typeof code !== "string") return "";
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return "";

  try {
    const name = displayNames?.of(upper);
    // `of` echoes the input back when it doesn't recognise the region.
    return name && name !== upper ? name : upper;
  } catch {
    return upper;
  }
};
