import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * The loop that makes bots act on their own.
 *
 * Everything the runner touches is mocked, and what is under test is the *order and the
 * consequences* of its decisions — which is where the money and the trust are. Three of them are
 * one-way doors:
 *
 *   · Claiming a bot that another instance is already running means the owner pays twice for one
 *     cycle's worth of visible activity.
 *   · Reading a transient failure as a dead key pauses a working bot and tells its owner their
 *     credential failed.
 *   · Spending an inference call before checking whether there is anything to react to charges an
 *     owner to be told `do_nothing`.
 *
 * The runner is driven through its real entry point rather than by exporting `runCycle` for the
 * test. That way the maintenance gate, the kill switch, the claim query and the batch loop are all
 * exercised as they actually run.
 */

process.env.BOTS_ENABLED = "true";

const FAILURE_KINDS = {
  KEY_INVALID: "key_invalid",
  TRANSIENT: "transient",
  CONFIG: "config",
  BAD_REQUEST: "bad_request",
};

const oid = () => String(new mongoose.Types.ObjectId());

const PERSONA_ID = oid();
const BOT_ID = oid();
const OWNER_ID = oid();
const KEY_ID = oid();

/** Every ordered thing that happened, so a test can assert what came before what. */
let trace = [];

let settings = {};
let personaToClaim = null;
let botDoc = null;
let keyRecord = null;
let budget = null;
let perceptionResult = null;
let anythingToDo = true;
let decideResult = null;
let postingQuotaResult = null;
/** Action types whose own daily cap is spent. See `SENSITIVE_ACTION_LIMITS`. */
let spentSensitive = [];
/** What the (mocked) pacing gate says about posting this cycle. Allowed by default. */
let postingWindowResult = { allowed: true, reason: "" };
/** What the runner actually sent to the model, so the quota's presence in it can be asserted. */
let decideArgs = null;
let staleClaims = [];

let personaUpdates = [];
let apiKeyUpdates = [];
let notifications = [];
let logged = [];
let executed = [];
let validateArgs = null;
/** Read-watermark advances, so a test can assert what the cycle marked seen and when. */
let markedSeen = [];
let decideAt = null;

const log = (name, payload) => {
  trace.push(name);
  return payload;
};

/** A Mongoose-ish chainable that resolves to `value`. */
const chain = (value) => {
  const self = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    populate: () => self,
    lean: async () => value,
  };
  return self;
};

