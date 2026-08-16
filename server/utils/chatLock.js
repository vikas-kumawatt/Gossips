import crypto from "crypto";
import UserSettings from "../models/UserSettings.js";
import { signFor } from "./signingSecret.js";

/**
 * Chat lock, enforced by the server rather than by the client.
 *
 * The feature was finished in R6 and it still enforced nothing: the list gated
 * entry and the preview was withheld, but `GET /chats/messages/<username>`
 * returned the whole thread to anyone who typed the URL or called the API. That
 * covers the borrowed-phone case the feature was built for and nothing else, so
 * it wasn't a boundary — and a lock that isn't a boundary is the kind of toggle
 * `middleware/featureGate.js` warns about.
 *
 * A PIN can't be checked on the read path itself: the thread is fetched on every
 * open, on every page of history, and by four other endpoints, and prompting
 * each time would make the feature unusable. So verifying the PIN once mints a
 * short-lived grant that those reads can check.
 *
 * The grant is `<expiresAt>.<hmac>` over `(userId, chatId, expiresAt)`:
 *
 *   - `chatId` in the signature, so unlocking one conversation does not unlock
 *     the others. A per-account grant would make the second lock free.
 *   - `userId` in the signature, so a grant lifted from one session is useless
 *     in another account's.
 *   - `expiresAt` both signed and checked, so it can't be extended by editing
 *     the plaintext half.
 *
 * It is not a capability — it says "this user proved the PIN for this chat
 * recently", nothing about whether they may read the conversation. Every read
 * path still applies its own participation check. Same shape and the same
 * reasoning as utils/mediaToken.js.
 */

/*
 * Long enough to read a conversation and come back to it, short enough that a
 * grant left behind on a shared machine expires on its own. Changing the PIN
 * does not revoke outstanding grants; resetting it clears `lockedChats`
 * entirely, so there is nothing left for a grant to open.
 */
const GRANT_TTL_MS = 15 * 60 * 1000;

/*
 * Versioned, and part of the signed input — see utils/signingSecret.js. Bumping
 * the version invalidates outstanding grants, which costs anyone holding one a
 * re-entry of their PIN; they expire in fifteen minutes regardless.
 */
const DOMAIN = "chatlock:v1";

const sign = (userId, chatId, expiresAt) =>
  signFor(DOMAIN, `${userId}\n${chatId}\n${expiresAt}`);

export const issueUnlockGrant = (userId, chatId) => {
  const expiresAt = Date.now() + GRANT_TTL_MS;
  return {
    grant: `${expiresAt}.${sign(String(userId), chatId, expiresAt)}`,
    expiresAt,
  };
};

/** Timing-safe. False for anything absent, malformed, expired or altered. */
export const verifyUnlockGrant = (userId, chatId, grant) => {
  if (typeof grant !== "string" || !grant) return false;

  const separator = grant.indexOf(".");
  if (separator <= 0) return false;

  const expiresAt = Number(grant.slice(0, separator));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;

  const provided = Buffer.from(grant.slice(separator + 1));
  const expected = Buffer.from(sign(String(userId), chatId, expiresAt));
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
};

/**
 * Is this conversation locked for this user?
 *
 * `lockedChats` is the same list the chat list reads to withhold the preview, so
 * there is one answer to "is this locked" rather than two that can disagree.
 */
export const isChatLocked = async (userId, chatId) => {
  if (!chatId) return false;
  const row = await UserSettings.findOne({ user: userId })
    .select("chat.lockedChats")
    .lean();
  return (row?.chat?.lockedChats || []).includes(chatId);
};

/**
 * The header the grant travels in.
 *
 * A header rather than a query parameter, because query strings end up in access
 * logs and this one would then sit in them for its whole lifetime. It is already
 * in the CORS allow-list in server.js — every request from the app is
 * preflighted anyway, so it costs nothing extra.
 */
export const UNLOCK_HEADER = "x-chat-unlock";

/**
 * Whether a request may read a locked conversation.
 *
 * Fails closed: no grant, a grant for a different chat, or an expired one all
 * mean locked.
 */
export const isUnlockedForRequest = async (req, userId, chatId) => {
  if (!(await isChatLocked(userId, chatId))) return true;
  return verifyUnlockGrant(userId, chatId, req.headers[UNLOCK_HEADER]);
};
