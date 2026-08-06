import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * Carrying out validated actions.
 *
 * Every service is mocked, which is the right level: what matters here is *which* service each
 * action reaches, what it is handed, and what ends up in the audit log — not whether `likePost`
 * works, which its own callers already cover.
 *
 * Two properties get the most attention. One action failing must not discard the ones after it,
 * because a bot that loses a whole cycle to a database hiccup is a bot whose owner paid for
 * nothing. And every attempt must leave exactly one audit row, because a `reply_dm` that isn't in
 * the log is a bot message to a stranger with no record that it happened.
 */

/** Every call every mocked service received, in order. */
const calls = [];
/** Rows written to BotActionLog. */
const rows = [];
/** Per-service canned results, set per test. */
let results = {};
/** Set to a service name to make it throw. */
let throwFrom = null;

const record = (name) => async (args) => {
  calls.push({ name, args });
  if (throwFrom === name) throw new Error("boom");
  return results[name] ?? { ok: true };
};

mock.module("../models/BotActionLog.js", {
  defaultExport: {
    create: async (row) => {
      /*
       * A real cast check, not a stub that accepts anything. `targetId` is an ObjectId field, and
       * the bug this guards against — writing a conversation key into it — was only visible
       * because the model rejects it.
       */
      if (row.targetId != null && !mongoose.isValidObjectId(row.targetId)) {
        throw new mongoose.Error.CastError("ObjectId", row.targetId, "targetId");
      }
      rows.push(row);
      return row;
    },
  },
  namedExports: { BOT_ACTIONS: [], ACTION_OUTCOMES: [] },
});

mock.module("../services/engagement.js", {
  namedExports: {
    likePost: record("likePost"),
    repostPost: record("repostPost"),
    followUser: record("followUser"),
  },
});

mock.module("../services/authoring.js", {
  namedExports: {
    createPost: record("createPost"),
    commentOnPost: record("commentOnPost"),
  },
});

mock.module("../services/directMessage.js", {
  namedExports: { sendDirectMessage: record("sendDirectMessage") },
});

let participants = [];
mock.module("../utils/conversationActivity.js", {
  namedExports: {
    participantsOfConversation: async (key) => {
      calls.push({ name: "participantsOfConversation", args: key });
      return participants;
    },
  },
});

let dmGate = { ok: true };
/*
 * Mocked by the path *this* file would use, not the path the executor uses. `mock.module`
 * resolves the specifier relative to the caller and registers by resolved URL, so `./` here
 * would look for a sibling of the test.
 */
mock.module("../bots/actionValidator.js", {
  namedExports: {
    canBotSendDm: async (botId, targetId) => {
      calls.push({ name: "canBotSendDm", args: { botId, targetId } });
      return dmGate;
    },
  },
});

const { executeActions, logAction } = await import("../bots/executor.js");

const oid = () => String(new mongoose.Types.ObjectId());

const BOT_ID = oid();
const OWNER_ID = oid();
const bot = { _id: BOT_ID, owner: OWNER_ID, username: "mira" };

const reset = () => {
  calls.length = 0;
  rows.length = 0;
  results = {};
  throwFrom = null;
  dmGate = { ok: true };
  participants = [];
};

const run = (actions, extra = {}) =>
  executeActions(actions, { bot, cycleId: "cycle-1", ...extra });

const called = (name) => calls.find((entry) => entry.name === name);

/* ── Routing ──────────────────────────────────────────────────────────────── */

test("each action type reaches the service that already knows how to do it", async () => {
  reset();
  const postId = oid();
  const userId = oid();
  results.likePost = { ok: true, liked: true };
  results.repostPost = { ok: true, reposted: true };

  await run([
    { type: "like_post", postId, targetType: "Post", targetId: postId },
    { type: "repost_post", postId, targetType: "Post", targetId: postId },
    { type: "follow_user", userId, targetType: "User", targetId: userId },
    { type: "comment_post", postId, text: "lovely", targetType: "Post", targetId: postId },
  ]);

  assert.equal(called("likePost").args.postId, postId);
  assert.equal(called("repostPost").args.postId, postId);
  assert.equal(called("followUser").args.targetId, userId);
  assert.equal(called("commentOnPost").args.content, "lovely");
  // Every service is handed the bot as the actor, never the owner.
  for (const entry of calls) {
    if (entry.args?.actorId) assert.equal(entry.args.actorId, BOT_ID);
  }
});

