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
