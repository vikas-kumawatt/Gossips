import assert from "node:assert/strict";
import test from "node:test";
import {
  TRUSTED_DEVICE_DURATION_MS,
  deviceIsTrusted,
} from "../utils/trustedDevices.js";

/**
 * `deviceIsTrusted` is the real imported predicate — it is the whole read side
 * of the feature, and the thing that was previously vacuous.
 *
 * The write side (`trustDevice` / `untrustAllDevices`) touches Mongo, so the
 * login ordering around it is simulated below in the style the other controller
 * suites here use.
 */

const now = new Date("2026-03-01T12:00:00Z");
const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
const past = new Date(now.getTime() - 1000);

test("deviceIsTrusted: a session with no trust is not trusted", () => {
  assert.equal(deviceIsTrusted({ isTrusted: false, trustedUntil: null }, now), false);
});

test("deviceIsTrusted: the old defaults would no longer be enough on their own", () => {
  // `isTrusted` defaulted to true with no window at all, which is what made
  // every session that ever existed report as trusted.
  assert.equal(deviceIsTrusted({ isTrusted: true }, now), false);
  assert.equal(deviceIsTrusted({ isTrusted: true, trustedUntil: null }, now), false);
});

test("deviceIsTrusted: trust inside its window counts, outside it does not", () => {
  assert.equal(deviceIsTrusted({ isTrusted: true, trustedUntil: future }, now), true);
  assert.equal(deviceIsTrusted({ isTrusted: true, trustedUntil: past }, now), false);
});

test("deviceIsTrusted: a window without the flag is not trust", () => {
  assert.equal(deviceIsTrusted({ isTrusted: false, trustedUntil: future }, now), false);
});

test("deviceIsTrusted: a missing session is not trusted", () => {
  assert.equal(deviceIsTrusted(null, now), false);
  assert.equal(deviceIsTrusted(undefined, now), false);
});

test("deviceIsTrusted: accepts a date-shaped string, as a lean() read returns", () => {
  assert.equal(
    deviceIsTrusted({ isTrusted: true, trustedUntil: future.toISOString() }, now),
    true,
  );
});

test("trust window is long enough to be useful and short enough to lapse", () => {
  const days = TRUSTED_DEVICE_DURATION_MS / (24 * 60 * 60 * 1000);
  assert.equal(days, 30);
  // Must outlive the 7-day refresh token, or the session ends first and the
  // trust never gets used.
  assert.ok(days > 7);
});

/**
 * Mirrors the login gate: which requests are challenged, and which grant trust.
 */
const simulateLogin = ({ user, session, twoFactorCode, rememberDevice = false }, at = now) => {
  const trusted = deviceIsTrusted(session, at);

  if (!trusted && user.twoFactorEnabled) {
    if (!twoFactorCode) return { outcome: "needTwoFactor", granted: false };
    if (twoFactorCode !== "correct") return { outcome: "rejected", granted: false };
  }

  const granted = Boolean(user.twoFactorEnabled && !trusted && rememberDevice);
  return { outcome: "signedIn", granted, skippedChallenge: trusted };
};

const with2FA = { twoFactorEnabled: true };
const without2FA = { twoFactorEnabled: false };
const trustedSession = { isTrusted: true, trustedUntil: future };

test("login: an untrusted device with 2FA on is challenged", () => {
  const result = simulateLogin({ user: with2FA, session: null });
  assert.equal(result.outcome, "needTwoFactor");
});

test("login: a trusted device skips the challenge", () => {
  const result = simulateLogin({ user: with2FA, session: trustedSession });
  assert.equal(result.outcome, "signedIn");
  assert.equal(result.skippedChallenge, true);
});

test("login: trust that has lapsed does not skip the challenge", () => {
  const stale = { isTrusted: true, trustedUntil: past };
  assert.equal(simulateLogin({ user: with2FA, session: stale }).outcome, "needTwoFactor");
});

test("login: trust is granted only by passing a challenge in this request", () => {
  // Asking to be remembered without a code gets challenged, not trusted.
  assert.equal(
    simulateLogin({ user: with2FA, session: null, rememberDevice: true }).granted,
    false,
  );
  // A wrong code grants nothing either.
  assert.equal(
    simulateLogin({
      user: with2FA,
      session: null,
      twoFactorCode: "wrong",
      rememberDevice: true,
    }).granted,
    false,
  );
  // A correct code plus the box ticked does.
  assert.equal(
    simulateLogin({
      user: with2FA,
      session: null,
      twoFactorCode: "correct",
      rememberDevice: true,
    }).granted,
    true,
  );
});

test("login: passing a challenge without ticking the box grants nothing", () => {
  const result = simulateLogin({
    user: with2FA,
    session: null,
    twoFactorCode: "correct",
    rememberDevice: false,
  });
  assert.equal(result.outcome, "signedIn");
  assert.equal(result.granted, false);
});

test("login: an account without 2FA can never accumulate trusted devices", () => {
  /*
   * Otherwise trust banked while 2FA was off would be honoured the moment it
   * was turned on, and the first login after enabling it would skip the very
   * challenge that was just set up.
   */
  const result = simulateLogin({
    user: without2FA,
    session: null,
    rememberDevice: true,
  });
  assert.equal(result.outcome, "signedIn");
  assert.equal(result.granted, false);
});

test("login: an already-trusted device is not re-granted, so the window does not creep", () => {
  const result = simulateLogin({
    user: with2FA,
    session: trustedSession,
    rememberDevice: true,
  });
  assert.equal(result.granted, false, "no challenge happened, so nothing to reward");
});
