import BotActionLog from "../models/BotActionLog.js";
import { getSettings } from "../utils/settings.js";

/**
 * How much a bot is allowed to do, and the switch that stops all of them at once.
 *
 * Three caps, each answering a different question:
 *
 *   · **decisions per hour** — cost. Every decision is an inference call against the owner's
 *     key, whether or not it produces an action. This is the only cap that protects a wallet.
 *   · **write actions per day** — believability, and the platform's exposure. An account that
 *     likes three hundred posts a day is not a person, and a runaway loop shows up here first.
 *   · **DM replies per hour** — the surface where a misbehaving bot is felt personally rather
 *     than scrolled past.
 *
 * ── Counted from the audit log, not from Redis ──────────────────────────────
 *
 * The plan called for Redis counters with a Mongo fallback. Building it, the fallback turned
 * out to be strictly better than the thing it was backing up, so the Redis half is gone.
 *
 * `BotActionLog` is written on every action and every cycle outcome regardless — it is the
 * regulatory record, not a cache — so the counts are already there, and reading them gives
 * three properties a counter key cannot:
 *
 *   · **Exact.** Redis is a cache. It can be cold, flushed, or evicted, and a cap that
 *     silently becomes infinite when a cache restarts is not a cap.
 *   · **Rolling, not fixed-window.** A `INCR`-per-hour-bucket key lets a bot spend its whole
 *     hourly budget at 10:59 and again at 11:01. A `createdAt: { $gte: oneHourAgo }` count
 *     cannot be gamed by waiting for a boundary.
 *   · **One implementation.** A dual backend means the cap that runs in production is
 *     whichever one Redis's health decided on, and the other path is the one that isn't
 *     tested.
 *
 * The cost is three indexed range counts per cycle, on a schedule measured in tens of minutes,
 * immediately before an inference call that takes seconds and costs money. Every index needed
 * already exists on the model for exactly this purpose.
 *
 * Concurrency isn't a concern here either, and not by luck: `BotPersona.claimedAt` serialises
 * cycles per bot, and every cap in this file is per bot. There is no second writer to race.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Defaults, chosen against what the runner can actually produce.
 *
 * A bot wakes roughly every 20 minutes inside its active hours, so three decisions an hour is
 * the natural rate and six is headroom for jitter rather than permission to double it. Six
 * actions per cycle × a 15-hour waking day would allow well over two hundred writes; sixty is
 * a busy, plausible person. Ten DM replies an hour is more than anyone types.
 */
export const DEFAULT_BOT_LIMITS = {
  decisionsPerHour: 6,
  actionsPerDay: 60,
  dmRepliesPerHour: 10,
};

/**
 * Actions that count against the daily cap: the ones that change something someone else can
 * see.
 *
 * `do_nothing`, `scroll_feed` and `view_profile` are deliberately absent. Charging a bot for
 * looking would push it toward acting — it would spend its remaining budget rather than
 * "waste" it on observing — which is the opposite of the behaviour the cap exists to produce.
 * `cycle_skipped` and `cycle_failed` are absent for the same reason: neither is activity.
 *
 * Exported so the executor decrements against the same list the counter counts.
 */
export const COUNTED_ACTIONS = [
  "like_post",
  "comment_post",
  "repost_post",
  "quote_post",
  "follow_user",
  "send_follow_request",
  "send_dm",
  "reply_dm",
  "create_post",
];

/**
 * Merge the admin-configured limits over the defaults.
 *
 * Pure, and tolerant: a missing, null or nonsensical value falls back to the default rather
 * than to zero. A settings document written before these fields existed must not silently
 * mean "this bot may do nothing".
 */
export const resolveBotLimits = (settings) => {
  const pick = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

  return {
    enabled: settings?.botsEnabled !== false,
    decisionsPerHour: pick(settings?.botMaxDecisionsPerHour, DEFAULT_BOT_LIMITS.decisionsPerHour),
    actionsPerDay: pick(settings?.botMaxActionsPerDay, DEFAULT_BOT_LIMITS.actionsPerDay),
    dmRepliesPerHour: pick(settings?.botMaxDmRepliesPerHour, DEFAULT_BOT_LIMITS.dmRepliesPerHour),
  };
};

/**
 * How many inference calls this bot has caused in the last hour.
 *
 * Counted as distinct `cycleId`s rather than rows, because one decision produces one call and
 * any number of action rows. Rows with an empty `cycleId` are pre-Phase-6 or hand-written and
 * are not attributable to a call.
 */
export const countDecisions = async (botId, since) => {
  const ids = await BotActionLog.distinct("cycleId", {
    bot: botId,
    createdAt: { $gte: since },
  });
  return ids.filter(Boolean).length;
};

