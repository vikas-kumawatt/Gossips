import { getSettings } from "./settings.js";

/**
 * Usernames nobody may hold.
 *
 * Three different problems share one list:
 *
 *  1. Route collisions. `/:username` is the SPA's catch-all, so an account
 *     called "settings" would shadow the settings page. Every single-segment
 *     path the app owns has to be unavailable as a handle. This half is a
 *     correctness requirement, not a policy choice.
 *  2. Impersonation. A "gossips_support" account messaging you about your
 *     login is the oldest trick there is, so the platform's own names and the
 *     vocabulary a support account would use are held back.
 *  3. Namespace we may want later — "premium", "shop", "status".
 *
 * Exact matches, with a handful of patterns. A prefix rule like "anything
 * beginning with gossips" reads as safer but also takes out "gossipsfan" and
 * "gossipsgirl", who are just users; the genuinely dangerous shapes are narrow
 * enough to spell out.
 */

const RESERVED_USERNAMES = new Set([
  // ── 1. Routes the SPA owns ────────────────────────────────────────────────
  // Mirrors RESERVED_PATHS in frontend/src/lib/profileLink.js. If a route is
  // added there, add it here too or the handle can shadow the page.
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
  /*
   * Hyphenated, so `validateUsernameFormat` already rejects it — usernames are
   * `[a-z0-9_]{3,30}`. Listed anyway, for the same reason `ai-labels` and
   * `reset-password` are: this file is the record of which single-segment paths
   * the app owns, and a reader shouldn't have to re-derive that a hyphen makes
   * one safe.
   */
  "ai-bots",
  "tag",
  "tags",
  "hashtag",
  "hashtags",

  // ── 2. Platform identity and support-desk impersonation ───────────────────
  "gossip",
  "gossips",
  "gossipsapp",
  "gossipshq",
  "team",
  "teamgossips",
  "official",
  "verify",
  "verified",
  "verification",
  "staff",
  "moderator",
  "moderators",
  "mod",
  "mods",
  "administrator",
  "admins",
  "root",
  "sysadmin",
  "superuser",
  "system",
  "security",
  "safety",
  "trust",
  "abuse",
  "spam",
  "legal",
  "dmca",
  "copyright",
  "press",
  "media",
  "careers",
  "jobs",
  "billing",
  "payments",
  "payment",
  "refund",
  "refunds",
  "recovery",
  "helpdesk",
  "support",
  "help",
  "contact",
  "info",
  "noreply",
  "no-reply",
  "postmaster",
  "webmaster",
  "hostmaster",

  // ── 3. Infrastructure hostnames and API surface ───────────────────────────
  "api",
  "www",
  "mail",
  "smtp",
  "imap",
  "ftp",
  "cdn",
  "static",
  "assets",
  "files",
  "img",
  "images",
  "video",
  "audio",
  "upload",
  "uploads",
  "download",
  "downloads",
  "status",
  "health",
  "metrics",
  "docs",
  "developer",
  "developers",
  "dev",
  "staging",
  "sandbox",
  "test",
  "testing",
  "demo",
  "oauth",
  "auth",
  "sso",
  "callback",
  "webhook",
  "webhooks",
  "graphql",
  "socket",
  "websocket",

  // ── 4. Words that read as the product speaking, or as nobody at all ───────
  "everyone",
  "here",
  "all",
  "null",
  "undefined",
  "none",
  "nobody",
  "anonymous",
  "deleted",
  "unknown",
  "guest",
  "user",
  "users",
  "username",
  "account",
  "accounts",
  "profile",
  "profiles",
  "me",
  "you",
  "home",
  "feed",
  "explore",
  "discover",
  "trending",
  "notifications",
  "messages",
  "inbox",
  "post",
  "posts",
  "reply",
  "replies",
  "report",
  "reports",
  "premium",
  "subscribe",
  "subscription",
  "upgrade",
  "shop",
  "store",
  "app",
  "apps",
  "about",
  "faq",
  "policy",
  "policies",
  "tos",
  "guidelines",
  "rules",
  "community",
]);

/**
 * The impersonation shapes worth catching generatively. Each has to be
 * specific enough that a real person wouldn't plausibly want it.
 */
const RESERVED_PATTERNS = [
  // gossips_support, gossipssupport, gossips-help, gossipsteam …
  /^gossips?[-_]?(support|help|team|official|staff|admin|security|service|care)$/,
  // support_gossips, official-gossips …
  /^(support|help|team|official|staff|admin|security)[-_]?gossips?$/,
  // Any spelling of "official" glued to a role.
  /^official[-_]?(support|help|team|account|page)$/,
];

/** Cheap normalisation so callers can pass raw input. */
const normalize = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Pure check against the built-in list.
 *
 * @param {string} username
 * @param {Iterable<string>} [extra] admin-configured additions
 */
export const isReservedUsername = (username, extra = []) => {
  const candidate = normalize(username);
  if (!candidate) return false;
  if (RESERVED_USERNAMES.has(candidate)) return true;
  for (const entry of extra) {
    if (normalize(entry) === candidate) return true;
  }
  return RESERVED_PATTERNS.some((pattern) => pattern.test(candidate));
};

/**
 * Same check, including whatever an admin has added at runtime.
 *
 * `getSettings` is memoised for 30s and falls back to defaults if Mongo is
 * unreachable, so this stays cheap enough for a keystroke-driven availability
 * check.
 */
export const isReserved = async (username) => {
  const settings = await getSettings();
  return isReservedUsername(username, settings?.reservedUsernames || []);
};

/** Exported for the admin panel, which shows the built-ins as read-only. */
export const listBuiltInReservedUsernames = () => [...RESERVED_USERNAMES].sort();
