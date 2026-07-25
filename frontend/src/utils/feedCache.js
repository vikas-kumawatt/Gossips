const DB_NAME = "gossips-feed-cache";
const DB_VERSION = 2;
const STORE_NAME = "feedSnapshots";

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

const cacheKey = (userId, tab) => `${String(userId)}::${String(tab)}`;

export const getFeedCacheSnapshot = async (userId, tab) => {
  if (!userId || !tab) return null;
  const db = await getDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(cacheKey(userId, tab));

    request.onsuccess = () => {
      const record = request.result;
      resolve(record?.value ?? null);
    };
    request.onerror = () => reject(request.error);
  });
};

export const setFeedCacheSnapshot = async (userId, tab, value) => {
  if (!userId || !tab || !value) return;
  const db = await getDb();
  if (!db) return;

  const record = {
    key: cacheKey(userId, tab),
    value: {
      posts: Array.isArray(value.posts) ? value.posts : [],
      cursor: value.cursor ?? null,
      hasMore: Boolean(value.hasMore),
      updatedAt: Date.now(),
    },
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const deleteFeedCacheSnapshot = async (userId, tab) => {
  if (!userId || !tab) return;
  const db = await getDb();
  if (!db) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(cacheKey(userId, tab));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};
