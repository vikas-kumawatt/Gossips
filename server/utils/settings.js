import AppSettings, { SETTINGS_KEY } from "../models/AppSettings.js";

/**
 * Feature flags are read on hot paths (every post, every signup), so the
 * singleton is cached in memory and refreshed on write or after the TTL. A
 * stale flag for a few seconds is fine; a database round-trip per request
 * is not.
 */
const CACHE_TTL_MS = 30 * 1000;

let cached = null;
let cachedAt = 0;

export const invalidateSettingsCache = () => {
  cached = null;
  cachedAt = 0;
};

/**
 * Always resolves to a settings document, creating the singleton on first use.
 * If the database is unreachable, falls back to schema defaults rather than
 * throwing — a flag lookup must never be what takes the app down.
 */
export const getSettings = async () => {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  try {
    const doc = await AppSettings.findOneAndUpdate(
      { key: SETTINGS_KEY },
      { $setOnInsert: { key: SETTINGS_KEY } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    cached = doc;
    cachedAt = Date.now();
    return doc;
  } catch (error) {
    console.error("getSettings error:", error);
    return cached || new AppSettings({ key: SETTINGS_KEY }).toObject();
  }
};
