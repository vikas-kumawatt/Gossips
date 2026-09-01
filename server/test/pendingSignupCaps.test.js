import assert from "node:assert/strict";
import test from "node:test";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_SENDS = 5;
const MAX_PENDING_PER_EMAIL = 5;
const MAX_SENDS_PER_EMAIL = 15;

/**
 * Mirrors the per-address caps in `startPendingSignup`, in the simulation style
 * the other controller suites here use.
 *
 * The behaviour under test is what happens when signups for one address arrive
 * *together*. The cap was a read-then-write with a bcrypt hash in the window,
 * so concurrent requests all read the same count and all created a row — which
 * defeats the attacker the cap names (many IPs doing together what one cannot
 * do alone). Enforcement therefore has to happen after the insert.
 */

/** An in-memory stand-in for the PendingSignup collection. */
const makeStore = () => {
  let seq = 0;
  return {
    rows: [],
    /** Monotonic like an ObjectId, which is what the ranking relies on. */
    nextId: () => `row-${String(++seq).padStart(6, "0")}`,
    live(email, now) {
      return this.rows.filter((row) => row.email === email && row.expiresAt > now);
    },
  };
};

const censusForAddress = (store, email, now) => {
  const live = store.live(email, now).sort((a, b) => a.expiresAt - b.expiresAt);
  return {
    rows: live.length,
    sends: live.reduce((total, row) => total + (row.resendCount || 0), 0),
    earliestExpiry: live[0]?.expiresAt ?? null,
  };
};

/**
 * @param phase "precheck" runs only the cheap look; "commit" runs the insert and
 *        the authoritative re-check. Splitting them is what lets a test hold
 *        several requests inside the old race window at once.
 */
const startPendingSignup = (store, email, now, { phase = "both" } = {}) => {
  if (phase === "both" || phase === "precheck") {
    const before = censusForAddress(store, email, now);
    if (before.rows >= MAX_PENDING_PER_EMAIL) {
      return { ok: false, status: 429, reason: "rows", earliestExpiry: before.earliestExpiry };
    }
    if (before.sends >= MAX_SENDS_PER_EMAIL) {
      return { ok: false, status: 429, reason: "sends", earliestExpiry: before.earliestExpiry };
    }
    if (phase === "precheck") return { ok: true, passedPrecheck: true };
  }

  const _id = store.nextId();
  store.rows.push({
    _id,
    email,
    resendCount: 1,
    expiresAt: now + OTP_TTL_MS,
  });

  // The authoritative check: rank by creation order, trim only our own row.
  const contenders = store
    .live(email, now)
    .slice()
    .sort((a, b) => (a._id < b._id ? -1 : 1));
  const rank = contenders.findIndex((candidate) => candidate._id === _id);

  if (rank >= MAX_PENDING_PER_EMAIL) {
    store.rows = store.rows.filter((row) => row._id !== _id);
    const census = censusForAddress(store, email, now);
    return { ok: false, status: 429, reason: "rows", earliestExpiry: census.earliestExpiry, mailed: false };
  }

  return { ok: true, _id, mailed: true };
};

const VICTIM = "victim@example.com";

test("pending caps: sequential signups stop at the row cap and send no further mail", () => {
  const store = makeStore();
  const now = Date.now();
  let mailed = 0;

  for (let i = 0; i < 8; i++) {
    const result = startPendingSignup(store, VICTIM, now);
    if (result.mailed) mailed += 1;
  }

  assert.equal(store.live(VICTIM, now).length, MAX_PENDING_PER_EMAIL);
  assert.equal(mailed, MAX_PENDING_PER_EMAIL);
});

test("pending caps: concurrent signups cannot exceed the row cap", () => {
  const store = makeStore();
  const now = Date.now();

  /*
   * Ten requests all clear the cheap pre-check against an empty address —
   * exactly what the bcrypt-sized window allowed — and only then commit.
   */
  const precheck = Array.from({ length: 10 }, () =>
    startPendingSignup(store, VICTIM, now, { phase: "precheck" }),
  );
  assert.ok(
    precheck.every((result) => result.ok),
    "all ten must pass the pre-check, which is the race being simulated",
  );

  const committed = Array.from({ length: 10 }, () =>
    startPendingSignup(store, VICTIM, now, { phase: "commit" }),
  );

  assert.equal(
    store.live(VICTIM, now).length,
    MAX_PENDING_PER_EMAIL,
    "the cap must hold even when every request passed the pre-check",
  );
  assert.equal(committed.filter((result) => result.ok).length, MAX_PENDING_PER_EMAIL);
  assert.equal(
    committed.filter((result) => result.mailed).length,
    MAX_PENDING_PER_EMAIL,
    "a rejected attempt must not mail anything",
  );
});

