import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_POST_GAP_FLOOR_MS,
  minPostGapMs,
  shouldPostThisCycle,
  wakingHours,
} from "../bots/pacing.js";

/**
 * Spreading a bot's daily posts across its day.
 *
 * The claim being tested is a distribution — "the timestamps should not read as a batch job" —
 * so it is tested as one: a simulated day of twenty-minute cycles, run with an injected random
 * source, asserting on where the posts landed rather than on any single decision.
 *
 * Pure, so no database and no mocking. That is why `shouldPostThisCycle` takes `random` as an
 * argument at all.
 */

const HOURS_9_TO_23 = { startHour: 9, endHour: 23, timezone: "UTC" };

/* ── Waking window arithmetic ─────────────────────────────────────────────── */

test("wakingHours counts both ends, matching isAwake", () => {
  // 9..23 inclusive is fifteen hours. Off by one here is off by one in every gap below.
  assert.equal(wakingHours(HOURS_9_TO_23), 15);
  assert.equal(wakingHours({ startHour: 0, endHour: 23 }), 24);
  assert.equal(wakingHours({ startHour: 8, endHour: 8 }), 1);
});

test("wakingHours handles an overnight window", () => {
  // 22..06 is a perfectly ordinary persona, and the naive `end - start` makes it negative.
  assert.equal(wakingHours({ startHour: 22, endHour: 6 }), 9);
});

test("wakingHours falls back to a full day on junk", () => {
  assert.equal(wakingHours(null), 24);
  assert.equal(wakingHours({}), 24);
  assert.equal(wakingHours({ startHour: "nine", endHour: null }), 24);
});

/* ── The minimum gap ──────────────────────────────────────────────────────── */

test("the gap divides the waking day by the quota, with room to recover", () => {
  // Five posts across fifteen hours is one every three; two thirds of that is two hours.
  assert.equal(minPostGapMs(5, HOURS_9_TO_23), 2 * 60 * 60 * 1000);
});

test("a single post a day has no gap to keep", () => {
  assert.equal(minPostGapMs(1, HOURS_9_TO_23), 0);
  assert.equal(minPostGapMs(0, HOURS_9_TO_23), 0);
});

test("THE POINT: the gap never collapses to nothing, however tight the window", () => {
  /*
   * Twelve posts in a two-hour window works out at a six-minute gap, which is three cycles —
   * near enough to no spacing at all, and exactly the batch-job rhythm this exists to break.
   * The floor is what stops an aggressive configuration from disabling the feature.
   */
  const gap = minPostGapMs(12, { startHour: 9, endHour: 10 });
  assert.equal(gap, MIN_POST_GAP_FLOOR_MS);
});

/* ── The per-cycle decision ───────────────────────────────────────────────── */

const never = () => 0.999999;
const always = () => 0;

