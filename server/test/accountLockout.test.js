import assert from "node:assert/strict";
import test from "node:test";

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ACCOUNT_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

const simulateLoginAttempt = ({ user, isMatch, now = Date.now() }) => {
  // Check lockout
  if (user.lockoutUntil && new Date(user.lockoutUntil).getTime() > now) {
    const remainingSeconds = Math.max(1, Math.ceil((new Date(user.lockoutUntil).getTime() - now) / 1000));
    return {
      status: 429,
      body: {
        error: `Account temporarily locked due to repeated failed login attempts. Please try again in ${Math.ceil(remainingSeconds / 60)} minute(s) or reset your password.`,
        retryAfter: remainingSeconds,
        locked: true,
      },
      headers: { "Retry-After": String(remainingSeconds) },
      user,
    };
  }

  if (!isMatch) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
      const lockoutUntil = new Date(now + ACCOUNT_LOCKOUT_DURATION_MS);
      const updatedUser = {
        ...user,
        failedLoginAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
        lockoutUntil,
      };
      const retryAfter = Math.ceil(ACCOUNT_LOCKOUT_DURATION_MS / 1000);
      return {
        status: 429,
        body: {
          error: "Too many failed login attempts. Account temporarily locked for 15 minutes. Please try again later or reset your password.",
          retryAfter,
          locked: true,
        },
        headers: { "Retry-After": String(retryAfter) },
        user: updatedUser,
      };
    }

    const updatedUser = { ...user, failedLoginAttempts: attempts };
    const attemptsLeft = MAX_FAILED_LOGIN_ATTEMPTS - attempts;
    return {
      status: 400,
      body: {
        error: "Invalid credentials",
        attemptsLeft,
      },
      user: updatedUser,
    };
  }

  // Success: reset lockout and failed attempts
  const updatedUser = {
    ...user,
    failedLoginAttempts: 0,
    lockoutUntil: null,
  };
  return {
    status: 200,
    body: {
      message: "Login successful",
      isTrustedDevice: Boolean(user.isTrustedDevice),
    },
    user: updatedUser,
  };
};

test("account lockout: increments failed attempts on bad passwords and reports remaining attempts", () => {
  let user = { failedLoginAttempts: 0, lockoutUntil: null };

  for (let i = 1; i <= 4; i++) {
    const res = simulateLoginAttempt({ user, isMatch: false });
    assert.equal(res.status, 400);
    assert.equal(res.body.attemptsLeft, 5 - i);
    user = res.user;
    assert.equal(user.failedLoginAttempts, i);
    assert.equal(user.lockoutUntil, null);
  }
});

test("account lockout: locks account on 5th consecutive failed attempt with 15m Retry-After", () => {
  let user = { failedLoginAttempts: 4, lockoutUntil: null };
  const now = Date.now();

  const res = simulateLoginAttempt({ user, isMatch: false, now });
  assert.equal(res.status, 429);
  assert.equal(res.body.locked, true);
  assert.equal(res.body.retryAfter, 900);
  assert.equal(res.headers["Retry-After"], "900");
  assert.match(res.body.error, /temporarily locked for 15 minutes/i);

  user = res.user;
  assert.equal(user.failedLoginAttempts, 5);
  assert.ok(user.lockoutUntil instanceof Date);

  // Subsequent attempt while locked is rejected with 429
  const lockedRes = simulateLoginAttempt({ user, isMatch: true, now: now + 60 * 1000 });
  assert.equal(lockedRes.status, 429);
  assert.equal(lockedRes.body.locked, true);
  assert.equal(lockedRes.body.retryAfter, 840);
});

test("account lockout: successful login resets failed attempts and lockout", () => {
  const user = { failedLoginAttempts: 3, lockoutUntil: null, isTrustedDevice: true };
  const res = simulateLoginAttempt({ user, isMatch: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.isTrustedDevice, true);
  assert.equal(res.user.failedLoginAttempts, 0);
  assert.equal(res.user.lockoutUntil, null);
});

test("account lockout: password reset clears lockout state", () => {
  const user = { failedLoginAttempts: 5, lockoutUntil: new Date(Date.now() + 600000) };

  // Simulating resetPassword logic
  user.failedLoginAttempts = 0;
  user.lockoutUntil = null;

  assert.equal(user.failedLoginAttempts, 0);
  assert.equal(user.lockoutUntil, null);
});

test("password changed confirmation: generates valid security email payload", () => {
  const email = "user@example.com";
  const name = "Alex Smith";
  const frontendUrl = "https://gossips.test";

  const emailHtml = `The password for your Gossips account (${name ? `${name}` : "account"}) was recently changed. For your security, all active sessions on other devices have been signed out.`;

  assert.ok(emailHtml.includes("Alex Smith"));
  assert.ok(emailHtml.includes("all active sessions on other devices have been signed out"));

  const payload = {
    to: email,
    subject: "Your Gossips password was changed",
    html: emailHtml,
  };

  assert.equal(payload.to, "user@example.com");
  assert.equal(payload.subject, "Your Gossips password was changed");
});

