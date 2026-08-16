/**
 * Response headers this API was not setting at all.
 *
 * ── Why not helmet ──────────────────────────────────────────────────────────
 *
 * Helmet is the usual answer and it is a good library, but it is built for a
 * server that returns HTML. This one returns JSON to a single-page app hosted on
 * a different origin, and two of helmet's defaults are actively wrong here:
 * `Cross-Origin-Resource-Policy: same-origin` would break every cross-origin
 * fetch the app makes, and its CSP describes a document this server never sends.
 * Overriding both, to gain a curated list of six static strings, is more
 * indirection than it removes — so the list is written out, with the reason each
 * one is here.
 *
 * ── Where the real CSP lives ────────────────────────────────────────────────
 *
 * Not here. A Content-Security-Policy constrains what a *document* may load, and
 * the only documents in this system are served by the static host, not by
 * Express. The policy that matters is in `frontend/public/_headers`. The one
 * below applies to JSON error pages and to anything that manages to render one
 * of these responses directly, which is why it is `default-src 'none'` rather
 * than an allow-list — this server has nothing legitimate to load.
 */

/*
 * Two years, with subdomains, and preload-eligible.
 *
 * Sent only over HTTPS. A browser ignores HSTS on a plain HTTP response, and
 * emitting it in local development would be actively harmful: it is remembered
 * per host, so `http://localhost:5000` would become unreachable over HTTP on
 * that developer's machine for the lifetime of the max-age. `req.secure` is
 * accurate because server.js sets `trust proxy`, so it reflects
 * X-Forwarded-Proto from the one hop in front.
 */
const HSTS = "max-age=63072000; includeSubDomains; preload";

const HEADERS = {
  /*
   * The browser must not second-guess a declared Content-Type. Without it, a
   * JSON response containing attacker-influenced text can be sniffed as HTML and
   * rendered — which is how an API that never serves a document still manages to
   * host script.
   */
  "X-Content-Type-Options": "nosniff",

  /*
   * Nothing here should ever be framed. `frame-ancestors` in the CSP below is
   * the modern control and supersedes this, but X-Frame-Options is still what
   * older browsers read, and disagreeing with it costs nothing.
   */
  "X-Frame-Options": "DENY",

  /*
   * Referrer suppressed entirely rather than trimmed to an origin. Request URLs
   * here contain usernames, conversation ids and post ids, and there is no
   * outbound navigation from a JSON response that would benefit from sending
   * any of it.
   */
  "Referrer-Policy": "no-referrer",

  /*
   * `cross-origin`, deliberately, and this is the one line that must not be
   * copied from a default.
   *
   * CORP is a *reader* check applied on top of CORS: `same-origin` would make
   * the browser discard every response before the fetch that asked for it could
   * read the body, which is the entire app. The protection CORP offers —
   * against a hostile page pulling this resource into its own process — is
   * already the job of the origin allow-list in config/origins.js.
   */
  "Cross-Origin-Resource-Policy": "cross-origin",

  /*
   * The API sends no documents and loads nothing. Stating that explicitly means
   * a response rendered directly — a JSON error opened in a tab, an embedded
   * view — cannot execute script, load an image, or be framed.
   */
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",

  /** Legacy Adobe cross-domain policy files. None exist; say so. */
  "X-Permitted-Cross-Domain-Policies": "none",
};

/**
 * Applied to every response, before routing, so it covers 404s and errors too —
 * the responses most likely to be rendered somewhere unexpected.
 */
export const securityHeaders = (req, res, next) => {
  for (const [header, value] of Object.entries(HEADERS)) {
    res.setHeader(header, value);
  }

  if (req.secure) res.setHeader("Strict-Transport-Security", HSTS);

  next();
};
