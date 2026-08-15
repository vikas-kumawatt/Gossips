/**
 * When a bot acts, and how often.
 *
 * Pure, and separated out for one concrete reason: pacing is the thing an eval has to be able to
 * measure. "A bot's timestamps should not read as a machine's" is a claim about a distribution over
 * hundreds of cycles, and you cannot make that claim about code you can only reach through a
 * database poller. The alternative — the eval re-implementing the interval and the jitter — would be
 * measuring a copy, which is worse than not measuring at all.
 *
 * Everything here was inside runner.js; nothing about it changed in the move.
 */

/**
 * Roughly how often an awake bot considers acting, before jitter.
 *
 * Twenty minutes is a person picking up their phone between other things. It is also what the
 * default hourly decision cap of six was sized against — three cycles an hour is the natural rate
 * and the cap is headroom for jitter, not permission to double it.
 */
export const CYCLE_INTERVAL_MS = 20 * 60 * 1000;

/**
 * Jitter, as a fraction of the interval.
 *
 * Believability, not load spreading. An account that acts at exactly 12:00, 12:20 and 12:40 is
 * legible as a machine from its timestamps alone, however human its text — and timestamps are the
 * one signal a persona cannot disguise.
 */
export const JITTER = 0.4;

/**
 * A random interval within ±`JITTER` of `base`.
 *
 * Uniform rather than normal. A normal distribution clusters around the mean, which is exactly the
 * legibility this exists to break up; a uniform spread across ±40% gives no modal interval to spot.
 */
export const jittered = (base) => {
  const spread = base * JITTER;
  return Math.round(base - spread + Math.random() * spread * 2);
};

/**
 * The hour of the day, in a given timezone.
 *
 * `Intl` rather than an offset table, because an offset table is wrong twice a year. An invalid
 * timezone string throws a `RangeError`, so it falls back to UTC rather than taking the caller
 * down — a bot with a typo'd timezone should be a bot on the wrong schedule, not a dead poller.
 */
export const hourIn = (timezone, at = new Date()) => {
  try {
    return Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "UTC", hour: "2-digit", hour12: false }).format(at)
    );
  } catch {
    return at.getUTCHours();
  }
};

/**
 * Is this bot inside its waking hours?
 *
 * Handles the overnight case — `startHour: 22, endHour: 6` — rather than treating it as an empty
 * window, because "awake late, asleep in the morning" is a perfectly ordinary persona and the
 * naive `start <= h <= end` comparison silently makes such a bot never run at all.
 *
 * Both ends are inclusive: `endHour: 23` means awake until 23:59, which is what an owner setting
 * "23" means.
 */
export const isAwake = (activeHours, at = new Date()) => {
  const start = Number.isInteger(activeHours?.startHour) ? activeHours.startHour : 0;
  const end = Number.isInteger(activeHours?.endHour) ? activeHours.endHour : 23;
  const hour = hourIn(activeHours?.timezone, at);

  if (start === end) return hour === start;
  if (start < end) return hour >= start && hour <= end;
  return hour >= start || hour <= end;
};

/**
 * When to wake a sleeping bot.
 *
 * Sleeping until the window opens rather than re-checking every twenty minutes all night. The
 * saving is not the queries — it is the audit log: a bot asleep for nine hours would otherwise
 * write twenty-seven `cycle_skipped` rows a night, for every bot, forever, burying the rows that
 * mean something.
 */
export const nextWakeAt = (activeHours, at = new Date()) => {
  const start = Number.isInteger(activeHours?.startHour) ? activeHours.startHour : 0;
  const hour = hourIn(activeHours?.timezone, at);
  const hoursUntil = (start - hour + 24) % 24 || 24;
  /*
   * To the top of the hour, plus jitter inside it. Every bot in a timezone shares a start hour, so
   * waking them all on the same minute would produce exactly the synchronised spike the per-bot
   * timestamp exists to avoid.
   */
  return new Date(at.getTime() + hoursUntil * 60 * 60 * 1000 + jittered(30 * 60 * 1000));
};

/**
 * The next run time for a bot that just finished a cycle.
 *
 * `failures` stretches the interval linearly once the runner's backoff threshold is passed, so a
 * reasoning service down for an hour is asked about eight times rather than a hundred and eighty.
 */
export const nextRunAfterCycle = (failures = 0, at = new Date()) => {
  const multiplier = failures >= 3 ? failures : 1;
  return new Date(at.getTime() + jittered(CYCLE_INTERVAL_MS * multiplier));
};

/* ── Spreading the day's posts ─────────────────────────────────────────────── */

/**
 * How many hours a bot is awake for, given its window. Inclusive at both ends, matching
 * `isAwake` — `startHour: 8, endHour: 22` is fifteen hours, not fourteen.
 */
export const wakingHours = (activeHours) => {
  const start = Number.isInteger(activeHours?.startHour) ? activeHours.startHour : 0;
  const end = Number.isInteger(activeHours?.endHour) ? activeHours.endHour : 23;
  if (start === end) return 1;
  return start < end ? end - start + 1 : 24 - start + end + 1;
};

