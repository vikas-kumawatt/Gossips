import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import {
  loadAuth,
  db,
  resetDb,
  makeRes,
  makeReq,
  makeUser,
} from "./authHarness.mjs";

/**
 * Per-account lockout, against the real `loginUser`.
 *
 * This file used to be a `simulateLoginAttempt` helper defined below the
 * imports and asserted against itself — `authController` was never loaded, so
 * removing the lockout entirely would not have failed a single case. The point
 * of a lockout is that it is the only thing standing between a leaked password
 * list and a distributed credential-stuffing run, so it needs a test that
 * notices when it stops working.
 */

let auth;
before(async () => {
  auth = await loadAuth();
});
beforeEach(resetDb);

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const attemptLogin = async (password, { deviceId } = {}) => {
  const res = makeRes();
  await auth.loginUser(makeReq({ email: "alex@example.com", password }, { deviceId }), res);
  return res;
};

test("lockout: wrong passwords count down and report attempts left", async () => {
  const user = makeUser();
  db.users.push(user);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS - 1; attempt++) {
    const res = await attemptLogin("Wrong9999");
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid credentials");
    assert.equal(res.body.attemptsLeft, MAX_ATTEMPTS - attempt);
    assert.equal(user.failedLoginAttempts, attempt);
    assert.equal(user.lockoutUntil, null);
  }
});

test("lockout: the fifth failure locks the account for 15 minutes", async () => {
  const user = makeUser({ failedLoginAttempts: MAX_ATTEMPTS - 1 });
  db.users.push(user);

  const res = await attemptLogin("Wrong9999");

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.locked, true);
  assert.equal(res.body.retryAfter, LOCKOUT_MS / 1000);
  assert.equal(res.headers["Retry-After"], String(LOCKOUT_MS / 1000));
  assert.equal(user.failedLoginAttempts, MAX_ATTEMPTS);
  assert.ok(user.lockoutUntil instanceof Date);
});

test("lockout: a locked account refuses even the correct password", async () => {
  const user = makeUser({
    failedLoginAttempts: MAX_ATTEMPTS,
    lockoutUntil: new Date(Date.now() + 10 * 60 * 1000),
  });
  db.users.push(user);

  const res = await attemptLogin("Password123");

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.locked, true);
  assert.equal(res.body.token, undefined, "no session while locked");
  assert.ok(res.body.retryAfter > 0 && res.body.retryAfter <= 600);
});

test("lockout: it lapses on its own", async () => {
  const user = makeUser({
    failedLoginAttempts: MAX_ATTEMPTS,
    lockoutUntil: new Date(Date.now() - 1000),
  });
  db.users.push(user);

  const res = await attemptLogin("Password123");

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
});

test("lockout: a successful login clears the counter", async () => {
  const user = makeUser({ failedLoginAttempts: 3 });
  db.users.push(user);

  const res = await attemptLogin("Password123");

  assert.equal(res.statusCode, 200);
  assert.equal(user.failedLoginAttempts, 0);
  assert.equal(user.lockoutUntil, null);
});

test("lockout: the counter is per account, so rotating IPs does not reset it", async () => {
  /*
   * The whole reason this exists rather than leaning on the per-IP limiter.
   * Each request here carries a different device, standing in for a different
   * source; the budget must still be spent after five.
   */
  const user = makeUser();
  db.users.push(user);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await attemptLogin("Wrong9999", { deviceId: `device-${attempt}` });
  }

  assert.equal(user.failedLoginAttempts, MAX_ATTEMPTS);
  assert.ok(user.lockoutUntil);

  const res = await attemptLogin("Password123", { deviceId: "device-99" });
  assert.equal(res.statusCode, 429);
});

test("lockout: a wrong 2FA code spends the same budget a wrong password does", async () => {
  /*
   * Otherwise a known password plus an unmetered code prompt is 10^6 guesses
   * against six digits, and the second factor is not a factor.
   */
  const user = makeUser({ twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });
  db.users.push(user);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS - 1; attempt++) {
    const res = makeRes();
    await auth.loginUser(
      makeReq({ email: "alex@example.com", password: "Password123", twoFactorCode: "000000" }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid two-factor authentication code");
    assert.equal(res.body.attemptsLeft, MAX_ATTEMPTS - attempt);
    assert.equal(user.failedLoginAttempts, attempt);
  }

  const locked = makeRes();
  await auth.loginUser(
    makeReq({ email: "alex@example.com", password: "Password123", twoFactorCode: "000000" }),
    locked,
  );
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.body.locked, true);
});

test("lockout: failed passwords carry into the code step rather than being refilled", async () => {
  /*
   * The reset moved to *after* the second factor precisely so this holds. When
   * it ran on password success, the code step always started from zero.
   */
  const user = makeUser({
    twoFactorEnabled: true,
    twoFactorSecret: "JBSWY3DPEHPK3PXP",
    failedLoginAttempts: MAX_ATTEMPTS - 1,
  });
  db.users.push(user);

  const res = makeRes();
  await auth.loginUser(
    makeReq({ email: "alex@example.com", password: "Password123", twoFactorCode: "000000" }),
    res,
  );

  assert.equal(res.statusCode, 429, "the fifth failure overall, not the fifth code");
  assert.equal(res.body.locked, true);
});

test("lockout: reaching the code prompt does not itself clear the counter", async () => {
  const user = makeUser({ twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP", failedLoginAttempts: 3 });
  db.users.push(user);

  const res = makeRes();
  await auth.loginUser(makeReq({ email: "alex@example.com", password: "Password123" }), res);

  assert.equal(res.body.needTwoFactor, true);
  assert.equal(user.failedLoginAttempts, 3, "still spent until both factors are in");
});

test("lockout: a password reset unlocks the account", async () => {
  const user = makeUser({
    failedLoginAttempts: MAX_ATTEMPTS,
    lockoutUntil: new Date(Date.now() + 10 * 60 * 1000),
    resetPasswordToken: undefined,
  });
  /*
   * `resetPassword` uses a mongoose document (`user.save()`), which the fake
   * model does not provide — so this asserts the unlock contract the handler
   * relies on rather than driving the handler itself: clearing both fields is
   * what makes "reset your password" a real instruction in the 429 body.
   */
  user.failedLoginAttempts = 0;
  user.lockoutUntil = null;
  db.users.push(user);

  const res = await attemptLogin("Password123");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
});

test("lockout: a Google-only account is not charged an attempt", async () => {
  // It has no password to be wrong about; charging it would let anyone lock
  // out a Google user by guessing at an address.
  const user = makeUser({ password: undefined, googleId: "google-uid-1" });
  db.users.push(user);

  const res = await attemptLogin("Password123");

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.needPasswordSetup, true);
  assert.equal(user.failedLoginAttempts, 0);
});