test("pending caps: the rows that survive are the earliest created, never evicted", () => {
  const store = makeStore();
  const now = Date.now();

  const kept = [];
  for (let i = 0; i < 8; i++) {
    const result = startPendingSignup(store, VICTIM, now);
    if (result.ok) kept.push(result._id);
  }

  const surviving = store.live(VICTIM, now).map((row) => row._id);
  assert.deepEqual(surviving, kept, "no existing row's code may be invalidated");
  assert.deepEqual(
    surviving,
    [...surviving].sort(),
    "survivors are the first MAX_PENDING_PER_EMAIL by creation",
  );
});

test("pending caps: per-address send budget bounds the inbox, not just the row count", () => {
  const store = makeStore();
  const now = Date.now();

  // Five rows at the cap, each resent to its own per-row limit.
  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) startPendingSignup(store, VICTIM, now);
  for (const row of store.live(VICTIM, now)) row.resendCount = OTP_MAX_SENDS;

  const census = censusForAddress(store, VICTIM, now);
  assert.equal(
    census.sends,
    MAX_PENDING_PER_EMAIL * OTP_MAX_SENDS,
    "this is the 25-email worst case the row cap alone permits",
  );
  assert.ok(
    census.sends > MAX_SENDS_PER_EMAIL,
    "which is exactly why a per-address send cap is needed on top of it",
  );

  const refused = startPendingSignup(store, VICTIM, now);
  assert.equal(refused.ok, false);
});

test("pending caps: an ordinary signup is nowhere near either cap", () => {
  const store = makeStore();
  const now = Date.now();

  const result = startPendingSignup(store, "alex@example.com", now);
  assert.equal(result.ok, true);

  const census = censusForAddress(store, "alex@example.com", now);
  assert.equal(census.rows, 1);
  assert.equal(census.sends, 1);
  assert.ok(census.rows < MAX_PENDING_PER_EMAIL);
  assert.ok(census.sends < MAX_SENDS_PER_EMAIL);
});

test("pending caps: a frustrated real user retrying still fits inside the send budget", () => {
  // Three full signup attempts, each resent to the per-row cap. This is the
  // worst legitimate path, and it must not be refused.
  const store = makeStore();
  const now = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = startPendingSignup(store, "alex@example.com", now);
    assert.equal(result.ok, true, `attempt ${attempt + 1} must be allowed`);
    store.rows.find((row) => row._id === result._id).resendCount = OTP_MAX_SENDS;
  }

  const census = censusForAddress(store, "alex@example.com", now);
  assert.equal(census.sends, 15);
  assert.ok(
    census.sends <= MAX_SENDS_PER_EMAIL,
    "MAX_SENDS_PER_EMAIL must leave room for three genuine attempts",
  );
});

test("pending caps: expired rows free both budgets", () => {
  const store = makeStore();
  const now = Date.now();

  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) startPendingSignup(store, VICTIM, now);
  assert.equal(startPendingSignup(store, VICTIM, now).ok, false);

  const later = now + OTP_TTL_MS + 1;
  const census = censusForAddress(store, VICTIM, later);
  assert.equal(census.rows, 0);
  assert.equal(census.sends, 0);
  assert.equal(startPendingSignup(store, VICTIM, later).ok, true);
});

test("pending caps: refusal quotes the wait until the earliest row expires", () => {
  const store = makeStore();
  const now = Date.now();

  for (let i = 0; i < MAX_PENDING_PER_EMAIL; i++) startPendingSignup(store, VICTIM, now);

  const atFiveMinutes = now + 5 * 60 * 1000;
  const refused = startPendingSignup(store, VICTIM, atFiveMinutes);
  assert.equal(refused.ok, false);

  const retryAfter = Math.max(1, Math.ceil((refused.earliestExpiry - atFiveMinutes) / 1000));
  assert.equal(retryAfter, 300, "five minutes left of the oldest row's ten");
});
