import { getRedis, isRedisReady } from "../config/redis.js";
import { TIME_ZONE_COUNTRY } from "./timeZoneCountry.js";

/**
 * Where an account is being used, in the order we'd rather know it.
 *
 *   1. A CDN geo header. Free, instant, and the CDN already did the lookup
 *      against a database it keeps current.
 *   2. An IP lookup against a public service, cached in Redis by IP. This is
 *      what makes the feature work at all on a plain host with no CDN.
 *   3. The device's own IANA time zone, mapped through tzdata.
 *   4. The device's locale region — "en-IN" → IN.
 *
 * Each step is weaker evidence than the one above it, and the last two are
 * whatever the browser chose to say, so they're recorded with a lower
 * confidence and the profile can be read accordingly.
 *
 * What is *not* here, and can't be: SIM/carrier and Wi-Fi SSID are invisible to
 * web pages — no browser API exposes either, by design. GPS is available via
 * navigator.geolocation, but it raises a permission prompt, and asking someone
 * for their precise coordinates to fill in one profile row is not a trade worth
 * making. A native app could use both.
 */

// ── 1. CDN headers ───────────────────────────────────────────────────────────

const GEO_HEADERS = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "cloudfront-viewer-country", // AWS CloudFront
  "x-appengine-country", // Google App Engine
  "fastly-client-country", // Fastly
  "x-geo-country", // a custom proxy, by convention
];

/*
 * Placeholders these providers emit when they can't resolve an IP. "XX"/"ZZ"
 * mean unknown, "T1" is Tor, "A1"/"A2" are anonymous proxies and satellite
 * links, "EU"/"AP" are region buckets rather than countries. Any of them stored
 * would render as "Based in XX".
 */
const NOT_A_COUNTRY = new Set(["XX", "ZZ", "T1", "A1", "A2", "O1", "AP", "EU"]);

const asCountry = (value) => {
  if (typeof value !== "string") return "";
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return NOT_A_COUNTRY.has(code) ? "" : code;
};

export const countryFromHeaders = (req) => {
  for (const header of GEO_HEADERS) {
    const found = asCountry(req?.headers?.[header]);
    if (found) return found;
  }
  return "";
};

// ── 2. IP lookup ─────────────────────────────────────────────────────────────

/*
 * ip-api.com needs no key and allows ~45 requests a minute per server IP. The
 * cache below is what keeps us under that: one lookup per distinct address per
 * week, and a returning user costs nothing. Swappable via env for a paid tier
 * or a self-hosted resolver.
 */
const IP_LOOKUP_URL =
  process.env.IP_GEO_URL || "http://ip-api.com/json/{ip}?fields=status,countryCode";
const IP_CACHE_TTL = 7 * 24 * 60 * 60; // a week; addresses don't move countries often
/*
 * A separate, short TTL for "we couldn't find out". A timeout or a 429 says
 * nothing about the address, and caching that for a week — which is what one
 * rate-limited minute would do — leaves those users with no country for seven
 * days over a hiccup that lasted seconds.
 */
const IP_MISS_TTL = 5 * 60;
const IP_LOOKUP_TIMEOUT_MS = 3000;

/*
 * Read and write directly rather than through getOrSet, which takes a single
 * TTL and — because its loader call sits inside the try that also wraps the
 * Redis calls — retries the loader if anything throws. For a database query
 * that's a wasted round-trip; for an outbound HTTP request with a 3s timeout
 * it's a second one.
 */
const cacheRead = async (key) => {
  if (!isRedisReady()) return null;
  try {
    return await getRedis().get(key);
  } catch {
    return null;
  }
};

const cacheWrite = async (key, value, ttl) => {
  if (!isRedisReady()) return;
  try {
    await getRedis().setex(key, ttl, value);
  } catch {
    // Best effort. A cache miss next time is not a failure.
  }
};

/**
 * The client's address.
 *
 * `x-forwarded-for` is a chain the proxies appended to, so the first entry is
 * the original client — but it's also client-supplied and trivially forged.
 * That's acceptable here: the worst a forged header buys you is a wrong country
 * on your own profile. It would not be acceptable for rate limiting or bans.
 */
