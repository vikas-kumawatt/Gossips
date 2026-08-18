import assert from "node:assert/strict";
import test from "node:test";

import { securityHeaders } from "../middleware/securityHeaders.js";
import { sanitizeMongo, scrub } from "../middleware/sanitizeMongo.js";
import { isAccessToken, JWT_VERIFY_OPTIONS } from "../config/jwt.js";

/**
 * The HTTP middleware layer, which had no tests at all.
 *
 * These three run in front of every request in the app and none of them needs a
 * database, a socket or a network — they are pure functions over `req`/`res`.
 * That makes them the part of the request path most worth covering first and the
 * cheapest to cover, which is an odd combination to have left untested.
 *
 * Deliberately no `supertest` and no live Express app: that would add a
 * dependency and a listening socket to assert things about functions that can be
 * called directly.
 */

/** The smallest `res` these middlewares actually use. */
const fakeRes = () => {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
};

// ── securityHeaders ──────────────────────────────────────────────────────────

test("securityHeaders: sets the full set on every response", () => {
  const res = fakeRes();
  let nexted = false;
  securityHeaders({ secure: false }, res, () => {
    nexted = true;
  });

  assert.ok(nexted, "middleware must call next()");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["X-Frame-Options"], "DENY");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.equal(res.headers["X-Permitted-Cross-Domain-Policies"], "none");
  assert.match(res.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(res.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
});

test("securityHeaders: CORP is cross-origin, or the SPA cannot read any response", () => {
  /*
   * The one value that must not be copied from a library default. Helmet sets
   * `same-origin`, which would make the browser discard every response before
   * the fetch that asked for it could read the body — the client is on a
   * different origin from this API by design.
   */
  const res = fakeRes();
  securityHeaders({ secure: false }, res, () => {});
  assert.equal(res.headers["Cross-Origin-Resource-Policy"], "cross-origin");
});

test("securityHeaders: HSTS only over HTTPS", () => {
  /*
   * HSTS is remembered per host. Emitting it on a plain-HTTP development server
   * would make http://localhost:5000 unreachable over HTTP on that machine for
   * the lifetime of the max-age, which is not a mistake you can take back.
   */
  const insecure = fakeRes();
  securityHeaders({ secure: false }, insecure, () => {});
  assert.equal(insecure.headers["Strict-Transport-Security"], undefined);

  const secure = fakeRes();
  securityHeaders({ secure: true }, secure, () => {});
  assert.match(secure.headers["Strict-Transport-Security"], /^max-age=\d+/);
  assert.match(secure.headers["Strict-Transport-Security"], /includeSubDomains/);
});

// ── sanitizeMongo ────────────────────────────────────────────────────────────

test("sanitizeMongo: strips operator and dotted keys from every input surface", () => {
  const req = {
    body: { username: "ada", $where: "sleep(1000)" },
    query: { "user.role": "admin", q: "hello" },
    params: { id: "1", $ne: null },
  };

  sanitizeMongo(req, {}, () => {});

  assert.deepEqual(req.body, { username: "ada" });
  assert.deepEqual(req.query, { q: "hello" });
  assert.deepEqual(req.params, { id: "1" });
});

test("sanitizeMongo: reaches operators nested inside objects and arrays", () => {
  const value = { filter: { nested: [{ $gt: 5, keep: 1 }] } };
  scrub(value);
  assert.deepEqual(value, { filter: { nested: [{ keep: 1 }] } });
});

test("sanitizeMongo: fails closed past the depth limit", () => {
  /*
   * The guard used to `return` at the depth limit, which left everything below
   * it untouched — so a payload nested one level deeper than the limit smuggled
   * its operators straight through. A sanitiser that fails open is worse than
   * none, because it is trusted.
   */
  let deep = { $ne: null };
  for (let i = 0; i < 12; i += 1) deep = { level: deep };

  scrub(deep);

  const json = JSON.stringify(deep);
  assert.ok(!json.includes("$ne"), "operator survived below the depth limit");
});

test("sanitizeMongo: leaves ordinary values alone", () => {
  const req = { body: { a: 1, b: "two", c: [1, 2], d: { e: null } }, query: {}, params: {} };
  sanitizeMongo(req, {}, () => {});
  assert.deepEqual(req.body, { a: 1, b: "two", c: [1, 2], d: { e: null } });
});

// ── jwt ──────────────────────────────────────────────────────────────────────

test("isAccessToken: an allow-list, so a new token type is refused by default", () => {
  assert.equal(isAccessToken({ typ: "access" }), true);
  assert.equal(isAccessToken({ typ: "refresh" }), false);
  assert.equal(isAccessToken({ typ: "verify" }), false);
  // A type nobody has invented yet must not authenticate a request.
  assert.equal(isAccessToken({ typ: "something_new" }), false);
});

test("isAccessToken: a token with no typ no longer authenticates", () => {
  /*
   * This case was allowed while pre-`typ` tokens were still inside their
   * validity window, and it meant a *refresh* token — which carried no `typ`
   * either — was accepted as an access token for up to its seven-day life.
   */
  assert.equal(isAccessToken({ id: "abc" }), false);
  assert.equal(isAccessToken({}), false);
  assert.equal(isAccessToken(null), false);
  assert.equal(isAccessToken(undefined), false);
});

test("JWT verification pins the algorithm", () => {
  /*
   * Without `algorithms`, `jwt.verify` trusts the algorithm named in the token's
   * own header — a field the attacker controls. That is the algorithm-confusion
   * class of bug, and the fix only works if every verify site passes these
   * options, which is why there is one shared object rather than five literals.
   */
  assert.deepEqual(JWT_VERIFY_OPTIONS.algorithms, ["HS256"]);
});
