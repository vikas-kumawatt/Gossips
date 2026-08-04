/**
 * Warm-start snapshots for the chat list and open threads.
 *
 * Both surfaces used to open on a spinner every single time, because `/chats` and
 * `/chats/messages/:username` are deliberately excluded from the axios GET cache
 * (see the comments in services/api.js) — the server sends `Cache-Control:
 * no-store` for the list, and a 60s TTL on a thread once hid the user's own
 * just-sent message. Both of those exclusions are correct and this does not undo
 * them: this is a separate layer that renders last-known state immediately and
 * then always revalidates over the network, rather than a TTL that suppresses the
 * request. Nothing here is ever served *instead of* a fetch.
 *
 * Same design as feedCache.js — separate database, key prefixed with the account
 * id, store dropped on version bump — with two additions the feed doesn't need:
 * a per-thread message cap, and eviction of least-recently-updated threads, so a
 * heavy account can't grow this without bound.
 */

const DB_NAME = "gossips-chat-cache";
/*
 * Bump this whenever the shape of a cached conversation row or message changes.
 * The store is dropped on upgrade, so a snapshot can't outlive its shape.
 */
const DB_VERSION = 1;
const STORE_NAME = "chatSnapshots";

/*
 * Enough to fill a screen and scroll a little, not enough to matter in storage.
 * The thread's own pagination takes over from the first upward scroll, so a
 * larger cap would buy nothing but bytes.
 */
const MAX_MESSAGES_PER_THREAD = 50;

/* How many threads keep a snapshot. Beyond this, least-recently-updated wins. */
const MAX_CACHED_THREADS = 20;

let dbPromise = null;

const getDb = () => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      resolve(null);
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < DB_VERSION && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
};

const listKey = (userId, filter) => `${String(userId)}::list::${String(filter || "all")}`;
const threadKey = (userId, conversationId) =>
  `${String(userId)}::thread::${String(conversationId)}`;

const readRecord = async (key) => {
  if (!key) return null;
  const db = await getDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => reject(request.error);
  });
};

const writeRecord = async (key, value) => {
  if (!key || !value) return;
  const db = await getDb();
  if (!db) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// ── Chat list ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{chats: object[], pageInfo: object, updatedAt: number}|null>}
 */
export const getCachedChatList = async (userId, filter) => {
  if (!userId) return null;
  return readRecord(listKey(userId, filter));
};

export const setCachedChatList = async (userId, filter, value) => {
  if (!userId || !value) return;
  return writeRecord(listKey(userId, filter), {
    chats: Array.isArray(value.chats) ? value.chats : [],
    /*
     * The cursor rides along with the rows. Without it a warm list would render
     * page one and then have no way to page further until a refetch landed, so
     * scrolling to the bottom of a cached list would falsely hit the end.
     */
    pageInfo: value.pageInfo ?? null,
    updatedAt: Date.now(),
  });
};

// ── Threads ────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{messages: object[], hasMore: boolean, updatedAt: number}|null>}
 */
export const getCachedThread = async (userId, conversationId) => {
  if (!userId || !conversationId) return null;
  return readRecord(threadKey(userId, conversationId));
};

/**
 * Store the tail of a thread, then evict the coldest threads over the cap.
 *
 * Only the newest MAX_MESSAGES_PER_THREAD are kept, and `hasMore` is forced true
 * when the tail was truncated — otherwise a thread whose full history had been
 * paged in would come back from cache claiming there was nothing older, and
 * upward scroll would stop working until reload.
 */
export const setCachedThread = async (userId, conversationId, value) => {
  if (!userId || !conversationId || !value) return;

  const all = Array.isArray(value.messages) ? value.messages : [];
  const messages = all.slice(-MAX_MESSAGES_PER_THREAD);
  const truncated = messages.length < all.length;

  await writeRecord(threadKey(userId, conversationId), {
    messages,
    hasMore: truncated ? true : Boolean(value.hasMore),
    /*
     * The peer's (or group's) id, so a warm start can mark the conversation active
     * before the profile request resolves. Without it the provider can't tell which
     * conversation the cached messages belong to — `currentConversation` holds a
     * bare id and the thread is keyed by username — and a live message arriving
     * during the warm window would be dropped as belonging to nothing.
     */
    peerId: value.peerId ?? null,
    updatedAt: Date.now(),
  });

  await evictColdThreads(userId);
};

/**
 * Drop least-recently-updated thread snapshots beyond MAX_CACHED_THREADS.
 *
 * A full scan on every thread write, which is fine at this cap — it is at most a
 * few dozen small records, and the alternative (a separate LRU index record) is
 * a second thing to keep consistent for no measurable gain.
 */
const evictColdThreads = async (userId) => {
  const db = await getDb();
  if (!db) return;

  const prefix = `${String(userId)}::thread::`;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const found = [];
    const cursorRequest = store.openCursor();

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        if (String(cursor.key).startsWith(prefix)) {
          found.push({ key: cursor.key, updatedAt: cursor.value?.value?.updatedAt || 0 });
        }
        cursor.continue();
        return;
      }

      // Cursor exhausted: now we know the full set and can drop the coldest.
      if (found.length > MAX_CACHED_THREADS) {
        found
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(MAX_CACHED_THREADS)
          .forEach((entry) => store.delete(entry.key));
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const deleteCachedThread = async (userId, conversationId) => {
  if (!userId || !conversationId) return;
  const db = await getDb();
  if (!db) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(threadKey(userId, conversationId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/**
 * Every cached list and thread belonging to one account.
 *
 * Signing out has to take the messages with it, for the same reason
 * deleteFeedCacheForUser exists: a signed-out account is meant to be gone from
 * this device, and a thread sitting in IndexedDB on a shared laptop is not gone.
 */
export const deleteChatCacheForUser = async (userId) => {
  if (!userId) return;
  const db = await getDb();
  if (!db) return;

  const prefix = `${String(userId)}::`;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const cursorRequest = store.openCursor();

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(prefix)) cursor.delete();
      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};
