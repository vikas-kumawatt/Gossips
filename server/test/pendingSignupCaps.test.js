import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { loadAuth, db, resetDb, makeRes, makeReq, makeUser } from "./authHarness.mjs";

/**
 * Per-address signup caps, against the real `signupUser`.
 *
 * This file used to build its own `startPendingSignup` and assert against it,
 * which meant the caps could be deleted from the controller without a single
 * failure. They exist to stop an attacker cycling a victim's inbox, so the test
 * needs to notice when they stop applying.
 */

let auth;
before(async () => {
  auth = await loadAuth();
});
beforeEach(resetDb);

const MAX_PENDING_PER_EMAIL = 5;
const MAX_SENDS_PER_EMAIL = 15;
const VICTIM = "victim@example.com";

const signup = async (email = VICTIM, name = "Someone") => {
  const res = makeRes();
  await auth.signupUser(makeReq({ name, email, password: "Password123" }), res);
  return res;
};

const liveRows = (email = VICTIM) =>
  db.pending.filter((row) => row.email === email && row.expiresAt > new Date());

test("caps: signups stop at the row cap and no further mail is sent", async () => {
  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) {
    const res = await signup();
    assert.equal(res.body.requiresVerification, true, `signup ${i + 1} should be allowed`);
  }
  assert.equal(db.mail.length, MAX_PENDING_PER_EMAIL);

  const refused = await signup();
  assert.equal(refused.statusCode, 429);
  assert.match(refused.body.error, /too many pending/i);
  assert.equal(db.mail.length, MAX_PENDING_PER_EMAIL, "a refused signup mails nothing");
  assert.equal(liveRows().length, MAX_PENDING_PER_EMAIL);
});

test("caps: simultaneous signups cannot exceed the row cap", async () => {
  /*
   * The case the cap exists for, and the one the sequential tests above cannot
   * reach: they are stopped by the cheap pre-insert count, which is only a fast
   * path. Requests arriving together all read the same count and all pass it —
   * with a bcrypt hash inside that window — so enforcement has to happen after
   * the insert. Firing these with `Promise.all` interleaves them at exactly
   * those await points.
   */
  const results = await Promise.all(Array.from({ length: 12 }, () => signup()));

  assert.ok(
    liveRows().length <= MAX_PENDING_PER_EMAIL,
    `cap must hold under concurrency, got ${liveRows().length} rows`,
  );
  assert.equal(
    results.filter((res) => res.body?.requiresVerification).length,
    liveRows().length,
    "every accepted signup keeps a row, and every refused one keeps none",
  );
  assert.equal(db.mail.length, liveRows().length, "a refused signup mails nothing");
});

test("caps: refusing never evicts an existing row", async () => {
  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) await signup();
  const before = liveRows().map((row) => String(row._id));

  await signup();
  await signup();

  assert.deepEqual(
    liveRows().map((row) => String(row._id)),
    before,
    "an attacker must not be able to invalidate a code the victim is holding",
  );
});

test("caps: the refusal quotes the wait until the earliest row expires", async () => {
  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) await signup();

  const refused = await signup();
  assert.ok(refused.body.retryAfter > 0);
  assert.ok(refused.body.retryAfter <= 600, "bounded by the ten-minute OTP window");
  assert.equal(refused.headers["Retry-After"], String(refused.body.retryAfter));
});

test("caps: expired rows free the budget", async () => {
  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) await signup();
  assert.equal((await signup()).statusCode, 429);

  for (const row of db.pending) row.expiresAt = new Date(Date.now() - 1000);

  const res = await signup();
  assert.equal(res.body.requiresVerification, true);
});

test("caps: the per-address send budget bounds the inbox, not just the row count", async () => {
  /*
   * Five rows resent to their per-row caps is 25 messages to one inbox, which
   * the row cap alone permits — each row's counters cannot see the other four.
   */
  await signup();
  db.pending[0].resendCount = MAX_SENDS_PER_EMAIL;

  const refused = await signup();
  assert.equal(refused.statusCode, 429);
  assert.match(refused.body.error, /too many verification emails/i);
  assert.equal(db.mail.length, 1, "nothing further reaches the inbox");
});

test("caps: an ordinary signup is nowhere near either cap", async () => {
  const res = await signup("alex@example.com", "Alex");

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.requiresVerification, true);
  assert.equal(liveRows("alex@example.com").length, 1);
  assert.equal(liveRows("alex@example.com")[0].resendCount, 1);
});

test("caps: one address's budget does not affect another's", async () => {
  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) await signup();
  assert.equal((await signup()).statusCode, 429);

  const other = await signup("someone-else@example.com", "Other");
  assert.equal(other.body.requiresVerification, true);
});

test("caps: a mail failure deletes the row rather than holding a slot", async () => {
  const { mailTransport } = await import("./authHarness.mjs");
  mailTransport.failNext = true;

  const res = await signup();

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.retryable, true);
  assert.equal(res.headers["Retry-After"], "5");
  assert.equal(liveRows().length, 0, "no slot held by a code nobody received");
});

test("caps: an address already owned by an account never reaches the cap logic", async () => {
  db.users.push(makeUser({ email: VICTIM }));

  const res = await signup();

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "User already exists");
  assert.equal(db.pending.length, 0);
  assert.equal(db.mail.length, 0);
});
