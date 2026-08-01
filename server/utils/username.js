import User from "../models/User.js";
import { isReserved } from "./reservedUsernames.js";

/**
 * Everything that decides whether a handle may be taken, in one place.
 *
 * Both the availability check and the change itself run these rules, so the
 * green tick you see while typing and the answer you get on submit can't
 * disagree. The change endpoint re-runs them anyway — availability is advisory,
 * since someone else can register the name in the seconds between.
 *
 * The policy is Instagram's, and the reasoning is theirs too:
 *
 *   - Two changes per fortnight. Enough to fix a typo or rebrand; not enough
 *     to shed a handle every time a report lands on it.
 *   - The handle you leave is held for the same fortnight. It stops the
 *     immediate re-registration attack — watch an account, wait for it to
 *     rename, grab the old name and inherit every link and mention pointing
 *     at it — and it means a change is reversible.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
// Mirrors the `match` on User.username. Lowercase only here because callers
// normalise first.
const USERNAME_RE = /^[a-z0-9_]+$/;

export const CHANGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const CHANGES_PER_WINDOW = 2;
/** How long a released handle stays unavailable to everyone but its owner. */
export const HOLD_MS = CHANGE_WINDOW_MS;

export const normalizeUsername = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Format only — no database access, so the client can run the same rules.
 * @returns {string|null} an error message, or null when the shape is fine
 */
export const validateUsernameFormat = (username) => {
  if (!username) return "Username is required";
  if (username.length < USERNAME_MIN)
    return `Username must be at least ${USERNAME_MIN} characters`;
  if (username.length > USERNAME_MAX)
    return `Username must be ${USERNAME_MAX} characters or fewer`;
  if (!USERNAME_RE.test(username))
    return "Username can only contain letters, numbers and underscores";
  // A handle of nothing but underscores is unreadable and unmentionable.
  if (!/[a-z0-9]/.test(username))
    return "Username must contain at least one letter or number";
  return null;
};

/**
 * Can `candidate` be taken, and by this person?
 *
 * `ownerId` matters twice: you may keep your own name, and you may reclaim a
 * name you yourself released — the hold exists to protect you from others, not
 * from your own undo.
 *
 * @returns {Promise<{available: boolean, reason: string|null, message: string}>}
 */
export const checkUsernameAvailability = async (candidate, ownerId = null) => {
  const username = normalizeUsername(candidate);

  const formatError = validateUsernameFormat(username);
  if (formatError) return { available: false, reason: "invalid", message: formatError };

  if (await isReserved(username)) {
    return {
      available: false,
      reason: "reserved",
      // Deliberately vague. Spelling out that a name is *reserved* rather than
      // taken hands someone a map of which handles are worth going after.
      message: "This username isn't available",
    };
  }

  const existing = await User.findOne({ username }).select("_id").lean();
  if (existing) {
    if (ownerId && existing._id.toString() === ownerId.toString()) {
      return { available: false, reason: "current", message: "This is already your username" };
    }
    return { available: false, reason: "taken", message: "This username is taken" };
  }

  // $elemMatch, not two dotted paths: those would match an account with *some*
  // entry for this name and *some* recent entry, which is not the same thing.
  const holdQuery = {
    usernameHistory: {
      $elemMatch: { username, changedAt: { $gt: new Date(Date.now() - HOLD_MS) } },
    },
  };
  if (ownerId) holdQuery._id = { $ne: ownerId };

  const heldByOther = await User.findOne(holdQuery).select("_id").lean();
  if (heldByOther) {
    return {
      available: false,
      reason: "held",
      message: "This username isn't available yet",
    };
  }

  return { available: true, reason: null, message: "Username is available" };
};

/**
 * How much of the change allowance is left.
 *
 * Counts the entries pushed inside the window — one per change — so it needs
 * no separate counter to drift out of sync.
 *
 * @param {Array<{changedAt: Date}>} history
 */
export const changeQuota = (history = [], now = Date.now()) => {
  const cutoff = now - CHANGE_WINDOW_MS;
  const recent = history
    .filter((entry) => entry?.changedAt && new Date(entry.changedAt).getTime() > cutoff)
    .sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));

  const used = recent.length;
  const remaining = Math.max(CHANGES_PER_WINDOW - used, 0);

  // You're unblocked when the oldest change inside the window falls out of it.
  const nextAllowedAt =
    remaining > 0 || !recent.length
      ? null
      : new Date(new Date(recent[0].changedAt).getTime() + CHANGE_WINDOW_MS);

  return { used, remaining, limit: CHANGES_PER_WINDOW, nextAllowedAt };
};

/**
 * A username for a brand-new account, derived from the email local part.
 *
 * The local part is not a username: "first.last+tag@…" contains characters the
 * schema rejects, and a bare "admin@…" would land on the reserved list. Both
 * used to throw a validation error at signup. Strip, floor the length, then
 * add a numeric suffix until it's free.
 */
export const generateAvailableUsername = async (seed) => {
  const base =
    normalizeUsername(seed).replace(/[^a-z0-9_]/g, "").slice(0, USERNAME_MAX - 4) || "user";
  const padded = base.length >= USERNAME_MIN ? base : `${base}user`.slice(0, USERNAME_MAX);

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? padded : `${padded}${suffix}`;
    const { available } = await checkUsernameAvailability(candidate);
    if (available) return candidate;
  }

  // Practically unreachable, and better than looping forever.
  return `user${Date.now().toString(36)}`;
};
