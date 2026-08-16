/**
 * The web origins this API serves.
 *
 * One list, because two copies drift: CORS decides whether a browser may read
 * a response, and the CSRF guard on the auth routes decides whether a
 * state-changing request is even accepted. Those must agree, or one of them is
 * quietly not doing its job.
 *
 * ── Why it comes from the environment ───────────────────────────────────────
 *
 * The list was hardcoded, and one of the two entries was a specific Netlify
 * site. Where the front end is deployed is configuration, not code, so that made
 * moving the client — or running a second instance, or a preview deploy — a
 * source change to a security policy. A policy edited in order to deploy is a
 * policy nobody reviews.
 *
 *   ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
 *
 * ── Why an unset value is fatal in production ───────────────────────────────
 *
 * config/socket.js used to read `process.env.CLIENT_URL || "http://localhost:5173"`,
 * and its comment records the failure mode: the variable was unset in production
 * and the API quietly trusted localhost. That is an origin anything running on a
 * visitor's machine can occupy, and nothing about the request looks wrong.
 *
 * There is no safe guess for this value, so it is refused rather than guessed.
 * Development is the one case where a guess is safe, because the answer is
 * always the Vite dev server.
 */

/*
 * Only meaningful outside production, where the value is required. Vite's
 * default port, matching frontend/vite.config.js.
 */
const DEV_FALLBACK = ["http://localhost:5173"];

const splitList = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * An `Origin` header is `scheme://host[:port]` and never carries a path or a
 * trailing slash, so a configured "https://app.example.com/" would match nothing
 * and present as every single request being blocked by CORS — with a log line
 * naming an origin that looks identical to the one in the config. Normalising
 * through `URL` costs a line and removes that afternoon.
 *
 * Anything that isn't a URL at all is refused at boot instead, because the
 * alternative is silently dropping it and serving a shorter list than the
 * operator wrote.
 */
const toOrigin = (entry) => {
  try {
    return new URL(entry).origin;
  } catch {
    throw new Error(
      `ALLOWED_ORIGINS contains "${entry}", which is not a URL. Each entry must ` +
        "be a full origin, e.g. https://app.example.com"
    );
  }
};

const configured = splitList(process.env.ALLOWED_ORIGINS).map(toOrigin);

if (configured.length === 0 && process.env.NODE_ENV === "production") {
  throw new Error(
    "ALLOWED_ORIGINS must be set in production. It is the origin allow-list " +
      "shared by CORS and the CSRF guard on /auth; there is no safe default. " +
      "Set it to the front end's origin, comma-separated for more than one: " +
      "ALLOWED_ORIGINS=https://app.example.com"
  );
}

export const ALLOWED_ORIGINS = configured.length ? configured : DEV_FALLBACK;

export const isAllowedOrigin = (origin) => ALLOWED_ORIGINS.includes(origin);
