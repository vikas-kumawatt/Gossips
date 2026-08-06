import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * The activity caps, and the kill switch.
 *
 * `BotActionLog` and the settings cache are mocked, which is the point of counting from the
 * audit log rather than from Redis: the queries are ordinary Mongoose calls with no cache
 * state, so what is asserted here is the real control flow rather than a stand-in for it.
 *
 * What gets checked most carefully is the *order* of the checks. The kill switch has to stop a
 * cycle before any query runs, because the situation it exists for is one where the database is
 * part of the problem.
 */

/** Set per test. */
let settings = {};
let distinctResult = [];
let countResults = [];
const queries = [];

mock.module("../utils/settings.js", {
  namedExports: {
    getSettings: async () => settings,
    invalidateSettingsCache: () => {},
  },
});

mock.module("../models/BotActionLog.js", {
  defaultExport: {
    distinct: async (field, query) => {
      queries.push({ op: "distinct", field, query });
      return distinctResult;
    },
    countDocuments: async (query) => {
      queries.push({ op: "count", query });
      return countResults.shift() ?? 0;
    },
  },
  namedExports: {
    BOT_ACTIONS: [],
    ACTION_OUTCOMES: [],
  },
});

const {
  COUNTED_ACTIONS,
  DEFAULT_BOT_LIMITS,
  countDecisions,
  cycleBudget,
  dmReplyBudget,
  resolveBotLimits,
} = await import("../bots/rateLimits.js");

const botId = new mongoose.Types.ObjectId();

const reset = () => {
  settings = {};
  distinctResult = [];
  countResults = [];
  queries.length = 0;
};

/* ── Resolving limits ─────────────────────────────────────────────────────── */

test("a settings document written before these fields existed falls back to the defaults", () => {
  /*
   * The direction of the failure matters. A missing field must not read as zero, or the day
   * these fields ship every existing bot silently stops doing anything and the cause looks like
   * the runner.
   */
  const limits = resolveBotLimits({});
  assert.equal(limits.enabled, true);
  assert.equal(limits.decisionsPerHour, DEFAULT_BOT_LIMITS.decisionsPerHour);
  assert.equal(limits.actionsPerDay, DEFAULT_BOT_LIMITS.actionsPerDay);
  assert.equal(limits.dmRepliesPerHour, DEFAULT_BOT_LIMITS.dmRepliesPerHour);

  assert.equal(resolveBotLimits(null).enabled, true);
  assert.equal(resolveBotLimits(undefined).decisionsPerHour, DEFAULT_BOT_LIMITS.decisionsPerHour);
});

test("nonsense values fall back rather than becoming a cap of zero", () => {
  const limits = resolveBotLimits({
    botMaxDecisionsPerHour: "lots",
    botMaxActionsPerDay: -5,
    botMaxDmRepliesPerHour: Number.NaN,
  });
  assert.equal(limits.decisionsPerHour, DEFAULT_BOT_LIMITS.decisionsPerHour);
  assert.equal(limits.actionsPerDay, DEFAULT_BOT_LIMITS.actionsPerDay);
  assert.equal(limits.dmRepliesPerHour, DEFAULT_BOT_LIMITS.dmRepliesPerHour);
});

test("zero is a real value, and freezes one surface without touching the others", () => {
  const limits = resolveBotLimits({
    botMaxDmRepliesPerHour: 0,
    botMaxActionsPerDay: 30,
  });
  assert.equal(limits.dmRepliesPerHour, 0);
  assert.equal(limits.actionsPerDay, 30);
  assert.equal(limits.decisionsPerHour, DEFAULT_BOT_LIMITS.decisionsPerHour);
});

/* ── The kill switch ──────────────────────────────────────────────────────── */

test("THE KILL SWITCH: bots stop before a single query runs", async () => {
  /*
   * Checked ahead of the counts on purpose. The reason to reach for this switch is that bot
   * activity is causing an incident, and an incident is exactly when the database should not be
   * asked three more questions per bot.
   */
  reset();
  settings = { botsEnabled: false };

  const verdict = await cycleBudget(botId);

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /disabled platform-wide/);
  assert.equal(queries.length, 0, "the switch must not cost a query");
  assert.equal(verdict.remainingActions, 0);
});

test("the kill switch stops direct message replies too", async () => {
  reset();
  settings = { botsEnabled: false };
  const verdict = await dmReplyBudget(botId);
  assert.equal(verdict.ok, false);
  assert.equal(queries.length, 0);
});

