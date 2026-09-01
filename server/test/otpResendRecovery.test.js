import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import {
  loadAuth,
  db,
  resetDb,
  makeRes,
  makeReq,
  mailedCode,
  mailTransport,
} from "./authHarness.mjs";

/**
 * Resend, its budgets and its failure recovery, against the real handlers.
 *
 * The previous version simulated `reissueOtp` locally, so the rollback it was
 * written to prove could have been deleted from the controller without any
 * failure. The rollback is the whole point: the new code is written *before*
 * the mail is sent, so a delivery failure without one leaves the row holding a
 * code nobody received and invalidates the one already in the user's inbox.
 */

let auth;
before(async () => {
  auth = await loadAuth();
});
beforeEach(() => {
  resetDb();
  mailTransport.fail = false;
  mailTransport.failNext = false;
});

const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS = 5;
const COOLDOWN_MS = 60 * 1000;

/** Start a signup and return its ticket plus the code that was mailed. */
const startSignup = async (email = "alex@example.com") => {
  const res = makeRes();
  await auth.signupUser(makeReq({ name: "Alex Smith", email, password: "Password123" }), res);
  assert.equal(res.body.requiresVerification, true, "signup should have started");
  return { token: res.body.verificationToken, code: mailedCode(), row: db.pending.at(-1) };
};

/** Move a row past its resend cooldown. */
const clearCooldown = (row) => {
  row.lastSentAt = new Date(Date.now() - COOLDOWN_MS - 1000);
};

const resend = async (token) => {
  const res = makeRes();
  await auth.resendOtp(makeReq({ token }), res);
  return res;
};

const verify = async (token, code) => {
  const res = makeRes();
  await auth.verifyOtp(makeReq({ token, code }), res);
  return res;
};

// ── Ordinary resend ──────────────────────────────────────────────────────────

test("resend: mails a new code, supersedes the old one, and spends a send", async () => {
  const { token, code, row } = await startSignup();
  clearCooldown(row);

  const res = await resend(token);
  assert.equal(res.statusCode, 200);
  assert.equal(row.resendCount, 2);

  const fresh = mailedCode();
  assert.notEqual(fresh, code);
  assert.equal((await verify(token, code)).statusCode, 400, "the superseded code stops working");
  assert.equal((await verify(res.body.verificationToken, fresh)).statusCode, 201);
});

test("resend: refused inside the cooldown, and says how long is left", async () => {
  const { token } = await startSignup();

  const res = await resend(token);
  assert.equal(res.statusCode, 429);
  assert.ok(res.body.retryAfter > 0 && res.body.retryAfter <= 60);
});

test("resend: refused once the send cap is reached", async () => {
  const { token, row } = await startSignup();
  row.resendCount = OTP_MAX_SENDS;
  clearCooldown(row);

  const res = await resend(token);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.exhausted, true);
});

// ── Delivery failure ─────────────────────────────────────────────────────────

test("resend: a mail failure leaves the code already in the inbox still valid", async () => {
  const { token, code, row } = await startSignup();
  clearCooldown(row);
  mailTransport.failNext = true;

  const res = await resend(token);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.retryable, true);
  assert.equal(res.headers["Retry-After"], "5");

  assert.equal(
    (await verify(token, code)).statusCode,
    201,
    "a transient SMTP outage must not invalidate a code the user is holding",
  );
});

test("resend: a mail failure spends neither a send, the cooldown, nor the expiry", async () => {
  const { token, row } = await startSignup();
  clearCooldown(row);
  const before = {
    resendCount: row.resendCount,
    lastSentAt: row.lastSentAt,
    expiresAt: row.expiresAt,
  };

  mailTransport.failNext = true;
  await resend(token);

  assert.equal(row.resendCount, before.resendCount);
  assert.deepEqual(row.lastSentAt, before.lastSentAt);
  assert.deepEqual(row.expiresAt, before.expiresAt);
});

// ── Dead ends ────────────────────────────────────────────────────────────────

test("verify: the guess budget is spent after five wrong codes and says to start over", async () => {
  const { token, code } = await startSignup();
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");

  for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt++) {
    const res = await verify(token, wrong);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.attemptsLeft, OTP_MAX_ATTEMPTS - attempt);
  }

  const spent = await verify(token, wrong);
  assert.equal(spent.body.locked, true);
  assert.match(spent.body.error, /start over/i);
  assert.doesNotMatch(
    spent.body.error,
    /request a new one/i,
    "a resend cannot refill the guess budget, so that instruction is a loop with no exit",
  );
});

test("verify: even the correct code is refused once the budget is spent", async () => {
  const { token, code, row } = await startSignup();
  row.attempts = OTP_MAX_ATTEMPTS;

  const res = await verify(token, code);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.locked, true);
});

test("resend: refused once the guess budget is spent, rather than mailing a dead code", async () => {
  const { token, row } = await startSignup();
  row.attempts = OTP_MAX_ATTEMPTS;
  clearCooldown(row);
  const mailedBefore = db.mail.length;

  const res = await resend(token);

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.locked, true);
  assert.equal(db.mail.length, mailedBefore, "no email for a code that could never be entered");
});

test("resend: does not reset the guess counter", async () => {
  // Otherwise the budget is OTP_MAX_ATTEMPTS × OTP_MAX_SENDS, with the attacker
  // choosing when to resend.
  const { token, row } = await startSignup();
  row.attempts = 3;
  clearCooldown(row);

  await resend(token);
  assert.equal(row.attempts, 3);
});

// ── Ticket lifetime ──────────────────────────────────────────────────────────

test("ticket: survives a resend whose response never reached the client", async () => {
  /*
   * A resend renews the row for another OTP window. A ticket scoped to one
   * window expired while its row was still alive whenever the client missed the
   * fresh ticket, discarding a live signup with a valid code in the inbox.
   */
  const { token: originalTicket, row } = await startSignup();

  clearCooldown(row);
  const renewed = await resend(originalTicket);
  assert.equal(renewed.statusCode, 200);

  // The client never saw `renewed.body.verificationToken`; it still holds the
  // original. It must still name the row.
  const res = await verify(originalTicket, mailedCode());
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.token, "the signup completes on the stale ticket");
});

test("ticket: a garbage ticket is refused without touching anything", async () => {
  for (const bad of ["", "not-a-jwt", null, 12345]) {
    const res = await verify(bad, "123456");
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.expired, true);
  }
});