test("a bot that has met its quota does not post again", () => {
  const verdict = shouldPostThisCycle({
    publishedToday: 5,
    quota: 5,
    activeHours: HOURS_9_TO_23,
    random: always,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /all out/);
});

test("a bot configured never to post never posts", () => {
  const verdict = shouldPostThisCycle({ quota: 0, activeHours: HOURS_9_TO_23, random: always });
  assert.equal(verdict.allowed, false);
});

test("THE POINT: the gap is a hard floor, not a probability", () => {
  /*
   * Even with the dice maximally in its favour, a bot that posted ten minutes ago must wait.
   * If this were only weighted rather than absolute, two posts could still land back to back —
   * which is the single most legible machine signature an account can have.
   */
  const verdict = shouldPostThisCycle({
    publishedToday: 1,
    quota: 5,
    lastPostAt: new Date(Date.now() - 10 * 60 * 1000),
    activeHours: HOURS_9_TO_23,
    random: always,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /too recently/);
});

test("past the gap, a bot far behind schedule takes the slot", () => {
  // 22:00 on a 9–23 day with nothing posted: it is nearly out of day and owes everything.
  const verdict = shouldPostThisCycle({
    publishedToday: 0,
    quota: 3,
    lastPostAt: null,
    activeHours: HOURS_9_TO_23,
    at: new Date(Date.UTC(2026, 0, 1, 22, 0)),
    random: never,
  });
  assert.equal(verdict.allowed, true);
});

test("early in the day, an unlucky draw waits", () => {
  const verdict = shouldPostThisCycle({
    publishedToday: 0,
    quota: 3,
    lastPostAt: null,
    activeHours: HOURS_9_TO_23,
    at: new Date(Date.UTC(2026, 0, 1, 9, 0)),
    random: never,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /later in the day/);
});

/* ── The distribution, which is the actual claim ──────────────────────────── */

/**
 * One simulated day: a cycle every twenty minutes through the waking window, posting whenever
 * the gate allows. Returns the hours the posts landed on.
 */
const simulateDay = (quota, activeHours, random) => {
  const start = activeHours.startHour;
  const hours = wakingHours(activeHours);
  const posts = [];
  let lastPostAt = null;

  for (let minute = 0; minute < hours * 60; minute += 20) {
    const at = new Date(Date.UTC(2026, 0, 1, start, 0) + minute * 60 * 1000);
    const verdict = shouldPostThisCycle({
      publishedToday: posts.length,
      quota,
      lastPostAt,
      activeHours,
      at,
      random,
    });
    if (verdict.allowed) {
      posts.push(at);
      lastPostAt = at;
    }
  }
  return posts;
};

test("THE POINT: five posts do not arrive in the first hour", () => {
  /*
   * The reported behaviour, and the reason this module exists. `quota.owed` stays true until
   * the last post is out, so nothing stopped a bot publishing its whole day in three
   * consecutive cycles and going silent for the fourteen hours anyone was reading.
   *
   * `always` is the worst case: the dice never say wait, so only the gap and the pressure ramp
   * are doing any work.
   */
  const posts = simulateDay(5, HOURS_9_TO_23, always);

  const firstHour = posts.filter((at) => at.getUTCHours() === 9);
  assert.ok(firstHour.length <= 1, `${firstHour.length} posts in the first hour`);

  const spanMs = posts.length > 1 ? posts.at(-1) - posts[0] : 0;
  assert.ok(
    spanMs >= 6 * 60 * 60 * 1000,
    `posts spanned only ${Math.round(spanMs / 3600000)}h of a 15h day`
  );
});

test("no two posts in a day land inside the minimum gap", () => {
  const gap = minPostGapMs(5, HOURS_9_TO_23);
  const posts = simulateDay(5, HOURS_9_TO_23, always);

  for (let i = 1; i < posts.length; i += 1) {
    assert.ok(
      posts[i] - posts[i - 1] >= gap,
      `posts ${i - 1} and ${i} were ${(posts[i] - posts[i - 1]) / 60000}m apart, gap is ${gap / 60000}m`
    );
  }
});

test("the quota is still met over a day, not merely spread", () => {
  /*
   * The failure mode of pacing done badly: a bot so well behaved it never gets round to
   * posting. Averaged over runs with a real random source, because a single day can fall
   * short by one and that is fine — a person does too.
   */
  const days = 40;
  let total = 0;
  for (let day = 0; day < days; day += 1) {
    total += simulateDay(3, HOURS_9_TO_23, Math.random).length;
  }
  const average = total / days;
  assert.ok(average >= 2.4, `averaged ${average.toFixed(2)} of 3 posts a day`);
});

test("posts land across the whole day, not clustered at one end", () => {
  // Over many days every part of the window should see posts. A ramp that is too steep puts
  // them all at the end, which is the same failure as front-loading, mirrored.
  const buckets = new Set();
  for (let day = 0; day < 60; day += 1) {
    for (const at of simulateDay(3, HOURS_9_TO_23, Math.random)) {
      buckets.add(Math.floor((at.getUTCHours() - 9) / 5));
    }
  }
  assert.equal(buckets.size, 3, "all three five-hour thirds of the day should see posts");
});

test("a bot with an overnight window still paces", () => {
  // The window wraps midnight, so every hour-arithmetic bug shows up here as either no posts
  // at all or all of them at once.
  const overnight = { startHour: 22, endHour: 6, timezone: "UTC" };
  const posts = simulateDay(3, overnight, always);

  assert.ok(posts.length > 0, "an overnight bot must be able to post");
  const gap = minPostGapMs(3, overnight);
  for (let i = 1; i < posts.length; i += 1) {
    assert.ok(posts[i] - posts[i - 1] >= gap);
  }
});
