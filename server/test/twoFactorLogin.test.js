import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import {
  loadAuth,
  db,
  resetDb,
  makeRes,
  makeReq,
  makeUser,
  makeSession,

} from "./authHarness.mjs";
import {
  generateTotpSecret,
  generateTotpCode,
  generateBackupCodes,
} from "../utils/twoFactor.js";

/**
 * The second factor and trusted devices, against the real `loginUser`.
 *
 * Previously a `simulateTwoFactorGate` helper asserted against itself, so
 * deleting the gate from the controller failed nothing. The TOTP and
 * backup-code primitives were real even then; what was missing was any check
 * that the handler *uses* them.
 */

let auth;
let TRUSTED_DEVICE_DURATION_MS;
before(async () => {
  auth = await loadAuth();
  /*
   * Imported here, not at the top of the file. `trustedDevices.js` imports
   * `UserSession`, and a static import would run before `loadAuth()` registers
   * the mocks — binding the real model, so `trustDevice` would try to reach an
   * actual Mongo and time out. Any module that touches a model has to be pulled
   * in after the mocks, which is why the harness owns the import order.
   */
  ({ TRUSTED_DEVICE_DURATION_MS } = await import("../utils/trustedDevices.js"));
});
beforeEach(resetDb);

const twoFactorUser = (overrides = {}) => {
  const secret = generateTotpSecret();
  const { plainCodes, hashedCodes } = generateBackupCodes();
  const user = makeUser({
    twoFactorEnabled: true,
    twoFactorSecret: secret,
    twoFactorBackupCodes: hashedCodes,
    ...overrides,
  });
  db.users.push(user);
  return { user, secret, plainCodes };
};

const login = async (body, options) => {
  const res = makeRes();
  await auth.loginUser(makeReq({ email: "alex@example.com", password: "Password123", ...body }, options), res);
  return res;
};

// ── The gate ─────────────────────────────────────────────────────────────────

test("2FA: an account without it signs straight in", async () => {
  db.users.push(makeUser());
  const res = await login({});

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
});

test("2FA: no code supplied asks for one and issues no session", async () => {
  twoFactorUser();
  const res = await login({});

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.needTwoFactor, true);
  assert.equal(res.body.token, undefined, "a correct password alone must not sign anyone in");
  assert.equal(db.sessions.length, 0);
});

test("2FA: a current TOTP code signs in", async () => {
  const { secret } = twoFactorUser();
  const res = await login({ twoFactorCode: generateTotpCode(secret) });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
});

test("2FA: a wrong code is refused with no session", async () => {
  twoFactorUser();
  const res = await login({ twoFactorCode: "000000" });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid two-factor authentication code");
  assert.equal(res.body.token, undefined);
});

test("2FA: an unused backup code signs in and is consumed", async () => {
  const { user, plainCodes } = twoFactorUser();

  const first = await login({ twoFactorCode: plainCodes[0] });
  assert.equal(first.statusCode, 200);
  assert.ok(first.body.token);
  assert.equal(user.twoFactorBackupCodes[0].used, true, "single use");

  const replay = await login({ twoFactorCode: plainCodes[0] });
  assert.equal(replay.statusCode, 400, "a spent backup code must not work twice");
});

test("2FA: backup codes are accepted case-insensitively", async () => {
  const { plainCodes } = twoFactorUser();
  const res = await login({ twoFactorCode: plainCodes[0].toLowerCase() });
  assert.equal(res.statusCode, 200);
});

test("2FA: malformed codes are refused, not thrown on", async () => {
  for (const bad of ["12345", "1234567", "notacode", "  ", "12 34 56", 123456, null, {}]) {
    // A fresh account per value: these share the lockout budget, so reusing one
    // would start returning 429 after five and stop testing the code path.
    resetDb();
    twoFactorUser();

    const res = await login({ twoFactorCode: bad });
    assert.ok(
      res.statusCode === 400 || res.body?.needTwoFactor === true,
      `${JSON.stringify(bad)} must be refused, got ${res.statusCode}`,
    );
    assert.equal(res.body.token, undefined);
  }
});

