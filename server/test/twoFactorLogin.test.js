import assert from "node:assert/strict";
import test from "node:test";
import {
  generateTotpSecret,
  generateTotpCode,
  generateBackupCodes,
  verifyTotpCode,
  verifyBackupCode,
} from "../utils/twoFactor.js";

const MAX_FAILED_LOGIN_ATTEMPTS = 5;

/**
 * Mirrors the second-factor gate in authController (`passesTwoFactor` plus the
 * `rejectFailedAttempt` it calls), the way the other controller suites in this
 * directory mirror their handlers. The TOTP and backup-code checks are the real
 * imported ones — only the persistence and the response object are stood in for.
 *
 * Covers:
 * 1. No code supplied on a 2FA account: 200 needTwoFactor, no token.
 * 2. A wrong code counts against the same lockout counter a wrong password does.
 * 3. A valid TOTP code or an unused backup code passes; a used one does not.
 * 4. Accounts without 2FA are untouched.
 */
const simulateTwoFactorGate = ({ user, submittedCode }) => {
  if (!user.twoFactorEnabled) return { passed: true, user };

  if (!submittedCode) {
    return {
      passed: false,
      status: 200,
      body: { needTwoFactor: true },
      user,
    };
  }

  let valid = verifyTotpCode(submittedCode, user.twoFactorSecret);
  let nextUser = user;

  if (!valid) {
    const backupResult = verifyBackupCode(submittedCode, user.twoFactorBackupCodes || []);
    if (backupResult.valid) {
      valid = true;
      nextUser = {
        ...user,
        twoFactorBackupCodes: user.twoFactorBackupCodes.map((code, i) =>
          i === backupResult.index ? { ...code, used: true } : code
        ),
      };
    }
  }

  if (!valid) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
      return {
        passed: false,
        status: 429,
        body: { locked: true, retryAfter: 900 },
        user: { ...user, failedLoginAttempts: MAX_FAILED_LOGIN_ATTEMPTS, lockoutUntil: new Date() },
      };
    }
    return {
      passed: false,
      status: 400,
      body: {
        error: "Invalid two-factor authentication code",
        attemptsLeft: MAX_FAILED_LOGIN_ATTEMPTS - attempts,
      },
      user: { ...user, failedLoginAttempts: attempts },
    };
  }

  return { passed: true, user: nextUser };
};

const makeTwoFactorUser = (overrides = {}) => {
  const secret = generateTotpSecret();
  const { plainCodes, hashedCodes } = generateBackupCodes();
  return {
    user: {
      twoFactorEnabled: true,
      twoFactorSecret: secret,
      twoFactorBackupCodes: hashedCodes,
      failedLoginAttempts: 0,
      lockoutUntil: null,
      ...overrides,
    },
    secret,
    plainCodes,
  };
};

test("2FA gate: account without 2FA passes straight through", () => {
  const result = simulateTwoFactorGate({
    user: { twoFactorEnabled: false },
    submittedCode: undefined,
  });
  assert.equal(result.passed, true);
});

test("2FA gate: no code supplied answers needTwoFactor without issuing a session", () => {
  const { user } = makeTwoFactorUser();
  const result = simulateTwoFactorGate({ user, submittedCode: undefined });

  assert.equal(result.passed, false);
  assert.equal(result.status, 200);
  assert.equal(result.body.needTwoFactor, true);
  assert.equal(result.body.token, undefined);
});

test("2FA gate: a current TOTP code passes", () => {
  const { user, secret } = makeTwoFactorUser();
  const result = simulateTwoFactorGate({
    user,
    submittedCode: generateTotpCode(secret),
  });

  assert.equal(result.passed, true);
});

test("2FA gate: an unused backup code passes and is consumed; replaying it fails", () => {
  const { user, plainCodes } = makeTwoFactorUser();

  const first = simulateTwoFactorGate({ user, submittedCode: plainCodes[0] });
  assert.equal(first.passed, true);
  assert.equal(first.user.twoFactorBackupCodes[0].used, true);

  const replay = simulateTwoFactorGate({
    user: first.user,
    submittedCode: plainCodes[0],
  });
  assert.equal(replay.passed, false);
  assert.equal(replay.status, 400);
});

test("2FA gate: backup codes are accepted case-insensitively", () => {
  const { user, plainCodes } = makeTwoFactorUser();
  const result = simulateTwoFactorGate({
    user,
    submittedCode: plainCodes[0].toLowerCase(),
  });

  assert.equal(result.passed, true);
});

test("2FA gate: wrong codes increment the shared lockout counter and lock on the 5th", () => {
  let user = makeTwoFactorUser().user;

  for (let i = 1; i <= 4; i++) {
    const result = simulateTwoFactorGate({ user, submittedCode: "000000" });
    assert.equal(result.passed, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.attemptsLeft, MAX_FAILED_LOGIN_ATTEMPTS - i);
    user = result.user;
    assert.equal(user.failedLoginAttempts, i);
  }

  const locked = simulateTwoFactorGate({ user, submittedCode: "000000" });
  assert.equal(locked.passed, false);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.locked, true);
  assert.equal(locked.user.failedLoginAttempts, MAX_FAILED_LOGIN_ATTEMPTS);
});

test("2FA gate: failed password attempts carry into the code step", () => {
  // The counter reset moved to *after* the gate precisely so this holds: a
  // password-guessing run does not get its budget refilled by reaching 2FA.
  const { user } = makeTwoFactorUser({ failedLoginAttempts: 4 });
  const result = simulateTwoFactorGate({ user, submittedCode: "000000" });

  assert.equal(result.status, 429);
  assert.equal(result.body.locked, true);
});

test("2FA gate: malformed code inputs are rejected, not thrown on", () => {
  const { user } = makeTwoFactorUser();

  for (const bad of ["", "12345", "1234567", "notacode", "  ", "12 34 56"]) {
    const result = simulateTwoFactorGate({ user, submittedCode: bad });
    assert.equal(result.passed, false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});
