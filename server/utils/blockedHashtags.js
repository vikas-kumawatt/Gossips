import { getSettings } from "./settings.js";

/**
 * Hashtags the app won't index or link.
 *
 * A blocked tag doesn't stop a post being published — losing someone's whole
 * post over one word they didn't know was on a list is worse than the word, and
 * a hard rejection tells whoever is probing exactly what the list contains.
 * Instead the tag stops being a *route*: it isn't stored, isn't counted, the
 * text renders plain rather than as a link, and the tag page says it's
 * restricted. Discovery is the thing being denied, which is the thing that
 * actually matters.
 *
 * Deliberately short and mostly structural. A serious adult-content list is a
 * moderation dataset that gets maintained, not a constant in a source file, so
 * the admin-managed additions are where the real work goes — this covers the
 * unambiguous cases and the self-harm terms, where a wrong call in the other
 * direction is what costs someone something.
 */

const BLOCKED_HASHTAGS = new Set([
  // ── Sexual content ────────────────────────────────────────────────────────
  "porn",
  "porno",
  "pornhub",
  "porns",
  "pornstar",
  "xxx",
  "nsfw",
  "nude",
  "nudes",
  "nudity",
  "naked",
  "sex",
  "sexy",
  "sexting",
  "hentai",
  "onlyfans",
  "camgirl",
  "escort",
  "escorts",
  "milf",
  "boobs",
  "tits",
  "ass",
  "dick",
  "pussy",
  "cum",
  "fetish",
  "bdsm",
  "adultcontent",
  "18plus",
  "nsfwtwt",

  /*
   * ── Self-harm and eating disorders ──────────────────────────────────────
   * The "pro-" tags are communities that encourage the behaviour; blocking the
   * tag is the single most effective thing a platform can do about them, and
   * it's why every major platform blocks exactly these.
   */
  "selfharm",
  "selfharmmm",
  "cutting",
  "suicide",
  "suicidal",
  "killmyself",
  "proana",
  "promia",
  "thinspo",
  "thinspiration",
  "bonespo",
  "ana",
  "mia",

  // ── Drugs for sale ────────────────────────────────────────────────────────
  "cocaine",
  "heroin",
  "meth",
  "mdma",
  "lsd",
  "drugdealer",
  "weedforsale",
  "buyweed",
  "drugsforsale",

  // ── Hate and violence ─────────────────────────────────────────────────────
  "killyourself",
  "kys",
  "nazi",
  "heil",
  "whitepower",
  "terrorism",
  "isis",
  "beheading",
  "gore",

  // ── Fraud ─────────────────────────────────────────────────────────────────
  "freefollowers",
  "followforfollow",
  "f4f",
  "buyfollowers",
  "hackedaccount",
  "creditcardnumbers",
  "cvvshop",
  "carding",
]);

const normalize = (value) =>
  typeof value === "string" ? value.trim().replace(/^#/, "").toLowerCase() : "";

/**
 * Pure check against the built-in list.
 * @param {string} tag
 * @param {Iterable<string>} [extra] admin-configured additions
 */
export const isBlockedHashtag = (tag, extra = []) => {
  const candidate = normalize(tag);
  if (!candidate) return false;
  if (BLOCKED_HASHTAGS.has(candidate)) return true;
  for (const entry of extra) {
    if (normalize(entry) === candidate) return true;
  }
  return false;
};

/**
 * Same check, including whatever an admin has added at runtime. `getSettings`
 * is memoised, so this is cheap enough to run per tag on a write path.
 */
export const isBlockedTag = async (tag) => {
  const settings = await getSettings();
  return isBlockedHashtag(tag, settings?.blockedHashtags || []);
};

/** Filters a parsed tag list down to the ones we'll index and link. */
export const allowedHashtags = async (tags = []) => {
  if (!tags.length) return [];
  const settings = await getSettings();
  const extra = settings?.blockedHashtags || [];
  return tags.filter((tag) => !isBlockedHashtag(tag, extra));
};

/** Exported for the admin panel, which shows the built-ins as read-only. */
export const listBuiltInBlockedHashtags = () => [...BLOCKED_HASHTAGS].sort();