test("2FA: the gate runs after the password, not instead of it", async () => {
  twoFactorUser();
  const res = await login({ password: "Wrong9999", twoFactorCode: "000000" });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid credentials", "a wrong password never reaches the code step");
});

// ── Trusted devices ──────────────────────────────────────────────────────────

const trustedFor = (userId, deviceId, ms = TRUSTED_DEVICE_DURATION_MS) =>
  makeSession(userId, deviceId, {
    isTrusted: true,
    trustedAt: new Date(),
    trustedUntil: new Date(Date.now() + ms),
  });

test("trusted device: skips the challenge", async () => {
  const { user } = twoFactorUser();
  db.sessions.push(trustedFor(user._id, "laptop-device-01"));

  const res = await login({}, { deviceId: "laptop-device-01" });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.isTrustedDevice, true);
});

test("trusted device: trust is scoped to that device", async () => {
  const { user } = twoFactorUser();
  db.sessions.push(trustedFor(user._id, "laptop-device-01"));

  const res = await login({}, { deviceId: "phone-device-02" });

  assert.equal(res.body.needTwoFactor, true, "another device must still be challenged");
});

test("trusted device: lapsed trust is challenged again", async () => {
  const { user } = twoFactorUser();
  db.sessions.push(trustedFor(user._id, "laptop-device-01", -1000));

  const res = await login({}, { deviceId: "laptop-device-01" });
  assert.equal(res.body.needTwoFactor, true);
});

test("trusted device: a revoked session is not a trusted device", async () => {
  const { user } = twoFactorUser();
  const session = trustedFor(user._id, "laptop-device-01");
  session.revokedAt = new Date();
  db.sessions.push(session);

  const res = await login({}, { deviceId: "laptop-device-01" });
  assert.equal(res.body.needTwoFactor, true, "logging a device out withdraws its trust");
});

test("trusted device: granted by passing a challenge and asking, not by asking", async () => {
  const { user, secret } = twoFactorUser();
  db.sessions.push(makeSession(user._id, "laptop-device-01"));

  // Asking without a code is still just a challenge.
  await login({ rememberDevice: true }, { deviceId: "laptop-device-01" });
  assert.equal(db.sessions[0].isTrusted, false);

  // A wrong code grants nothing.
  await login({ twoFactorCode: "000000", rememberDevice: true }, { deviceId: "laptop-device-01" });
  assert.equal(db.sessions[0].isTrusted, false);

  // A correct code plus the request does.
  const res = await login(
    { twoFactorCode: generateTotpCode(secret), rememberDevice: true },
    { deviceId: "laptop-device-01" },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(db.sessions[0].isTrusted, true);
  assert.ok(db.sessions[0].trustedUntil > new Date());
});

test("trusted device: passing a challenge without asking grants nothing", async () => {
  const { user, secret } = twoFactorUser();
  db.sessions.push(makeSession(user._id, "laptop-device-01"));

  const res = await login({ twoFactorCode: generateTotpCode(secret) }, { deviceId: "laptop-device-01" });

  assert.equal(res.statusCode, 200);
  assert.equal(db.sessions[0].isTrusted, false, "opt-in, never a default");
  assert.equal(res.body.isTrustedDevice, false);
});

test("trusted device: an account without 2FA cannot bank trust", async () => {
  /*
   * Otherwise trust collected while 2FA was off would be honoured the moment it
   * was switched on, and the first login after enabling it would skip the very
   * challenge just set up.
   */
  const user = makeUser();
  db.users.push(user);
  db.sessions.push(makeSession(user._id, "laptop-device-01"));

  const res = await login({ rememberDevice: true }, { deviceId: "laptop-device-01" });

  assert.equal(res.statusCode, 200);
  assert.equal(db.sessions[0].isTrusted, false);
  assert.equal(res.body.isTrustedDevice, false);
});
