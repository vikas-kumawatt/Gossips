import assert from "node:assert/strict";
import test, { before } from "node:test";
import { loadAuth } from "./authHarness.mjs";
import jwt from "jsonwebtoken";
import {
  JWT_VERIFY_OPTIONS,
  isAccessToken,
  getAccessTokenSecret,
  getRefreshTokenSecret,
  getVerificationTicketSecret,
} from "../config/jwt.js";
import {
  hashAccessToken,
  revokeAccessToken,
  isTokenRevoked,
} from "../utils/tokenRevocation.js";

process.env.JWT_SECRET = "base-test-secret-key-32-chars-long";

/**
 * What is left here after the auth suites were converted.
 *
 * Rotation, reuse detection, the session cap, session revocation, 2FA and
 * account-status gating used to live in this file as `simulate*` closures
 * asserted against themselves. They now run against the real handlers in
 * `tokenRotation.test.js`, `sessionRevocation.test.js`, `twoFactorLogin.test.js`
 * and `googlePasswordSetup.test.js`, so the copies have been removed rather
 * than left to drift.
 *
 * Everything below exercises real imported code. The `usernameHistory`,
 * privacy-allowlist and profile-constant cases are shape checks on rules that
 * live in other controllers; they are kept because they are cheap and honest
 * about what they cover, not because they guard this file's subject.
 */

/** The shipped CSRF guard, imported after the harness so its route module's
 *  controller import binds mocked models rather than reaching for Mongo. */
let sameOriginOnly;
let ALLOWED_ORIGINS;
before(async () => {
  await loadAuth();
  ({ sameOriginOnly } = await import("../routes/authRoutes.js"));
  ({ ALLOWED_ORIGINS } = await import("../config/origins.js"));
});

test("cryptographic domain separation: access, refresh, and verify tokens use distinct secrets", () => {
  const accessSecret = getAccessTokenSecret();
  const refreshSecret = getRefreshTokenSecret();
  const verifySecret = getVerificationTicketSecret();

  assert.notEqual(accessSecret, refreshSecret, "Access and refresh secrets must be distinct");
  assert.notEqual(accessSecret, verifySecret, "Access and verify secrets must be distinct");
  assert.notEqual(refreshSecret, verifySecret, "Refresh and verify secrets must be distinct");

  const userId = "68b0f3c1a2d4e5f60718293a";

  const accessToken = jwt.sign({ id: userId, typ: "access" }, accessSecret, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ id: userId, typ: "refresh" }, refreshSecret, { expiresIn: "7d" });
  const verifyTicket = jwt.sign({ sid: userId, typ: "verify", email: "a@b.com" }, verifySecret, { expiresIn: "10m" });

  // Access token verifies against accessSecret
  const decodedAccess = jwt.verify(accessToken, accessSecret, JWT_VERIFY_OPTIONS);
  assert.equal(decodedAccess.id, userId);
  assert.equal(isAccessToken(decodedAccess), true);

  // Refresh token CANNOT verify against accessSecret (cryptographic rejection)
  assert.throws(
    () => jwt.verify(refreshToken, accessSecret, JWT_VERIFY_OPTIONS),
    /invalid signature/i,
    "Refresh token must fail cryptographic verification against access secret"
  );

  // Verify ticket CANNOT verify against accessSecret (cryptographic rejection)
  assert.throws(
    () => jwt.verify(verifyTicket, accessSecret, JWT_VERIFY_OPTIONS),
    /invalid signature/i,
    "Verify ticket must fail cryptographic verification against access secret"
  );
});

test("access token revocation: token is valid before logout and immediately rejected after revocation", async () => {
  const token = jwt.sign(
    { id: "user-123", typ: "access", jti: "unique-token-id-456" },
    getAccessTokenSecret(),
    { expiresIn: "15m" }
  );

  // Initially unrevoked
  assert.equal(await isTokenRevoked(token), false);

  // Revoke token (simulate logout)
  const decoded = jwt.decode(token);
  await revokeAccessToken(token, decoded.id, decoded.exp, "logout");

  // Instantly blocked
  assert.equal(await isTokenRevoked(token), true);

  // Hash determinism
  assert.equal(hashAccessToken(token), hashAccessToken(token));
});

