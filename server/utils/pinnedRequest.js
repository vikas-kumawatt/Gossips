import https from "node:https";
import http from "node:http";
import net from "node:net";

/**
 * An HTTPS request that connects to a pre-validated address.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `bots/selfHosted.js` resolves an owner-supplied endpoint, checks every
 * returned address against the private/reserved ranges, and returns the list.
 * Every caller then threw that list away and made an ordinary request to the
 * *hostname* — which resolves again, independently, and may return a different
 * answer. A DNS record with a one-second TTL can answer with a public address
 * for the check and `169.254.169.254` for the request that follows, and the
 * validation has bought nothing. That is DNS rebinding, and the file documented
 * it as a residual risk.
 *
 * The fix is to connect to the address that was checked. Node lets a request
 * override name resolution per connection, so the socket goes to a known-good
 * IP while the URL, and therefore the TLS SNI, the certificate check and the
 * Host header, still name the real hostname. Nothing about the request looks
 * different to the far end; it simply cannot be pointed somewhere else between
 * the check and the connection.
 *
 * ── Why not `fetch` ─────────────────────────────────────────────────────────
 *
 * Node's global `fetch` has no hook for this. Overriding resolution needs an
 * undici `Agent` with a custom `connect`, and undici is not a dependency of this
 * project — it is bundled inside Node but not importable. `node:https` exposes
 * `lookup` directly and is already here, so this returns the small part of the
 * `Response` interface the one caller uses rather than adding a package.
 */

/**
 * A wall-clock deadline for the whole request, not a socket idle timeout.
 *
 * `request.setTimeout` alone would not do: it re-arms on every chunk, so an
 * endpoint dribbling one byte every few seconds holds the connection for as long
 * as it likes. The AbortController this replaced was a deadline, and so is this.
 */
const DEFAULT_TIMEOUT_MS = 8000;

/*
 * A provider's model list is small. This is not a limit anyone should hit; it is
 * the ceiling that stops a hostile endpoint streaming until the process dies.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * A `lookup` that answers only with addresses that already passed validation.
 *
 * Node calls this with `all: true` in some paths and not others, and the two
 * have different callback shapes; getting that wrong fails as a connection
 * error rather than as anything legible, so both are handled.
 */
const pinnedLookup = (addresses) => (hostname, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options || {};

  const entries = addresses.map((address) => ({
    address,
    family: net.isIPv6(address) ? 6 : 4,
  }));

  const matching = opts.family
    ? entries.filter((entry) => entry.family === opts.family)
    : entries;

  if (!matching.length) {
    const error = new Error(`No validated address for ${hostname}`);
    error.code = "ENOTFOUND";
    return done(error);
  }

  return opts.all
    ? done(null, matching)
    : done(null, matching[0].address, matching[0].family);
};

/**
 * Request `url`, optionally pinned to `addresses`.
 *
 * @param {string} url
 * @param {object} options
 * @param {"GET"|"POST"} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {object} [options.body]
 *   Sent as JSON. Only the POST probe uses it; `content-type` is set here rather
 *   than left to every caller to remember.
 * @param {string[]} [options.addresses]
 *   Validated addresses for the URL's host. Omitted — as it is for the fixed
 *   provider table, whose hostnames are ours to trust — resolution is ordinary.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, status: number, text: string, json: () => any}>}
 *   The subset of `Response` that `providerKeyCheck.js` uses. `json()` is
 *   synchronous over an already-buffered body and throws on non-JSON, matching
 *   how the caller treats it. `text` is exposed as well because a body that is
 *   *not* JSON is itself a signal — see the WAF note in `providerKeyCheck.js`.
 */
export const pinnedRequest = (
  url,
  { method = "GET", headers = {}, body, addresses, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) =>
  new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error("Invalid endpoint URL"));
    }

    const transport = target.protocol === "http:" ? http : https;

    /*
     * Only when the host is a name. An endpoint written as a literal IP was
     * already checked as that literal, and handing `lookup` a value that is
     * never resolved would be dead code pretending to be a control.
     */
    const pinning =
      addresses?.length && !net.isIP(target.hostname.replace(/^\[|\]$/g, ""));

    let settled = false;
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const succeed = finish(resolve);
    const die = finish(reject);

    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");

    const request = transport.request(
      target,
      {
        method,
        headers: payload
          ? { ...headers, "content-type": "application/json", "content-length": payload.length }
          : headers,
        ...(pinning ? { lookup: pinnedLookup(addresses) } : {}),
        /*
         * A dedicated agent whenever pinning, and this is not optional.
         *
         * `https.globalAgent` keeps sockets alive and keys its pool on
         * host:port:localAddress:family — `lookup` is not part of that key. So a
         * pooled connection to the same host, opened by an earlier request that
         * did no pinning (or pinned to a different answer), is reused and the
         * override never runs. Adding a key to a bot and immediately
         * revalidating it is exactly that sequence, well inside the pool's
         * idle timeout, so the bypass is reachable rather than theoretical.
         *
         * One connection per check costs a handshake on a request that already
         * budgets eight seconds for a remote API.
         */
        ...(pinning ? { agent: new https.Agent({ keepAlive: false }) } : {}),
      },
      (response) => {
        /*
         * Redirects are not followed — `https.request` does not follow them, and
         * that is the behaviour wanted. A 3xx would send the API key to whatever
         * host the response named, which is the SSRF this whole path exists to
         * prevent arriving by the back door. The status is returned as-is and
         * the caller classifies it.
         */
        const chunks = [];
        let size = 0;

        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error("Response body too large"));
            return;
          }
          chunks.push(chunk);
        });

        /*
         * The response stream needs its own listener. A connection reset partway
         * through a body emits `error` here, not on the request — and an
         * unhandled `error` on a stream takes the process down rather than
         * rejecting this promise.
         */
        response.on("error", die);

        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          succeed({
            ok: status >= 200 && status < 300,
            status,
            text,
            json: () => JSON.parse(text),
          });
        });
      }
    );

    /*
     * `AbortError` by name because `providerKeyCheck.js` distinguishes a timeout
     * from an unreachable host by exactly that, and reports them differently.
     */
    const deadline = setTimeout(() => {
      request.destroy(Object.assign(new Error("Request timed out"), { name: "AbortError" }));
    }, timeoutMs);

    request.on("error", die);
    request.end(payload ?? undefined);
  });

/** The two shapes anyone needs, so no caller has to spell out `method`. */
export const pinnedGet = (url, options = {}) => pinnedRequest(url, { ...options, method: "GET" });

export const pinnedPost = (url, body, options = {}) =>
  pinnedRequest(url, { ...options, method: "POST", body });