test("follow_user and send_follow_request are one service call, not two behaviours", async () => {
  /*
   * `followUser` decides between an immediate follow and a pending request by reading the target's
   * `isPrivate`. Branching on the model's chosen action type instead would let a model's
   * expectation decide whether a private account gets its approval step.
   */
  reset();
  const userId = oid();
  await run([{ type: "send_follow_request", userId, targetType: "User", targetId: userId }]);
  assert.equal(called("followUser").args.targetId, userId);
});

test("bot-authored content carries the AI disclosure", async () => {
  /*
   * `Post.isAiGenerated` is the platform's own "made with AI" flag. For a bot it is unambiguously
   * true, so it is set here rather than left to an owner's honesty — and it is what someone sees
   * when the post is reposted away from the profile that carries the badge.
   */
  reset();
  const postId = oid();
  await run([
    { type: "create_post", text: "morning", targetType: null, targetId: null },
    { type: "quote_post", postId, text: "this", targetType: "Post", targetId: postId },
    { type: "comment_post", postId, text: "nice", targetType: "Post", targetId: postId },
  ]);

  const authored = calls.filter((entry) => entry.name === "createPost" || entry.name === "commentOnPost");
  assert.equal(authored.length, 3);
  for (const entry of authored) assert.equal(entry.args.isAiGenerated, true);

  // A quote is a post with a quoted target, which is how the service models it.
  assert.equal(calls.find((c) => c.args?.quotedPost)?.args.quotedPost, postId);
});

test("reads take no service call but are still recorded", async () => {
  reset();
  const userId = oid();
  const counts = await run([
    { type: "view_profile", userId, targetType: "User", targetId: userId },
    { type: "scroll_feed" },
    { type: "do_nothing" },
  ]);

  assert.equal(calls.length, 0, "looking writes nothing");
  assert.equal(counts.executed, 3);
  // "The bot looked at your profile" is an answer to "what did this account do".
  assert.equal(rows.length, 3);
});

/* ── Direct messages ──────────────────────────────────────────────────────── */

test("an unsolicited DM is gated again at execution time", async () => {
  reset();
  const userId = oid();
  dmGate = { ok: false, reason: "recipient does not follow this bot" };

  const counts = await run([{ type: "send_dm", userId, text: "hello", targetType: "User", targetId: userId }]);

  assert.equal(counts.rejected, 1);
  assert.equal(called("sendDirectMessage"), undefined, "the gate runs before the send");
  assert.match(rows[0].reason, /does not follow/);
});

test("a reply resolves the conversation to a person, through the app's one key reader", async () => {
  reset();
  const peerId = oid();
  participants = [BOT_ID, peerId];

  await run([
    { type: "reply_dm", conversationId: "a:b", text: "hi", targetType: "Conversation", targetId: "a:b" },
  ]);

  assert.equal(called("participantsOfConversation").args, "a:b");
  assert.equal(String(called("sendDirectMessage").args.receiverId), peerId);
  assert.equal(called("sendDirectMessage").args.senderId, BOT_ID);
  // A bot is an ordinary account: the maintenance and feature-flag gate applies to it.
  assert.equal(called("sendDirectMessage").args.actorRole, "user");
});

test("a conversation that is no longer two people is refused, not guessed at", async () => {
  reset();
  // A group, or a chat someone left. `sendDirectMessage` applies none of a group's send gates.
  participants = [BOT_ID, oid(), oid()];

  const counts = await run([
    { type: "reply_dm", conversationId: "g:123", text: "hi", targetType: "Conversation", targetId: "g:123" },
  ]);
  assert.equal(counts.rejected, 1);
  assert.equal(called("sendDirectMessage"), undefined);
});

test("REGRESSION: a conversation key is logged as a key, not cast to an ObjectId", async () => {
  /*
   * A DM conversation is a derived key — two ids, or `g:<id>` — not a document. Writing it into the
   * ObjectId `targetId` throws a cast error, and because log failures are deliberately swallowed
   * the symptom would be `reply_dm` rows silently absent from the audit trail. That is the worst
   * row to lose: a bot's messages to strangers are exactly what gets asked about later.
   */
  reset();
  participants = [BOT_ID, oid()];

  await run([
    { type: "reply_dm", conversationId: "a:b", text: "hi", targetType: "Conversation", targetId: "a:b" },
  ]);

  assert.equal(rows.length, 1, "the row must survive");
  assert.equal(rows[0].targetKey, "a:b");
  assert.strictEqual(rows[0].targetId, null);
});

/* ── Outcomes ─────────────────────────────────────────────────────────────── */