/** Write actions actually carried out in the last day. Rejections don't count. */
export const countExecutedActions = async (botId, since) =>
  BotActionLog.countDocuments({
    bot: botId,
    action: { $in: COUNTED_ACTIONS },
    outcome: "executed",
    createdAt: { $gte: since },
  });

export const countDmReplies = async (botId, since) =>
  BotActionLog.countDocuments({
    bot: botId,
    action: { $in: ["reply_dm", "send_dm"] },
    outcome: "executed",
    createdAt: { $gte: since },
  });

/**
 * Posts this bot has published in the last day.
 *
 * Not a cap — the opposite. `postsPerDay` is the owner's instruction to *do* something, and this is
 * what makes it answerable: a bot under its quota has a reason to run a cycle even when nothing has
 * happened to it.
 *
 * Counted from the same log as every other number here, for the same reasons (see the note at the
 * top). A rolling day rather than a calendar one, so a bot whose owner sets one post a day doesn't
 * publish at 23:55 and again at 00:05.
 */
export const countPostsPublished = async (botId, since) =>
  BotActionLog.countDocuments({
    bot: botId,
    action: "create_post",
    outcome: "executed",
    createdAt: { $gte: since },
  });

/**
 * Is this bot behind on its own posting quota?
 *
 * Exported separately from `cycleBudget` because it answers a different question: that one asks
 * whether a cycle is *permitted*, this asks whether one is *warranted* with nothing in the feed.
 *
 * @returns {Promise<{owed: boolean, publishedToday: number, quota: number}>}
 */
export const postingQuota = async (botId, postsPerDay) => {
  const quota = Number.isFinite(postsPerDay) ? Math.max(0, postsPerDay) : 0;
  // Zero means "never posts", and then there is nothing to count.
  if (quota === 0) return { owed: false, publishedToday: 0, quota };

  const publishedToday = await countPostsPublished(botId, new Date(Date.now() - DAY_MS));
  return { owed: publishedToday < quota, publishedToday, quota };
};

/**
 * May this bot run a cycle right now, and how much may it do if so?
 *
 * The one call the runner makes before spending anything. Checked in cost order: the kill
 * switch and the hourly decision cap come first because they stop the call itself, and the
 * daily action cap comes last because it shapes the cycle rather than preventing it.
 *
 * @returns {Promise<{ok: boolean, reason: string, limits: object, decisionsUsed: number,
 *   actionsUsedToday: number, remainingActions: number}>}
 */
export const cycleBudget = async (botId) => {
  const limits = resolveBotLimits(await getSettings());

  const deny = (reason) => ({
    ok: false,
    reason,
    limits,
    decisionsUsed: 0,
    actionsUsedToday: 0,
    remainingActions: 0,
  });

  /*
   * The platform kill switch. Ahead of every query because the point of it is to stop bot
   * activity immediately and cheaply, including when the reason it needs stopping is load.
   *
   * Per-bot pausing is not here: the runner only ever selects personas with
   * `status: "active"`, so a paused bot is never a candidate. One place, not two.
   */
  if (!limits.enabled) return deny("bot activity is disabled platform-wide");

  const now = Date.now();
  const [decisionsUsed, actionsUsedToday] = await Promise.all([
    countDecisions(botId, new Date(now - HOUR_MS)),
    countExecutedActions(botId, new Date(now - DAY_MS)),
  ]);

  if (decisionsUsed >= limits.decisionsPerHour) {
    return { ...deny("hourly decision cap reached"), decisionsUsed, actionsUsedToday };
  }

  const remainingActions = Math.max(0, limits.actionsPerDay - actionsUsedToday);
  if (remainingActions === 0) {
    return { ...deny("daily action cap reached"), decisionsUsed, actionsUsedToday };
  }

  return {
    ok: true,
    reason: "",
    limits,
    decisionsUsed,
    actionsUsedToday,
    remainingActions,
  };
};

/**
 * May this bot send a direct message right now?
 *
 * Separate from `cycleBudget` because the DM responder is triggered by someone sending a
 * message rather than by the schedule, so it has its own entry point — and because a bot that
 * has exhausted its DM budget should still be able to like and post, which a single combined
 * gate would prevent.
 *
 * @returns {Promise<{ok: boolean, reason: string, used: number, limit: number}>}
 */
export const dmReplyBudget = async (botId) => {
  const limits = resolveBotLimits(await getSettings());
  if (!limits.enabled) {
    return { ok: false, reason: "bot activity is disabled platform-wide", used: 0, limit: 0 };
  }

  const used = await countDmReplies(botId, new Date(Date.now() - HOUR_MS));
  if (used >= limits.dmRepliesPerHour) {
    return {
      ok: false,
      reason: "hourly direct message cap reached",
      used,
      limit: limits.dmRepliesPerHour,
    };
  }

  return { ok: true, reason: "", used, limit: limits.dmRepliesPerHour };
};
