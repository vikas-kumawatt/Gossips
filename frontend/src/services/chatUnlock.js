/**
 * The client half of the chat lock.
 *
 * The server now refuses to return a locked conversation's messages, search
 * results, media or pinned list without a grant proving the PIN was entered —
 * see server/utils/chatLock.js. This holds the grants the current tab has and
 * hands them to the request layer.
 *
 * sessionStorage, not localStorage: a grant should not survive the browser being
 * closed, which is close to the only threat a chat lock exists to address. It is
 * scoped per tab for the same reason, and the server-side expiry is the real
 * boundary — this is a cache of something the server already time-limits.
 */

const KEY = "chatUnlockGrants";

const read = () => {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const write = (grants) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(grants));
  } catch {
    // A full or unavailable sessionStorage costs the user a re-prompt on the
    // next open, which is the correct failure for a lock.
  }
};

/*
 * Keys are lowercased, because the server signs the grant over a lowercased
 * chatId — uppercase hex is a valid ObjectId string, and the two spellings would
 * otherwise be different keys for the same conversation. The same reason
 * conversation keys lowercase server-side.
 */
const normalise = (chatId) => (chatId ? String(chatId).toLowerCase() : "");

export const saveUnlockGrant = (chatId, grant, expiresAt) => {
  const key = normalise(chatId);
  if (!key || !grant) return;
  write({ ...read(), [key]: { grant, expiresAt } });
};

/** The live grant for this chat, or null. Expired entries are dropped. */
export const getUnlockGrant = (chatId) => {
  const key = normalise(chatId);
  if (!key) return null;
  const grants = read();
  const entry = grants[key];
  if (!entry) return null;
  // A minute of slack, so a request that leaves here just inside the window
  // isn't rejected on arrival.
  if (!entry.expiresAt || entry.expiresAt - 60_000 <= Date.now()) {
    delete grants[key];
    write(grants);
    return null;
  }
  return entry.grant;
};

export const clearUnlockGrant = (chatId) => {
  const key = normalise(chatId);
  const grants = read();
  if (!(key in grants)) return;
  delete grants[key];
  write(grants);
};

/** Forget everything on sign-out or account switch. */
export const clearAllUnlockGrants = () => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
};

/**
 * The chatId a 423 refers to, or null for any other error.
 *
 * The server answers 423 with the chatId it wants a grant for, which is what
 * makes deep-linking work: the client doesn't have to know a conversation is
 * locked before asking for it, and it doesn't have to know the peer's id — the
 * refusal carries both facts.
 */
export const lockedChatIdFromError = (error) => {
  const data = error?.response?.status === 423 ? error.response.data : null;
  return typeof data?.chatId === "string" ? data.chatId : null;
};

/**
 * The header a request carries to prove a chat is unlocked, or `{}`.
 *
 * Spread into an axios config rather than set by an interceptor, because only
 * the five conversation-scoped reads know which chat they are asking about.
 */
export const unlockHeaders = (chatId) => {
  const grant = getUnlockGrant(chatId);
  return grant ? { "X-Chat-Unlock": grant } : {};
};