/**
 * The shortest gap the bot should leave between two of its own posts.
 *
 * Its whole day divided by its quota, minus a margin. Five posts across a fifteen-hour day is
 * one roughly every three hours, and this asks for at least two — enough to stop them arriving
 * as a block, loose enough that a bot with something to say twice in an afternoon can.
 *
 * The margin matters. At exactly `day / quota` a bot that slips a few minutes late on any post
 * can never catch up and finishes the day short, which turns a pacing rule into a silent quota
 * cut. Two thirds leaves room to recover.
 */
export const MIN_POST_GAP_FLOOR_MS = 20 * 60 * 1000;

export const minPostGapMs = (postsPerDay, activeHours) => {
  const quota = Number.isFinite(postsPerDay) ? Math.max(0, postsPerDay) : 0;
  if (quota <= 1) return 0;

  const dayMs = wakingHours(activeHours) * 60 * 60 * 1000;
  // A floor, so a bot configured with twelve posts in a two-hour window still doesn't fire
  // them all in consecutive cycles.
  return Math.max(MIN_POST_GAP_FLOOR_MS, Math.round((dayMs / quota) * (2 / 3)));
};

/**
 * Should this cycle be allowed to post?
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * A bot wakes every twenty minutes and knows only that it owes posts. Nothing stopped it
 * publishing all five in the first hour and going silent until tomorrow — which is exactly
 * what the quota-owed logic encouraged, since `owed` stays true until the last one is out. The
 * timestamps then read as a batch job, and the account is quiet for the fourteen hours anyone
 * would actually be reading it.
 *
 * ── Two rules, and why neither alone is enough ──────────────────────────────
 *
 * A minimum gap on its own still front-loads: the bot posts the instant each gap expires and
 * is done by mid-afternoon. A probability on its own can bunch, because independent draws
 * happily come up twice in a row.
 *
 * So: the gap is a hard floor, and past it the chance of posting rises with how far behind
 * schedule the bot is. Early in the day, with the quota untouched, `pressure` is near zero and
 * it usually waits. By the end of the window a bot still owing posts is near-certain to take
 * the slot. The result spreads across the day without a schedule to store, and it re-derives
 * itself correctly the moment an owner changes the quota or the hours.
 *
 * Pure, and `random` is injectable, because "the distribution looks like a person's" is a claim
 * about hundreds of cycles and has to be measurable without a database.
 *
 * @param {object} args
 * @param {number} args.publishedToday posts already out in the last 24h
 * @param {number} args.quota `postsPerDay`
 * @param {Date|null} args.lastPostAt when the most recent one went out
 * @param {object} args.activeHours the bot's waking window
 * @param {Date} [args.at] now
 * @param {Function} [args.random] () => [0,1)
 * @returns {{allowed: boolean, reason: string}}
 */
export const shouldPostThisCycle = ({
  publishedToday = 0,
  quota = 0,
  lastPostAt = null,
  activeHours = null,
  at = new Date(),
  random = Math.random,
}) => {
  if (quota <= 0) return { allowed: false, reason: "this account doesn't post" };
  if (publishedToday >= quota) return { allowed: false, reason: "today's posts are all out" };

  const gap = minPostGapMs(quota, activeHours);
  if (lastPostAt && gap > 0) {
    const since = at.getTime() - new Date(lastPostAt).getTime();
    if (since < gap) {
      return { allowed: false, reason: "posted too recently to post again" };
    }
  }

  /*
   * How far through its waking day the bot is, against how much of its quota is gone. A bot
   * three hours into a fifteen-hour day having posted nothing is at pressure ~0.2; the same bot
   * at hour fourteen having posted nothing is at ~0.93 and will almost certainly take the slot.
   *
   * Squared, so the early-day probability is low rather than merely lowish — an unsquared
   * linear ramp still posts about half its quota in the first third of the day, which is the
   * front-loading this exists to prevent.
   */
  const hours = wakingHours(activeHours);
  const start = Number.isInteger(activeHours?.startHour) ? activeHours.startHour : 0;
  const hour = hourIn(activeHours?.timezone, at);
  const elapsed = ((hour - start + 24) % 24) + 1;
  const throughDay = Math.min(1, elapsed / hours);

  const quotaUsed = publishedToday / quota;
  const behind = Math.max(0, throughDay - quotaUsed);

  /*
   * A floor, so a bot that is exactly on schedule still posts sometimes rather than only ever
   * catching up. Without it a bot whose first post lands early is suppressed until the clock
   * overtakes it, which produces a different unnatural rhythm rather than no rhythm.
   */
  const chance = Math.min(1, 0.15 + behind * behind * 4);

  return random() < chance
    ? { allowed: true, reason: "" }
    : { allowed: false, reason: "saving it for later in the day" };
};