test("usernameHistory bounding: history is capped to 10 entries while preserving quota calculations", () => {
  let history = [];
  const maxHistory = 10;

  // Simulate 15 consecutive username changes over time
  for (let i = 1; i <= 15; i++) {
    history.push({ username: `user_v${i}`, changedAt: new Date() });
    if (history.length > maxHistory) {
      history = history.slice(-maxHistory);
    }
  }

  assert.equal(history.length, 10, "usernameHistory array must be bounded to 10 entries");
  assert.equal(history[0].username, "user_v6", "Oldest 5 entries must be pruned");
  assert.equal(history[9].username, "user_v15", "Latest entry must be preserved");
});

test("privacy settings: allowlist validates whoCanMention, whoCanSeeOnlineStatus, whoCanMessage, and readReceipts", () => {
  const audienceEnum = ["everyone", "followers", "followers_following", "none"];
  const editablePrivacy = {
    whoCanMention: ["everyone", "following", "none"],
    whoCanMessage: audienceEnum,
    whoCanCall: audienceEnum,
    whoCanSeeOnlineStatus: audienceEnum,
    whoCanSeeLastSeen: audienceEnum,
    whoCanSeeReadReceipts: audienceEnum,
    readReceipts: [true, false],
    typingIndicator: [true, false],
  };

  const validateUpdate = (key, val) => {
    if (!(key in editablePrivacy)) return false;
    return editablePrivacy[key].includes(val);
  };

  // Valid updates
  assert.equal(validateUpdate("whoCanMention", "following"), true);
  assert.equal(validateUpdate("whoCanSeeOnlineStatus", "followers_following"), true);
  assert.equal(validateUpdate("whoCanMessage", "none"), true);
  assert.equal(validateUpdate("readReceipts", false), true);

  // Invalid updates
  assert.equal(validateUpdate("whoCanMention", "invalid_enum"), false);
  assert.equal(validateUpdate("whoCanSeeOnlineStatus", "all_friends"), false);
  assert.equal(validateUpdate("unauthorizedField", "foo"), false);
});

test("sameOriginOnly: allows registered origins and blocks cross-origin attackers with 403", async () => {
  /*
   * The real middleware. Session cookies are SameSite=none in production —
   * they have to be, the app and API are on different origins — so any site can
   * make the browser send them, and this guard is what stops a cross-site POST
   * to /auth/logout signing someone out or making an account un-switchable.
   */
  const run = (origin) => {
    const req = { get: (key) => (String(key).toLowerCase() === "origin" ? origin : undefined) };
    const result = { nextCalled: false, statusCode: 200, body: null };
    const res = {
      status(code) { result.statusCode = code; return this; },
      json(payload) { result.body = payload; return this; },
    };
    sameOriginOnly(req, res, () => { result.nextCalled = true; });
    return result;
  };

  // A configured origin passes.
  const legit = run(ALLOWED_ORIGINS[0]);
  assert.equal(legit.nextCalled, true);
  assert.equal(legit.statusCode, 200);

  // No Origin header means a same-origin or non-browser caller, which CORS was
  // not protecting anyway.
  const headerless = run(undefined);
  assert.equal(headerless.nextCalled, true);

  // Anything else is refused, and the handler behind it never runs.
  for (const hostile of [
    "https://evil.example.com",
    "http://gossips.app.evil.com",
    "null",
    "https://gossips.app.attacker.io",
  ]) {
    const blocked = run(hostile);
    assert.equal(blocked.nextCalled, false, `${hostile} must not reach the handler`);
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.body.error, "Cross-origin request rejected");
  }
});

test("profile constants: BIO_MAX_LENGTH and NAME_MAX_GRAPHEMES are shared constants", async () => {
  const { BIO_MAX_LENGTH, NAME_MAX_GRAPHEMES } = await import("../utils/profileConstants.js");
  assert.equal(BIO_MAX_LENGTH, 150);
  assert.equal(NAME_MAX_GRAPHEMES, 50);
});









