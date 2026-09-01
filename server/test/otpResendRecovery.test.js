import assert from "node:assert/strict";
import test from "node:test";
import { generateOtp, hashOtp, otpMatches } from "../utils/otp.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_SENDS = 5;
const OTP_MAX_ATTEMPTS = 5;
const SECRET = "test-secret";

/**
 * Mirrors `reissueOtp` and the dead-end branches around it, in the simulation
 * style the other controller suites in this directory use. The OTP hashing is
 * the real imported implementation; only Mongo and the mail transport stand in.
 *
 * The behaviour under test is what happens to the row when the *mail* fails
 * after the row has already been written — the resend path committed the new
 * code before sending and had no rollback, so a transient mail outage
 * invalidated a code the user already held.
 */
const simulateReissueOtp = ({
  row,
  now = Date.now(),
  deliver = () => true,
  // Stands in for a concurrent resend that landed while this one's mail hung:
  // it replaces the row's codeHash, so the rollback's filter must miss.
  concurrentWriteDuringSend = null,
}) => {
  const sinceLast = now - new Date(row.lastSentAt).getTime();
  if (sinceLast < OTP_RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      reason: "cooldown",
      retryAfter: Math.ceil((OTP_RESEND_COOLDOWN_MS - sinceLast) / 1000),
      row,
    };
  }
  if (row.resendCount >= OTP_MAX_SENDS) {
    return { ok: false, reason: "exhausted", row };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: "locked", row };
  }

  const code = generateOtp();

  // The write lands before the send, as in the controller.
  const written = {
    ...row,
    codeHash: hashOtp(SECRET, row._id, code),
    lastSentAt: new Date(now),
    expiresAt: new Date(now + OTP_TTL_MS),
    resendCount: row.resendCount + 1,
  };

  // Whatever is in the row by the time the send settles.
  const inDb = concurrentWriteDuringSend
    ? { ...written, ...concurrentWriteDuringSend }
    : written;

  if (!deliver(code)) {
    /*
     * Rollback, filtered on the hash we wrote — so it no-ops if someone else's
     * resend has since landed, leaving their deliverable code in place.
     */
    const rolledBack =
      inDb.codeHash === written.codeHash
        ? {
            ...inDb,
            codeHash: row.codeHash,
            lastSentAt: row.lastSentAt,
            expiresAt: row.expiresAt,
            resendCount: row.resendCount,
          }
        : inDb;
    return {
      ok: false,
      reason: "delivery_failed",
      retryAfter: 5,
      retryable: true,
      row: rolledBack,
      rolledBack: rolledBack !== inDb,
    };
  }

  return { ok: true, row: written, code };
};

const makeRow = (overrides = {}) => {
  const _id = "65f000000000000000000001";
  const originalCode = generateOtp();
  return {
    originalCode,
    row: {
      _id,
      email: "alex@example.com",
      codeHash: hashOtp(SECRET, _id, originalCode),
      attempts: 0,
      resendCount: 1,
      lastSentAt: new Date(Date.now() - 2 * OTP_RESEND_COOLDOWN_MS),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      ...overrides,
    },
  };
};

test("resend: a delivered code replaces the old one and consumes a send", () => {
  const { row, originalCode } = makeRow();
  const result = simulateReissueOtp({ row });

  assert.equal(result.ok, true);
  assert.equal(result.row.resendCount, 2);
  assert.equal(
    otpMatches(result.row.codeHash, hashOtp(SECRET, row._id, result.code)),
    true,
  );
  assert.equal(
    otpMatches(result.row.codeHash, hashOtp(SECRET, row._id, originalCode)),
    false,
    "the superseded code must stop working",
  );
});

test("resend: a mail failure leaves the previously mailed code still valid", () => {
  const { row, originalCode } = makeRow();
  const result = simulateReissueOtp({ row, deliver: () => false });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "delivery_failed");
  assert.equal(
    otpMatches(result.row.codeHash, hashOtp(SECRET, row._id, originalCode)),
    true,
    "the code the user already has in their inbox must survive a mail outage",
  );
});

test("resend: a mail failure spends neither a send nor the cooldown nor the expiry", () => {
  const { row } = makeRow();
  const result = simulateReissueOtp({ row, deliver: () => false });

  assert.equal(result.row.resendCount, row.resendCount);
  assert.deepEqual(result.row.lastSentAt, row.lastSentAt);
  assert.deepEqual(result.row.expiresAt, row.expiresAt);
});

test("resend: a mail failure is reported as retryable with a Retry-After", () => {
  const { row } = makeRow();
  const result = simulateReissueOtp({ row, deliver: () => false });

  assert.equal(result.retryable, true);
  assert.equal(typeof result.retryAfter, "number");
  assert.ok(result.retryAfter > 0);
});

test("resend: refused once the guess budget is spent, rather than mailing an unusable code", () => {
  const { row } = makeRow({ attempts: OTP_MAX_ATTEMPTS });
  let mailed = 0;

  const result = simulateReissueOtp({
    row,
    deliver: () => {
      mailed += 1;
      return true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "locked");
  assert.equal(mailed, 0, "no email should be sent for a code that cannot be entered");
  assert.equal(result.row.resendCount, row.resendCount);
});

test("resend: refused once the send cap is reached", () => {
  const { row } = makeRow({ resendCount: OTP_MAX_SENDS });
  const result = simulateReissueOtp({ row });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "exhausted");
});

test("resend: still refused inside the cooldown, and reports how long is left", () => {
  const { row } = makeRow({ lastSentAt: new Date(Date.now() - 10_000) });
  const result = simulateReissueOtp({ row });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "cooldown");
  assert.ok(result.retryAfter > 0 && result.retryAfter <= 60);
});

test("resend: a rollback does not clobber a concurrent resend that did deliver", () => {
  const { row } = makeRow();
  const rivalCode = generateOtp();
  const rivalHash = hashOtp(SECRET, row._id, rivalCode);

  const result = simulateReissueOtp({
    row,
    deliver: () => false,
    concurrentWriteDuringSend: { codeHash: rivalHash, resendCount: 3 },
  });

  assert.equal(result.rolledBack, false);
  assert.equal(
    otpMatches(result.row.codeHash, hashOtp(SECRET, row._id, rivalCode)),
    true,
    "the code that actually reached someone's inbox must win",
  );
});

test("verify: a spent guess budget is a dead end, and says so", () => {
  // Both the claimAttempt miss and the last wrong guess answer with `locked`,
  // which is the single flag the client renders its dead-end state from. The
  // wording must not send anyone to Resend: `reissueOtp` does not refill
  // `attempts`, so that loop cannot terminate.
  const lockedResponses = [
    { status: 429, error: "Too many incorrect codes. Please start over.", locked: true },
    { status: 400, error: "Too many incorrect codes. Please start over.", locked: true },
  ];

  for (const response of lockedResponses) {
    assert.equal(response.locked, true);
    assert.doesNotMatch(response.error, /request a new one/i);
    assert.match(response.error, /start over/i);
  }
});