mock.module("../models/BotPersona.js", {
  defaultExport: {
    findOneAndUpdate: (filter) => {
      trace.push("claim");
      // The claim query itself is asserted, because its filter is the exactly-once guarantee.
      validateArgs = validateArgs ?? null;
      claimFilter = filter;
      const claimed = personaToClaim;
      personaToClaim = null;
      return chain(claimed);
    },
    updateOne: async (filter, update) => {
      trace.push("persona.updateOne");
      personaUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
    find: () => chain(staleClaims),
  },
  namedExports: { ALLOWED_MODELS: [], BOT_STATUSES: [] },
});

let claimFilter = null;

mock.module("../models/User.js", {
  defaultExport: { findById: () => chain(botDoc) },
});

mock.module("../models/ApiKey.js", {
  defaultExport: {
    findOne: () => {
      trace.push("loadKey");
      return chain(keyRecord);
    },
    updateOne: async (filter, update) => {
      apiKeyUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
  },
});

mock.module("../utils/keyVault.js", {
  namedExports: {
    decryptSecret: (envelope) => {
      if (envelope === "corrupt") throw new Error("bad envelope");
      return "sk-ant-decrypted";
    },
    redact: (text) => String(text),
  },
});

mock.module("../utils/notifications.js", {
  namedExports: {
    sendNotification: async (recipient, sender, type) => {
      notifications.push({ recipient, sender, type });
    },
  },
});

mock.module("../utils/settings.js", {
  namedExports: { getSettings: async () => settings, invalidateSettingsCache: () => {} },
});

mock.module("../bots/rateLimits.js", {
  namedExports: {
    cycleBudget: async () => log("budget", budget),
    // Whether the bot still owes posts today. The default is "up to date", so every existing test
    // below keeps exercising the reactive path it was written for.
    postingQuota: async () => log("quota", postingQuotaResult),
    /*
     * The per-type daily caps — report, mute, block. Nothing spent by default: those limits
     * have their own tests, and every case in this file is about the cycle around them.
     * `remaining` is what the executor decrements; `spentTypes` is what the validator refuses
     * up front.
     */
    sensitiveActionBudget: async () =>
      log("sensitiveCaps", {
        remaining: new Map([
          ["report_content", 5],
          ["mute_user", 10],
          ["block_user", 3],
        ]),
        spentTypes: new Set(spentSensitive),
      }),
    COUNTED_ACTIONS: [],
  },
});

mock.module("../bots/perception.js", {
  namedExports: {
    buildPerception: async () => log("perception", perceptionResult),
    hasAnythingToDo: () => anythingToDo,
    markConversationsSeen: async (botId, conversations, at) => {
      log("markSeen");
      markedSeen.push({ botId: String(botId), conversations, at });
    },
  },
});

mock.module("../bots/memory.js", {
  namedExports: { loadMemories: async () => ({ self: "", bySubject: new Map() }) },
});

mock.module("../bots/reasoningClient.js", {
  namedExports: {
    FAILURE_KINDS,
    decide: async (args) => {
      decideArgs = args;
      // When the model was called, so a test can prove the read watermark predates it.
      decideAt = new Date();
      return log("decide", decideResult);
    },
    serviceHealthy: async () => true,
  },
});

mock.module("../bots/actionValidator.js", {
  namedExports: {
    validateDecision: (decision, context) => {
      trace.push("validate");
      validateArgs = { decision, context };
      return { actions: [{ type: "like_post" }], rejected: [{ type: "send_dm", reason: "no" }] };
    },
  },
});

mock.module("../bots/executor.js", {
  namedExports: {
    executeActions: async (actions, context) => {
      trace.push("execute");
      executed.push({ actions, context });
      return { executed: actions.length, rejected: 0, failed: 0 };
    },
    logAction: async (row) => {
      trace.push(`log:${row.action}`);
      logged.push(row);
    },
  },
});

/*
 * Pacing is real except for one function.
 *
 * `shouldPostThisCycle` is deliberately probabilistic — that is how the day's posts get spread
 * out instead of arriving in a block — which makes it the one thing in the runner's path that
 * cannot be asserted on. Left real, every test that touches the posting quota would pass or
 * fail depending on the hour the suite happened to run at, which is the worst kind of flake.
 *
 * So the real module is loaded first and only that function is replaced. `isAwake`, `hourIn`
 * and the jitter stay genuine, because the waking-window tests below are about that code.
 * The distribution itself is tested directly in test/botPacing.test.js.
 */
const realPacing = await import("../bots/pacing.js");
mock.module("../bots/pacing.js", {
  namedExports: {
    ...realPacing,
    shouldPostThisCycle: () => log("postingWindow", postingWindowResult),
  },
});

const { startBotRunner, stopBotRunner } = await import("../bots/runner.js");

const { hourIn, isAwake } = realPacing;

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/** Midday everywhere that matters, so `isAwake` is true under the default window. */
const AWAKE_HOURS = { startHour: 0, endHour: 23, timezone: "UTC" };

const reset = () => {
  trace = [];
  settings = {};
  claimFilter = null;
  personaUpdates = [];
  apiKeyUpdates = [];
  notifications = [];
  logged = [];
  executed = [];
  markedSeen = [];
  decideAt = null;
  validateArgs = null;
  staleClaims = [];
  anythingToDo = true;
  decideArgs = null;
  // Up to date on posting, so an empty perception still means "nothing to do" unless a test says
  // otherwise. `publishedToday` matches the quota for the same reason.
  postingQuotaResult = { owed: false, publishedToday: 1, quota: 1 };
  spentSensitive = [];
  postingWindowResult = { allowed: true, reason: "" };

  personaToClaim = {
    _id: PERSONA_ID,
    bot: BOT_ID,
    systemPrompt: "You are Mira.",
    model: "claude-sonnet-5",
    activeHours: AWAKE_HOURS,
    consecutiveFailures: 0,
  };
  botDoc = {
    _id: BOT_ID,
    owner: OWNER_ID,
    username: "mira",
    isBot: true,
    accountStatus: "active",
    apiKey: KEY_ID,
  };
  keyRecord = { _id: KEY_ID, encryptedKey: "envelope", isValid: true, revokedAt: null };
  budget = { ok: true, reason: "", remainingActions: 5, limits: {} };
  perceptionResult = {
    perception: { feed_posts: [{ id: oid() }] },
    allowedTargets: { posts: new Map(), users: new Map(), conversations: new Map() },
    dropped: [],
  };
  decideResult = { ok: true, decision: { actions: [{ type: "like_post" }], usage: { input_tokens: 900 } } };
};

/**
 * Bounded by iterations rather than by wall time, deliberately: several tests move the clock, and
 * a `Date.now()`-based deadline under a frozen clock is an infinite loop rather than a failure.
 */
const waitFor = async (predicate, turns = 2000) => {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
};

/**
 * Run exactly one tick through the real entry point.
 *
 * `startBotRunner` fires a tick without awaiting it, so the test waits for the cycle to reach a
 * terminal write — a release or a pause — rather than guessing at a delay.
 */
const runOneTick = async () => {
  await startBotRunner();
  await waitFor(() => personaUpdates.length > 0 || trace.includes("claim"));
  await waitFor(() => personaUpdates.length > 0);
  stopBotRunner();
  // Let anything already queued behind the write settle before assertions.
  await new Promise((resolve) => setImmediate(resolve));
};

/* ── The waking window ────────────────────────────────────────────────────── */

test("the hour comes from Intl, and a nonsense timezone falls back rather than throwing", () => {
  const at = new Date("2026-08-05T12:00:00Z");
  assert.equal(hourIn("UTC", at), 12);
  assert.equal(hourIn("Asia/Kolkata", at), 17, "UTC+5:30");
  // A typo'd timezone should be a bot on the wrong schedule, not a dead poller.
  assert.equal(hourIn("Not/AZone", at), 12);
  assert.equal(hourIn(undefined, at), 12);
});

test("an overnight window is a real window, not an empty one", () => {
  /*
   * `startHour: 22, endHour: 6` is an ordinary night-owl persona. The naive `start <= h <= end`
   * comparison makes such a bot never run at all, and the symptom — a bot that is simply always
   * silent — looks like a broken runner rather than a broken comparison.
   */
  const overnight = { startHour: 22, endHour: 6, timezone: "UTC" };
  assert.equal(isAwake(overnight, new Date("2026-08-05T23:00:00Z")), true);
  assert.equal(isAwake(overnight, new Date("2026-08-05T03:00:00Z")), true);
  assert.equal(isAwake(overnight, new Date("2026-08-05T06:00:00Z")), true, "the end hour is inclusive");
  assert.equal(isAwake(overnight, new Date("2026-08-05T12:00:00Z")), false);
});

test("a daytime window includes both ends", () => {
  const day = { startHour: 8, endHour: 23, timezone: "UTC" };
  assert.equal(isAwake(day, new Date("2026-08-05T08:00:00Z")), true);
  assert.equal(isAwake(day, new Date("2026-08-05T23:30:00Z")), true, "23 means until 23:59");
  assert.equal(isAwake(day, new Date("2026-08-05T07:59:00Z")), false);
  assert.equal(isAwake(day, new Date("2026-08-06T02:00:00Z")), false);
});

test("a one-hour window is one hour, and a missing window is always awake", () => {
  assert.equal(isAwake({ startHour: 9, endHour: 9, timezone: "UTC" }, new Date("2026-08-05T09:30:00Z")), true);
  assert.equal(isAwake({ startHour: 9, endHour: 9, timezone: "UTC" }, new Date("2026-08-05T10:30:00Z")), false);
  assert.equal(isAwake(undefined, new Date("2026-08-05T04:00:00Z")), true);
});

/* ── The claim ────────────────────────────────────────────────────────────── */

test("THE CLAIM: only an active, due, unclaimed bot can be picked up", async () => {
  /*
   * The exactly-once guarantee, and it lives entirely in this filter. Without `claimedAt: null`
   * two instances would run the same cycle: two inference calls on one key, and every action
   * taken twice.
   */
  reset();
  await runOneTick();

  assert.equal(claimFilter.status, "active");
  /*
   * `strictEqual` plus a presence check, and both are necessary. `assert.equal` is loose, so
   * `undefined == null` passes — the first version of this test went green with the
   * `claimedAt: null` clause deleted from the query, which is the exact regression it exists to
   * catch. Mutation testing is what found it.
   */
  assert.ok("claimedAt" in claimFilter, "the claim query must exclude already-claimed bots");
  assert.strictEqual(claimFilter.claimedAt, null);
  assert.ok(claimFilter.nextRunAt.$lte instanceof Date);
});

test("a claim is always released, and the next run is in the future", async () => {
  reset();
  await runOneTick();

  const release = personaUpdates.at(-1).update.$set;
  assert.strictEqual(release.claimedAt, null, "a held claim silences a bot for as long as it is held");
  assert.ok(release.nextRunAt.getTime() > Date.now());
  assert.equal(release.consecutiveFailures, 0, "a working cycle clears the failure count");
});

test("neither switch lets a cycle start", async () => {
  for (const blocked of [{ maintenanceMode: true }, { botsEnabled: false }]) {
    reset();
    settings = blocked;
    await startBotRunner();
    await new Promise((resolve) => setImmediate(resolve));
    stopBotRunner();
    assert.ok(!trace.includes("claim"), `${JSON.stringify(blocked)} must not even claim a bot`);
  }
});

/* ── The order of the gates ───────────────────────────────────────────────── */

test("THE ORDER: everything free happens before anything that costs money", async () => {
  reset();
  await runOneTick();

  const steps = ["claim", "budget", "loadKey", "perception", "decide", "validate", "execute"];
  const order = trace.filter((step) => steps.includes(step));

  /*
   * Truncated at `execute`, because the batch loop claims once more afterwards to find out whether
   * anything else is due — a trailing "claim" is the loop working, not the order being wrong.
   */
  assert.deepEqual(order.slice(0, steps.length), steps);
});

test("a sleeping bot costs one Intl call and nothing else", async () => {
  reset();
  /*
   * A two-hour window starting two hours from now, so the bot is asleep whenever the suite runs.
   * Cleaner than faking the clock: `isAwake` calls `new Date()`, which a `Date.now` stub does not
   * affect — a trap worth recording, since the first version of this test passed for the wrong
   * reason until the assertion caught it.
   */
  const hour = new Date().getUTCHours();
  personaToClaim.activeHours = { startHour: (hour + 2) % 24, endHour: (hour + 3) % 24, timezone: "UTC" };

  await runOneTick();

  assert.ok(!trace.includes("budget"), "no budget query for a bot that is asleep");
  /*
   * And no log row. A bot asleep for nine hours would otherwise write twenty-seven skip rows a
   * night, for every bot, forever — burying the rows that mean something.
   */
  assert.equal(logged.length, 0);
});

test("a suspended account is skipped, not paused — suspensions get lifted", async () => {
  reset();
  botDoc.accountStatus = "suspended";
  await runOneTick();

  assert.equal(logged[0].action, "cycle_skipped");
  assert.match(logged[0].reason, /suspended/);
  assert.equal(personaUpdates.at(-1).update.$set.status, undefined, "the status is untouched");
});

test("an exhausted budget stops the cycle before the key is even loaded", async () => {
  reset();
  budget = { ok: false, reason: "daily action cap reached", remainingActions: 0, limits: {} };
  await runOneTick();

  assert.ok(!trace.includes("loadKey"));
  assert.equal(logged[0].action, "cycle_skipped");
  assert.match(logged[0].reason, /daily action cap/);
});

test("an empty perception never reaches the model, once today's posts are done", async () => {
  /*
   * The cheapest saving in the feature. An empty feed and a quiet inbox is nothing to decide
   * about, and asking anyway costs the owner money to be told `do_nothing`.
   *
   * Conditional on the posting quota being met, which is the half that was missing — see below.
   */
  reset();
  anythingToDo = false;
  await runOneTick();

  assert.ok(!trace.includes("decide"));
  assert.equal(logged[0].action, "do_nothing");
  assert.equal(logged[0].outcome, "executed");
  /*
   * The reason has to lead with what was actually empty.
   *
   * It used to lead with the quota — "nothing to react to, and today's 5 posts already
   * published" — and an owner read that as the cause and went looking at their posting
   * settings for a bug that was in the feed query. The quota is a footnote: this branch needs
   * both halves and the quota is never the blocker on its own.
   */
  assert.match(logged[0].reason, /nothing in the feed/);
  assert.match(logged[0].reason, /already published/);
});

test("THE POINT: a bot behind on its posting quota thinks anyway", async () => {
  /*
   * The deadlock this fixes, seen in production on the first bot anyone made.
   *
   * A new bot follows nobody, so its feed is empty; nobody follows it, so it has no notifications.
   * The branch above was therefore taken every cycle for ever, at zero cost — and the bot could not
   * escape, because `follow_user` may only target accounts drawn from the perception and there was
   * nothing in it. Every local rule correct, and the account never did anything at all.
   *
   * `postsPerDay` is the way out, and it was wired to nothing: stored, editable, sent to the API,
   * read by no code. Posting is not reactive, so a bot behind on its quota has a reason to think
   * with an empty feed — and then it posts, people find it, and there is a feed.
   */
  reset();
  anythingToDo = false;
  postingQuotaResult = { owed: true, publishedToday: 0, quota: 2 };
  await runOneTick();

  assert.ok(trace.includes("decide"), "an empty feed must not stop a bot that owes posts");

  /*
   * And the model is told why it was woken. Without this the cycle is a paid `do_nothing`: shown an
   * empty feed and no explanation, the correct answer is to do nothing.
   */
  assert.equal(decideArgs.perception.posts_remaining_today, 2);
});

test("the quota is checked before the model, not after", async () => {
  // Order matters for the same reason every other check is ordered: everything free happens before
  // anything that costs money.
  reset();
  anythingToDo = false;
  postingQuotaResult = { owed: true, publishedToday: 0, quota: 1 };
  await runOneTick();

  assert.ok(trace.indexOf("quota") < trace.indexOf("decide"));
});

/* ── Keys ─────────────────────────────────────────────────────────────────── */

test("a key that cannot be used pauses the bot and tells the owner", async () => {
  for (const [record, pattern] of [
    [null, /no longer exists/],
    [{ _id: KEY_ID, revokedAt: new Date(), isValid: true }, /revoked/],
    [{ _id: KEY_ID, revokedAt: null, isValid: false, lastError: "billing stopped" }, /billing stopped/],
    [{ _id: KEY_ID, revokedAt: null, isValid: true, encryptedKey: "corrupt" }, /decrypted/],
  ]) {
    reset();
    keyRecord = record;
    await runOneTick();

    const paused = personaUpdates.at(-1).update.$set;
    assert.equal(paused.status, "paused_key_invalid");
    assert.match(paused.statusReason, pattern);
    assert.strictEqual(paused.claimedAt, null, "a paused bot must not stay claimed");
    // The owner is the only person who can fix it, and the bot is the sender so the row carries
    // its avatar — which is how an owner with several bots sees which one stopped.
    assert.deepEqual(notifications, [{ recipient: OWNER_ID, sender: BOT_ID, type: "bot_paused" }]);
    assert.ok(!trace.includes("perception"), "nothing is built for a bot that cannot think");
  }
});

test("a bot with no key assigned pauses rather than looping", async () => {
  reset();
  botDoc.apiKey = null;
  await runOneTick();
  assert.match(personaUpdates.at(-1).update.$set.statusReason, /no API key/);
});

/* ── Failure classification ───────────────────────────────────────────────── */

test("a dead key pauses the bot and marks the key invalid", async () => {
  reset();
  decideResult = { ok: false, kind: FAILURE_KINDS.KEY_INVALID, error: "Your credit balance is too low" };
  await runOneTick();

  assert.equal(apiKeyUpdates[0].update.$set.isValid, false);
  assert.match(apiKeyUpdates[0].update.$set.lastError, /credit balance/);
  assert.equal(personaUpdates.at(-1).update.$set.status, "paused_key_invalid");
  assert.equal(notifications.length, 1);
});

test("THE POINT: a retired model pauses the bot without blaming the key", async () => {
  /*
   * The gap a live Gemini run found. Both neighbouring treatments are wrong here:
   *
   *   · transient — retries a model that no longer exists every twenty minutes for ever, with the
   *     bot still reading "Active" and nothing said to the owner. Which is what it used to do.
   *   · key_invalid — marks a working credential dead and sends the owner to regenerate it, over a
   *     model *they* can change in ten seconds.
   *
   * So: paused, notified, reason names the model, key untouched. And `paused_model_invalid` is
   * owner-resumable, unlike `paused_key_invalid`, because the owner really can fix this one.
   */
  reset();
  decideResult = {
    ok: false,
    kind: FAILURE_KINDS.MODEL_INVALID,
    error: "provider_model_not_found",
  };
  await runOneTick();

  const paused = personaUpdates.at(-1).update.$set;
  assert.equal(paused.status, "paused_model_invalid");
  // The reason has to name the model, or the owner is told to fix something unspecified.
  assert.match(paused.statusReason, /claude-sonnet-5/);
  assert.equal(apiKeyUpdates.length, 0, "a working key must not be marked invalid");
  assert.equal(notifications.length, 1, "the owner is the only person who can fix this");
});

test("THE IMPORTANT ONE: a transient failure backs off and pauses nothing", async () => {
  /*
   * The provider was rate limiting, or the service was restarting. Pausing here would take a bot
   * offline over something that fixed itself in thirty seconds, and would tell its owner their key
   * had failed when it hadn't.
   */
  reset();
  decideResult = { ok: false, kind: FAILURE_KINDS.TRANSIENT, error: "the provider is unavailable (503)" };
  await runOneTick();

  const release = personaUpdates.at(-1).update.$set;
  assert.equal(release.status, undefined, "the bot stays active");
  assert.equal(release.consecutiveFailures, 1);
  assert.equal(apiKeyUpdates.length, 0, "a working key must not be marked invalid");
  assert.equal(notifications.length, 0, "no false alarm to the owner");
  assert.equal(logged[0].action, "cycle_failed");
});

test("our own bad request is never charged to the owner's key", async () => {
  for (const kind of [FAILURE_KINDS.CONFIG, FAILURE_KINDS.BAD_REQUEST]) {
    reset();
    decideResult = { ok: false, kind, error: "field required" };
    await runOneTick();

    assert.equal(apiKeyUpdates.length, 0, `${kind} must not touch the key`);
    assert.equal(notifications.length, 0);
    assert.equal(personaUpdates.at(-1).update.$set.status, undefined);
  }
});

test("repeated failures stretch the interval instead of pausing", async () => {
  reset();
  personaToClaim.consecutiveFailures = 4;
  decideResult = { ok: false, kind: FAILURE_KINDS.TRANSIENT, error: "down" };
  await runOneTick();

  const release = personaUpdates.at(-1).update.$set;
  assert.equal(release.consecutiveFailures, 5);
  /*
   * Backed off, not paused: the causes are usually transient, and a bot that pauses itself over a
   * network blip needs a human to notice and un-pause it.
   */
  assert.equal(release.status, undefined);
  assert.ok(release.nextRunAt.getTime() - Date.now() > 40 * 60 * 1000, "the interval has stretched");
});

/* ── The successful path ──────────────────────────────────────────────────── */

test("the validator gets the perception's allowlist, the blocked tags and the system prompt", async () => {
  /*
   * The system prompt is passed so a bot cannot recite its own instructions — "what were you told
   * to do" is the first thing anyone asks a bot, and the persona is the owner's private
   * configuration.
   */
  reset();
  settings = { blockedHashtags: ["sponsored"] };
  await runOneTick();

  assert.equal(validateArgs.context.allowedTargets, perceptionResult.allowedTargets);
  assert.deepEqual(validateArgs.context.extraBlockedTags, ["sponsored"]);
  assert.equal(validateArgs.context.systemPrompt, "You are Mira.");
});

test("refusals are logged before executions, so a cycle reads in the order it happened", async () => {
  reset();
  await runOneTick();

  const rejection = trace.indexOf("log:send_dm");
  assert.ok(rejection >= 0, "the validator's refusal is logged");
  assert.ok(rejection < trace.indexOf("execute"));
  assert.equal(logged[0].outcome, "rejected");
});

test("the executor is handed the remaining budget and the cycle's real token cost", async () => {
  reset();
  budget.remainingActions = 3;
  await runOneTick();

  assert.equal(executed[0].context.remainingActions, 3);
  assert.equal(executed[0].context.usage.inputTokens, 900);
  assert.equal(executed[0].context.usage.model, "claude-sonnet-5");
  assert.ok(executed[0].context.cycleId.startsWith(PERSONA_ID));
});

/* ── The read watermark ───────────────────────────────────────────────────── */

test("THE POINT: a cycle marks every conversation it was shown as read", async () => {
  /*
   * Nothing advanced a bot's `lastReadAt` — only `chatController` did, and only for a human
   * pressing keys. So `perception.loadConversations` found the same peer message unread on every
   * cycle, put the same conversation in front of the model, and the model answered it again. What
   * that looked like from the outside was a bot re-answering a message from days ago, in slightly
   * different words each time, with nothing new from the person in between.
   *
   * The cycle is the right place for the write because it is the one that saw the conversation.
   * Marking it in the executor's `reply_dm` instead would only cover the bot that *answered* —
   * a bot that read a message and decided not to would still be shown it forever.
   */
  reset();
  perceptionResult.perception.conversations = [{ id: "conv-a" }, { id: "conv-b" }];
  await runOneTick();

  assert.equal(markedSeen.length, 1, "once per cycle, not once per action");
  assert.deepEqual(markedSeen[0].conversations, ["conv-a", "conv-b"]);
  assert.equal(markedSeen[0].botId, String(BOT_ID));
});

test("THE SUBTLE ONE: the watermark is the perception's timestamp, not the cycle's", async () => {
  /*
   * A model call takes seconds, and a message that arrives during it was never in the perception.
   * Stamping the watermark with `new Date()` at the end of the cycle would mark that message read
   * without the bot ever having seen it — the person's follow-up silently ignored, which is a worse
   * bug than the repetition being fixed. So the timestamp is taken before the snapshot.
   */
  reset();
  perceptionResult.perception.conversations = [{ id: "conv-a" }];
  await runOneTick();

  const { at } = markedSeen[0];
  assert.ok(at instanceof Date);
  assert.ok(decideAt, "sanity: the model really was called in this cycle");
  assert.ok(at <= decideAt, "the watermark predates the model call, so a message during it stays unread");
});

test("a cycle with no conversations marks nothing", async () => {
  reset();
  await runOneTick();

  assert.deepEqual(markedSeen[0]?.conversations ?? [], []);
});

/* ── Reaping ──────────────────────────────────────────────────────────────── */

test("a claim abandoned by a crashed process is returned, but not made instantly due", async () => {
  /*
   * If a particular bot is what killed the process, making it due immediately would take the app
   * down again on the next tick, and again after that.
   */
  reset();
  staleClaims = [{ _id: PERSONA_ID }];
  personaToClaim = null;

  await startBotRunner();
  await waitFor(() => personaUpdates.length > 0);
  stopBotRunner();

  const reap = personaUpdates[0];
  assert.strictEqual(reap.update.$set.claimedAt, null);
  assert.ok(reap.update.$set.nextRunAt.getTime() > Date.now());
  assert.equal(reap.update.$inc.consecutiveFailures, 1);
  // Conditional, so a bot that finished in the meantime isn't yanked out from under itself.
  assert.deepEqual(reap.filter.claimedAt, { $ne: null });
});

/* ── The off switch ───────────────────────────────────────────────────────── */

test("without BOTS_ENABLED the runner does not start at all", async () => {
  reset();
  process.env.BOTS_ENABLED = "false";
  try {
    await startBotRunner();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!trace.includes("claim"));
  } finally {
    process.env.BOTS_ENABLED = "true";
    stopBotRunner();
  }
});
