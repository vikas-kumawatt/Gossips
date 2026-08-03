/**
 * What may go into a per-chat preference list, and how much of it.
 *
 * Every one of the ten preference writers appends to an array on a single
 * UserSettings document, keyed by a chat-list id. Most of them took whatever
 * string arrived, and none of them had a cap. Two things followed:
 *
 *   - A scripted loop grew one document past the 16MB BSON ceiling. Past that
 *     the document cannot be saved at all, so *every* settings write for that
 *     account fails permanently — there is no path back from inside the app, and
 *     it's the account's own doing, which makes it a self-service brick.
 *   - Uppercase hex is a valid ObjectId string, so `user_ABC…` was stored as a
 *     different key from the `user_abc…` the server derives from an ObjectId. The
 *     preference was written, echoed back, and matched nothing. Conversation keys
 *     lowercase for exactly this reason; these didn't.
 *
 * Pure, and in its own module, because these are the checks worth having a test
 * for and chatController can't be loaded without mongoose.
 */

/**
 * The canonical form of a chat-list id, or null if it isn't one.
 *
 * `user_<24 hex>` or `group_<24 hex>`, lowercased.
 */
export const parseChatId = (value) => {
  /*
   * A string, not anything coercible to one. `String(["user_<id>"])` is
   * `"user_<id>"` — Array.prototype.toString joins — so a one-element array
   * would have been accepted, and a body field is whatever the client sent.
   * Validating at the boundary means refusing the wrong type rather than
   * guessing what it meant.
   */
  if (typeof value !== "string") return null;
  const match = /^(user|group)_([0-9a-f]{24})$/i.exec(value);
  return match ? `${match[1].toLowerCase()}_${match[2].toLowerCase()}` : null;
};

/**
 * Ceiling on one preference list.
 *
 * This used to be defined as `MAX_CHAT_LIST`, the chat list's 500-conversation cap, on
 * the reasoning that a per-chat list longer than the list itself describes chats the user
 * cannot reach. That cap is gone — the chat list is cursored now (CF23/CF24) — so the
 * number stands on its own, and it has to: `getChats` turns the archived, favourite and
 * pinned lists into `$in`/`$nin` clauses, so this is the bound on those queries.
 */
export const MAX_PREFERENCE_ENTRIES = 500;

/** Custom chat categories. Nothing bounded these either. */
export const MAX_CATEGORIES = 50;

/**
 * Would adding `chatId` take this list past its cap?
 *
 * Checked before the write rather than left to the schema, which has no length
 * validator and would only fail at 16MB — by which point the failure is
 * permanent. An entry already in the list is an update or a removal, not growth,
 * so it is always allowed: otherwise a user at the cap could not *un*-mute
 * anything either.
 *
 * Accepts both list shapes — plain strings (favouriteChats) and `{chatId}`
 * objects (archivedChats, themeByChat, categoryAssignments, disappearingByChat).
 */
export const atPreferenceCap = (list, chatId, limit = MAX_PREFERENCE_ENTRIES) => {
  const entries = Array.isArray(list) ? list : [];
  if (entries.length < limit) return false;
  return !entries.some((entry) => sameChatId(entry, chatId));
};

/**
 * Does a list entry refer to this chat, whatever case it was stored in?
 *
 * The writers canonicalise to lowercase, but entries written before that can be
 * uppercase hex — and an exact comparison never matches one, which made it
 * *unremovable*: the removal path lowercased its input, failed to find the stored
 * spelling, and left an entry no UI could see, nothing could delete, and that
 * counted against the cap forever.
 *
 * This is used by the *write* paths — toggling, assigning, archiving, deleting a
 * chat — so a legacy entry can always be found and removed. The read paths
 * deliberately do not use it: `getChats`, `buildChatPreferencesResponse` and the
 * chat-lock check all compare exactly, so a legacy entry reads as "not set"
 * everywhere at once. That is consistent rather than half-applied — a chat with an
 * uppercase `lockedChats` entry is unlocked in the list, in the preview and at the
 * thread endpoint, so there is no state where one half thinks it's locked and the
 * other doesn't. Making the reads case-insensitive too would mean the opposite
 * trade: correct for the legacy row, and a second string comparison on the hottest
 * endpoint in the app for a row type that will drain away on its own.
 *
 * Accepts both list shapes: plain strings (favouriteChats and friends) and
 * `{chatId}` objects (archivedChats, themeByChat, categoryAssignments,
 * disappearingByChat).
 */
export const sameChatId = (entry, chatId) => {
  const value = typeof entry === "string" ? entry : entry?.chatId;
  return String(value ?? "").toLowerCase() === String(chatId ?? "").toLowerCase();
};

/** Every entry except the ones referring to `chatId`. */
export const withoutChatId = (list, chatId) =>
  (Array.isArray(list) ? list : []).filter((entry) => !sameChatId(entry, chatId));