/* ── The caps ─────────────────────────────────────────────────────────────── */

test("a bot under every cap may run, and is told how much it may do", async () => {
  reset();
  distinctResult = ["cycle-a", "cycle-b"];
  countResults = [10];

  const verdict = await cycleBudget(botId);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.decisionsUsed, 2);
  assert.equal(verdict.actionsUsedToday, 10);
  assert.equal(verdict.remainingActions, DEFAULT_BOT_LIMITS.actionsPerDay - 10);
});

test("the hourly decision cap stops the inference call", async () => {
  reset();
  settings = { botMaxDecisionsPerHour: 2 };
  distinctResult = ["cycle-a", "cycle-b"];
  countResults = [0];

  const verdict = await cycleBudget(botId);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /hourly decision cap/);
  assert.equal(verdict.decisionsUsed, 2);
});

test("the daily action cap stops the cycle once nothing is left", async () => {
  reset();
  settings = { botMaxActionsPerDay: 10 };
  distinctResult = ["cycle-a"];
  countResults = [10];

  const verdict = await cycleBudget(botId);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /daily action cap/);
});

test("a partly spent day shapes the cycle rather than blocking it", async () => {
  /*
   * The difference between a cap and a cliff. With two actions left the bot still runs — the
   * executor is handed `remainingActions` and stops there — because refusing the whole cycle
   * would waste the decision the owner is about to pay for.
   */
  reset();
  settings = { botMaxActionsPerDay: 10 };
  distinctResult = [];
  countResults = [8];

  const verdict = await cycleBudget(botId);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.remainingActions, 2);
});

test("the DM cap is separate, so a talked-out bot can still post", async () => {
  reset();
  settings = { botMaxDmRepliesPerHour: 3 };
  countResults = [3];

  const spent = await dmReplyBudget(botId);
  assert.equal(spent.ok, false);
  assert.match(spent.reason, /direct message cap/);
  assert.equal(spent.used, 3);

  reset();
  settings = { botMaxDmRepliesPerHour: 3 };
  countResults = [1];
  assert.equal((await dmReplyBudget(botId)).ok, true);
});

/* ── What is counted ──────────────────────────────────────────────────────── */

test("decisions are counted as distinct cycles, ignoring rows with no cycle id", async () => {
  /*
   * One decision is one inference call and any number of action rows, so counting rows would
   * charge a busy cycle five times over. Rows with an empty `cycleId` predate the runner and are
   * not attributable to a call.
   */
  reset();
  distinctResult = ["cycle-a", "cycle-a", "", null, "cycle-b"];

  const used = await countDecisions(botId, new Date(0));
  assert.equal(used, 3, "distinct() dedupes; this only has to drop the empties");
  assert.equal(queries[0].field, "cycleId");
});

test("only visible activity counts against the daily cap", async () => {
  /*
   * Looking is free. Charging a bot for `view_profile` or `scroll_feed` would push it to spend
   * its budget acting rather than observing, which is the opposite of what the cap is for.
   */
  for (const action of ["do_nothing", "scroll_feed", "view_profile", "cycle_skipped", "cycle_failed"]) {
    assert.ok(!COUNTED_ACTIONS.includes(action), `${action} must not count`);
  }
  for (const action of ["like_post", "comment_post", "send_dm", "reply_dm", "create_post"]) {
    assert.ok(COUNTED_ACTIONS.includes(action), `${action} must count`);
  }
});

test("the counts are rolling windows, not clock buckets", async () => {
  /*
   * A fixed hourly bucket lets a bot spend its whole budget at 10:59 and again at 11:01. Every
   * query here is `createdAt: { $gte: <now - window> }`, which cannot be gamed by waiting for a
   * boundary — and it is why the Redis counters this replaced are not missed.
   */
  reset();
  distinctResult = [];
  countResults = [0];
  const before = Date.now();

  await cycleBudget(botId);

  const hourly = queries.find((entry) => entry.op === "distinct");
  const daily = queries.find((entry) => entry.op === "count");

  const hourAgo = hourly.query.createdAt.$gte.getTime();
  const dayAgo = daily.query.createdAt.$gte.getTime();

  assert.ok(Math.abs(before - hourAgo - 3600_000) < 5_000, "the decision window is one hour");
  assert.ok(Math.abs(before - dayAgo - 86_400_000) < 5_000, "the action window is one day");

  // Rejections are not activity: only executed rows count against the daily cap.
  assert.equal(daily.query.outcome, "executed");
});