export const clientIp = (req) => {
  const forwarded = req?.headers?.["x-forwarded-for"];
  const raw =
    typeof forwarded === "string" && forwarded.trim()
      ? forwarded.split(",")[0].trim()
      : req?.ip || req?.socket?.remoteAddress || "";

  /*
   * Node reports an IPv4 client on a dual-stack socket as "::ffff:1.2.3.4".
   * Normalising once here rather than at each use keeps one cache entry per
   * address instead of two, and keeps the upstream query readable.
   */
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
};

/**
 * Is this address worth asking about? Private ranges, loopback and link-local
 * resolve to nothing, so looking them up burns quota to learn nothing — which
 * is every request in local development.
 */
export const isPublicIp = (ip) => {
  if (typeof ip !== "string" || !ip) return false;

  // clientIp already strips this, but the function is exported and callable
  // with a raw address.
  const address = ip.startsWith("::ffff:") ? ip.slice(7) : ip;

  if (address === "::1" || address === "127.0.0.1") return false;

  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false; // link-local
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    return true;
  }

  const lower = address.toLowerCase();
  // fc00::/7 unique-local, fe80::/10 link-local.
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8")) return false;
  return lower.includes(":");
};

/**
 * One lookup, no caching.
 *
 * @returns {Promise<{country: string, answered: boolean}>} `answered` separates
 *          "the service told us this address has no country" — which is worth
 *          remembering for a week — from "we never got an answer", which isn't.
 */
const lookupIp = async (ip) => {
  try {
    const response = await fetch(IP_LOOKUP_URL.replace("{ip}", encodeURIComponent(ip)), {
      signal: AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    // 429 is the rate limit; 5xx is their problem. Neither is a verdict.
    if (!response.ok) return { country: "", answered: false };

    const body = await response.json();
    // ip-api uses status:"fail" for private and unroutable addresses — that is
    // a real answer, just an empty one.
    if (body?.status && body.status !== "success") return { country: "", answered: true };

    return {
      country: asCountry(body?.countryCode || body?.country_code || body?.country),
      answered: true,
    };
  } catch {
    // Offline, blocked, or timed out. A profile row is never worth failing a
    // login over.
    return { country: "", answered: false };
  }
};

export const countryFromIp = async (ip) => {
  if (!isPublicIp(ip)) return "";

  const key = `geo:ip:${ip}`;
  // An empty string is a cached verdict, not a miss — hence `!== null`.
  const cached = await cacheRead(key);
  if (cached !== null) return asCountry(cached);

  const { country, answered } = await lookupIp(ip);
  await cacheWrite(key, country, answered ? IP_CACHE_TTL : IP_MISS_TTL);
  return country;
};

// ── 3 & 4. What the device says about itself ──────────────────────────────────

export const countryFromTimeZone = (timeZone) => {
  if (typeof timeZone !== "string") return "";
  return asCountry(TIME_ZONE_COUNTRY[timeZone.trim()]);
};

/**
 * "en-IN" → IN. Bare "en" gives nothing: `maximize()` would happily turn it
 * into US, which is a guess dressed as a fact.
 */
export const countryFromLocale = (locale) => {
  if (typeof locale !== "string" || !locale.trim()) return "";
  try {
    return asCountry(new Intl.Locale(locale.trim()).region);
  } catch {
    return "";
  }
};

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Best available country for this request.
 *
 * The device hints arrive as headers that one axios interceptor puts on every
 * request, rather than in each auth payload — that way signup, login, Google
 * login and token refresh all carry them without four separate call sites
 * remembering to.
 *
 * @returns {Promise<{country: string, source: string}>} country is "" when
 *          nothing resolved, in which case the profile omits the row entirely
 */
export const resolveCountry = async (req) => {
  const fromHeader = countryFromHeaders(req);
  if (fromHeader) return { country: fromHeader, source: "cdn" };

  const fromIp = await countryFromIp(clientIp(req));
  if (fromIp) return { country: fromIp, source: "ip" };

  const fromZone = countryFromTimeZone(req?.headers?.["x-client-timezone"]);
  if (fromZone) return { country: fromZone, source: "timezone" };

  const fromLocale = countryFromLocale(req?.headers?.["x-client-locale"]);
  if (fromLocale) return { country: fromLocale, source: "locale" };

  return { country: "", source: "" };
};

/**
 * Fields to `$set`, or null when nothing resolved — so callers can skip the
 * write rather than storing an empty string over a country we knew last week.
 */
export const countryUpdate = async (req) => {
  const { country, source } = await resolveCountry(req);
  if (!country) return null;
  return { country, countrySource: source, countryUpdatedAt: new Date() };
};
