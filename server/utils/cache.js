import { getRedis, isRedisReady } from "../config/redis.js";

/**
 * Cache-aside helper. If Redis is unavailable the loader fn runs directly.
 * @param {string} key   - Cache key
 * @param {number} ttl   - TTL in seconds
 * @param {Function} fn  - Async loader — called on miss
 */
export async function getOrSet(key, ttl, fn) {
  if (isRedisReady()) {
    const redis = getRedis();
    try {
      const cached = await redis.get(key);
      if (cached !== null) return JSON.parse(cached);

      const result = await fn();
      await redis.setex(key, ttl, JSON.stringify(result));
      return result;
    } catch {
      // Redis error mid-flight — fall through to DB
    }
  }
  return fn();
}

/**
 * Delete one or more cache keys. Safe to call even when Redis is down.
 * @param {...string} keys
 */
export async function del(...keys) {
  if (!isRedisReady() || keys.length === 0) return;
  try {
    await getRedis().del(...keys);
  } catch {
    // best-effort
  }
}

/**
 * Delete all keys by prefix. Uses SCAN to avoid blocking Redis.
 * Safe no-op when Redis is unavailable.
 * @param {string} prefix
 */
export async function delByPrefix(prefix) {
  if (!isRedisReady() || !prefix) return;
  try {
    const redis = getRedis();
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        200
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch {
    // best-effort
  }
}

export const CacheKeys = {
  profile: (username) => `profile:${username}`,
  userPosts: (username) => `userposts:${username}`,
};
