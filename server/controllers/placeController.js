import { getOrSet } from "../utils/cache.js";
import { getRedis, isRedisReady } from "../config/redis.js";
import { ok, fail, serverError } from "../utils/respond.js";

/**
 * Place search, proxied to OpenStreetMap's Nominatim.
 *
 * Proxied rather than called from the browser for three reasons: Nominatim's
 * usage policy requires an identifying User-Agent that a browser can't set,
 * results are cacheable and doing it here means one lookup serves everyone,
 * and it keeps users' IP addresses out of a third party's logs on every
 * keystroke.
 *
 * The policy caps use at roughly one request a second, so the route is rate
 * limited and every result is cached for a day. Place names don't move.
 */

// Kept in configuration so the public service can be switched to a hosted or
// self-managed instance without shipping a client update.
const NOMINATIM = process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org";
const CACHE_TTL = 24 * 60 * 60; // a day, in seconds
const RESULT_LIMIT = 8;
const MIN_REQUEST_INTERVAL_MS = 1100;

// Nominatim asks for a contact address so they can get in touch about a
// misbehaving client instead of just blocking it.
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || "Gossips/1.0";

// Public Nominatim permits at most one request per second for an application.
// Cache hits never reach this guard; Redis makes the limit shared by app
// instances, while the local fallback protects single-process development.
let nextRequestAt = 0;

const claimRequestSlot = async () => {
  if (isRedisReady()) {
    try {
      const claimed = await getRedis().set(
        "places:nominatim:request-slot",
        "1",
        "PX",
        MIN_REQUEST_INTERVAL_MS,
        "NX"
      );
      if (claimed === "OK") return;
      throw new Error("NOMINATIM_BUSY");
    } catch (error) {
      // A deliberate busy rejection must not fall through. Redis outages can
      // still use the conservative local limiter rather than disabling place
      // search entirely.
      if (error?.message === "NOMINATIM_BUSY") throw error;
    }
  }
  const now = Date.now();
  if (now < nextRequestAt) throw new Error("NOMINATIM_BUSY");
  nextRequestAt = now + MIN_REQUEST_INTERVAL_MS;
};

const request = async (path) => {
  await claimRequestSlot();
  const response = await fetch(`${NOMINATIM}${path}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    // Don't let a slow upstream hold a connection open indefinitely.
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`);
  return response.json();
};

/**
 * Nominatim returns a long comma-separated display name. What a post needs is
 * a short label and a fuller address underneath, so the first segment becomes
 * the name and the rest becomes the address.
 */
const toPlace = (row) => {
  const display = row.display_name || "";
  const parts = display.split(",").map((s) => s.trim());
  const name = row.name || parts[0] || display;
  const address = parts.slice(1).join(", ") || null;

  return {
    placeId: row.place_id ? String(row.place_id) : null,
    name: name.slice(0, 120),
    address: address ? address.slice(0, 300) : null,
    lat: Number(row.lat),
    lng: Number(row.lon),
  };
};

export const searchPlaces = async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) return ok(res, { places: [] });
    if (q.length > 120) return fail(res, "That search is too long");

    const key = `places:search:${q.toLowerCase()}`;
    const places = await getOrSet(key, CACHE_TTL, async () => {
      const rows = await request(
        `/search?format=jsonv2&addressdetails=0&limit=${RESULT_LIMIT}&q=${encodeURIComponent(q)}`
      );
      return Array.isArray(rows) ? rows.map(toPlace) : [];
    });

    return ok(res, { places });
  } catch (error) {
    // A geocoder being down shouldn't read as a broken app — the composer
    // falls back to letting people type a name.
    console.error("searchPlaces error:", error.message);
    return fail(res, "Place search isn't available right now", 503);
  }
};

/** Turns the device's coordinates into a name for the "use my location" button. */
export const reverseGeocode = async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(res, "Invalid coordinates");
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail(res, "Invalid coordinates");

    // Rounded to ~11m before caching. Two people in the same building get the
    // same answer from cache, and we don't key the cache on an exact location.
    const rLat = lat.toFixed(4);
    const rLng = lng.toFixed(4);

    const place = await getOrSet(`places:reverse:${rLat},${rLng}`, CACHE_TTL, async () => {
      const row = await request(`/reverse?format=jsonv2&zoom=16&lat=${rLat}&lon=${rLng}`);
      return row && !row.error ? toPlace(row) : null;
    });

    if (!place) return fail(res, "Couldn't find a place there", 404);
    return ok(res, { place });
  } catch (error) {
    console.error("reverseGeocode error:", error.message);
    return fail(res, "Place lookup isn't available right now", 503);
  }
};