test("a service saying no is a rejection; a thrown error is a failure", async () => {
  reset();
  const postId = oid();
  results.likePost = { ok: false, status: 403, error: "Unable to like this" };
  throwFrom = "commentOnPost";

  const counts = await run([
    { type: "like_post", postId, targetType: "Post", targetId: postId },
    { type: "comment_post", postId, text: "hi", targetType: "Post", targetId: postId },
  ]);

  /*
   * The distinction the audit log exists to make: "was this bot stopped, or did it crash?"
   * Collapsing them would make every rejection look like a bug and every bug like a rule.
   */
  assert.equal(counts.rejected, 1);
  assert.equal(counts.failed, 1);
  assert.equal(rows[0].outcome, "rejected");
  assert.equal(rows[0].reason, "Unable to like this");
  assert.equal(rows[1].outcome, "failed");
});

test("one action throwing does not discard the ones after it", async () => {
  reset();
  const postId = oid();
  throwFrom = "likePost";

  const counts = await run([
    { type: "like_post", postId, targetType: "Post", targetId: postId },
    { type: "create_post", text: "still posted" },
  ]);

  assert.equal(counts.failed, 1);
  assert.equal(counts.executed, 1);
  assert.ok(called("createPost"), "the cycle carries on");
});

test("a toggle that went the wrong way is reported rather than passed off as success", async () => {
  /*
   * The validator refuses a like on an `already_liked` post, so `liked: false` here means the state
   * changed between the perception and now and the bot has just *removed* a like. Silence would
   * leave a mystery un-like in someone's notifications with nothing in the log to explain it.
   */
  reset();
  const postId = oid();
  results.likePost = { ok: true, liked: false };
  results.repostPost = { ok: true, reposted: false };

  const counts = await run([
    { type: "like_post", postId, targetType: "Post", targetId: postId },
    { type: "repost_post", postId, targetType: "Post", targetId: postId },
  ]);

  assert.equal(counts.rejected, 2);
  assert.match(rows[0].reason, /undone/);
});

/* ── Budget ───────────────────────────────────────────────────────────────── */

test("the daily cap stops write actions and lets reads through", async () => {
  reset();
  const postId = oid();
  const userId = oid();
  results.likePost = { ok: true, liked: true };

  const counts = await run(
    [
      { type: "like_post", postId, targetType: "Post", targetId: postId },
      { type: "create_post", text: "second write" },
      { type: "view_profile", userId, targetType: "User", targetId: userId },
    ],
    { remainingActions: 1 }
  );

  assert.equal(counts.executed, 2, "one write plus the read");
  assert.equal(counts.rejected, 1);
  assert.equal(called("createPost"), undefined, "the second write never happened");
  assert.match(rows[1].reason, /daily action cap/);
});

/* ── The audit log ────────────────────────────────────────────────────────── */

test("the cycle's token cost rides on exactly one row", async () => {
  /*
   * Per-owner cost reporting sums `usage.inputTokens` across rows, so repeating it on each of six
   * actions would report six times the spend.
   */
  reset();
  const postId = oid();
  results.likePost = { ok: true, liked: true };

  await run(
    [
      { type: "like_post", postId, targetType: "Post", targetId: postId },
      { type: "create_post", text: "hello" },
      { type: "do_nothing" },
    ],
    { usage: { inputTokens: 900, outputTokens: 40, model: "claude-sonnet-5", latencyMs: 1200 } }
  );

  const withUsage = rows.filter((row) => row.usage);
  assert.equal(withUsage.length, 1);
  assert.equal(withUsage[0].usage.inputTokens, 900);
});

test("every row carries the owner, so cost and conduct are attributable", async () => {
  reset();
  await run([{ type: "create_post", text: "hello" }]);
  assert.equal(rows[0].owner, OWNER_ID);
  assert.equal(rows[0].bot, BOT_ID);
  assert.equal(rows[0].cycleId, "cycle-1");
});

test("a failed log write never takes the cycle down with it", async () => {
  /*
   * A cycle that has already spent an owner's money must not be lost because the log write failed.
   * Letting it propagate would also mark a working cycle as a failure and eventually back off a
   * healthy bot.
   */
  reset();
  await assert.doesNotReject(
    logAction({ bot: BOT_ID, owner: OWNER_ID, action: "like_post", targetId: "not-an-object-id" })
  );
});

test("an over-long reason is truncated before it reaches a collection that only grows", async () => {
  reset();
  await logAction({ bot: BOT_ID, owner: OWNER_ID, action: "cycle_failed", reason: "x".repeat(5000) });
  assert.ok(rows[0].reason.length <= 300);
});
