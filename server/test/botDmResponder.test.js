import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * The fast reply path, and the three behaviours that decide whether it reads as a person.
 *
 * Real timers, because the debounce *is* the feature: three messages in ten seconds must produce
 * one reply, and the only honest way to show that is to let the clock run. The tests wait on
 * observable effects rather than on a fixed delay, so they don't get slower than they have to be.
 *
 * The most valuable assertions here are the negative ones. A bot that replies three times to one
 * thought, or that answers another bot forever, is worse than a bot that says nothing — and both
 * are invisible in a happy-path test.
 */

process.env.BOTS_ENABLED = "true";

const FAILURE_KINDS = {
  KEY_INVALID: "key_invalid",
  TRANSIENT: "transient",
  CONFIG: "config",
  BAD_REQUEST: "bad_request",
};

const oid = () => String(new mongoose.Types.ObjectId());

const BOT_ID = oid();
const OWNER_ID = oid();
const HUMAN_ID = oid();
const KEY_ID = oid();
const CONVERSATION = `${BOT_ID}:${HUMAN_ID}`;

let settings = {};
let users = new Map();
let persona = null;
let keyRecord = null;
let messages = [];
let replyResult = null;
let dmBudget = null;
let validateResult = null;

let replyCalls = [];
let executed = [];
let logged = [];
let typingEvents = [];

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

mock.module("../models/User.js", {
  defaultExport: { findById: (id) => chain(users.get(String(id)) ?? null) },
});

mock.module("../models/BotPersona.js", {
  defaultExport: { findOne: () => chain(persona) },
  namedExports: { ALLOWED_MODELS: [], BOT_STATUSES: [] },
});

mock.module("../models/ApiKey.js", {
  defaultExport: { findOne: () => chain(keyRecord) },
});

mock.module("../models/Message.js", {
  defaultExport: { find: () => chain(messages) },
});

mock.module("../config/socket.js", {
  namedExports: {
    getIO: () => ({
      to: () => ({
        emit: (event, payload) => typingEvents.push({ event, payload }),
      }),
    }),
  },
});

mock.module("../utils/keyVault.js", {
  namedExports: {
    decryptSecret: () => "sk-ant-decrypted",
    redact: (text) => String(text),
  },
});

mock.module("../utils/settings.js", {
  namedExports: { getSettings: async () => settings, invalidateSettingsCache: () => {} },
});

mock.module("../bots/rateLimits.js", {
  namedExports: { dmReplyBudget: async () => dmBudget, COUNTED_ACTIONS: [] },
});

mock.module("../bots/memory.js", {
  namedExports: { loadMemories: async () => ({ self: "", bySubject: new Map() }) },
});

mock.module("../bots/reasoningClient.js", {
  namedExports: {
    FAILURE_KINDS,
    replyToConversation: async (args) => {
      replyCalls.push(args);
      return replyResult;
    },
  },
});

mock.module("../bots/actionValidator.js", {
  namedExports: { validateDecision: () => validateResult },
});

mock.module("../bots/executor.js", {
  namedExports: {
    executeActions: async (actions, context) => {
      executed.push({ actions, context });
      return { executed: actions.length, rejected: 0, failed: 0 };
    },
    logAction: async (row) => logged.push(row),
  },
});

const { onDirectMessage, stopDmResponder } = await import("../bots/dmResponder.js");

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const bot = {
  _id: BOT_ID,
  owner: OWNER_ID,
  username: "mira",
  name: "Mira",
  isBot: true,
  accountStatus: "active",
  apiKey: KEY_ID,
};
const human = { _id: HUMAN_ID, username: "ana", name: "Ana", isBot: false };

const reset = () => {
  settings = { directMessagesEnabled: true, blockedHashtags: [] };
  users = new Map([
    [BOT_ID, { ...bot }],
    [HUMAN_ID, { ...human }],
  ]);
  persona = {
    _id: oid(),
    bot: BOT_ID,
    systemPrompt: "You are Mira.",
    replyModel: "claude-haiku-4-5-20251001",
    status: "active",
  };
  keyRecord = { _id: KEY_ID, encryptedKey: "envelope", isValid: true, revokedAt: null };
  messages = [
    { _id: oid(), sender: HUMAN_ID, content: "are you around?", createdAt: new Date() },
  ];
  dmBudget = { ok: true, reason: "", used: 0, limit: 10 };
  replyResult = { ok: true, decision: { actions: [], usage: { input_tokens: 120 } } };
  validateResult = {
    actions: [{ type: "reply_dm", conversationId: CONVERSATION, text: "yes, just about" }],
    rejected: [],
  };

  replyCalls = [];
  executed = [];
  logged = [];
  typingEvents = [];
};

const waitFor = async (predicate, turns = 40_000) => {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};

/** A message from the human to the bot. */
const incoming = () =>
  onDirectMessage({ conversation: CONVERSATION, senderId: HUMAN_ID, receiverId: BOT_ID });

/**
 * Nothing should happen. Waits long enough for the debounce to have fired, so this is a real
 * assertion rather than a race the test happens to win.
 */
const expectSilence = async () => {
  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.equal(executed.length, 0);
  assert.equal(replyCalls.length, 0);
};

test.after(() => stopDmResponder());

/* ── The debounce ─────────────────────────────────────────────────────────── */

test("THE DEBOUNCE: a burst of messages produces one reply, not three", async () => {
  /*
   * People send "hey", "are you there", "I had a question" as three messages in ten seconds.
   * Answering each is the single most bot-like thing an account can do — and it is also three
   * inference calls where one would do.
   */
  reset();
  incoming();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  incoming();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  incoming();
  const lastMessageAt = Date.now();

  assert.ok(await waitFor(() => replyCalls.length > 0), "a reply should eventually be sent");
  const decidedAt = Date.now();
  assert.ok(await waitFor(() => executed.length > 0));
  // Long enough after the reply for a second or third to have shown up if the clock had restarted.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(replyCalls.length, 1, "one model call for one thought");
  assert.equal(executed.length, 1);

  /*
   * The timing assertion is the one that actually pins the behaviour down, and it took a failed
   * mutation to notice. "One reply for three messages" is *also* true of a naive first-wins rule
   * that answers the first message and drops the rest — a much worse behaviour, since the reply
   * then ignores what the person went on to say. What distinguishes them is *when*: a debounce
   * waits out the last message, so the wait is measured from there.
   */
  assert.ok(
    decidedAt - lastMessageAt > 3000,
    `the reply must wait for the burst to end (waited ${decidedAt - lastMessageAt}ms from the last message)`
  );
});

/* ── Who gets a reply ─────────────────────────────────────────────────────── */

test("a message between two people is not the responder's business", async () => {
  reset();
  users.set(BOT_ID, { ...bot, isBot: false });
  incoming();
  await expectSilence();
});

test("THE LOOP GUARD: bots do not reply to bots", async () => {
  /*
   * Enforced here as well as in the validator, and this is the copy that matters. Two bots
   * messaging each other on the *fast* path would exchange a reply every few seconds, each one
   * costing both owners money, with no end condition and nobody watching.
   */
  reset();
  users.set(HUMAN_ID, { ...human, isBot: true });
  incoming();
  await expectSilence();
});

test("a note to self is not a conversation to answer", async () => {
  reset();
  onDirectMessage({ conversation: CONVERSATION, senderId: BOT_ID, receiverId: BOT_ID });
  await expectSilence();
});

test("a paused bot stays quiet on the fast path too", async () => {
  reset();
  persona.status = "paused_by_owner";
  incoming();
  await expectSilence();
});

test("both platform switches silence replies", async () => {
  for (const blocked of [
    { maintenanceMode: true, directMessagesEnabled: true },
    { botsEnabled: false, directMessagesEnabled: true },
    { directMessagesEnabled: false },
  ]) {
    reset();
    settings = { ...settings, ...blocked };
    incoming();
    await expectSilence();
  }
});

test("an exhausted DM budget is recorded, not silently dropped", async () => {
  reset();
  dmBudget = { ok: false, reason: "hourly direct message cap reached", used: 10, limit: 10 };
  incoming();

  assert.ok(await waitFor(() => logged.length > 0));
  assert.equal(logged[0].action, "cycle_skipped");
  assert.match(logged[0].reason, /direct message cap/);
  assert.equal(executed.length, 0);
});

test("an unusable key is left for the runner to handle", async () => {
  /*
   * The runner owns the pause, the owner notification and the `ApiKey` update. Doing any of that
   * from here would race it — and the message stays unread, so the next cycle handles it properly.
   */
  reset();
  keyRecord = { _id: KEY_ID, encryptedKey: "envelope", isValid: false, revokedAt: null };
  incoming();
  await expectSilence();
});

/* ── The reply itself ─────────────────────────────────────────────────────── */

test("the conversation is shaped with the same untrusted labelling as a cycle", async () => {
  /*
   * A looser shape for replies would make the DM surface the soft spot — and the DM surface is the
   * one an attacker can write to directly, without needing the bot to follow them.
   */
  reset();
  incoming();
  /*
   * Waits for the *whole* reply to finish, not just the model call. Waiting on `replyCalls` alone
   * let this test return while its own chain was still running, and the leftover typing events
   * then landed in the next test's fixtures and broke it — a bleed that looked like a bug in the
   * typing indicator.
   */
  assert.ok(await waitFor(() => executed.length > 0));

  const { conversation } = replyCalls[0];
  assert.equal(conversation.id, CONVERSATION);
  assert.equal(conversation.with.username, "ana");
  assert.ok("untrusted_text" in conversation.recent[0], "the peer's words stay labelled as theirs");
  assert.equal(conversation.recent[0].from_me, false);
  assert.equal(replyCalls[0].persona.replyModel, "claude-haiku-4-5-20251001");
});

test("a typing indicator runs before the reply, then stops", async () => {
  /*
   * An instant reply to a long message is the clearest possible tell, so the pause is computed from
   * the length of what was actually written — which is why it happens after generation, not before.
   */
  reset();
  incoming();
  assert.ok(await waitFor(() => executed.length > 0));

  assert.deepEqual(
    typingEvents.map((entry) => entry.payload.isTyping),
    [true, false]
  );
  assert.equal(typingEvents[0].event, "userTyping");
  assert.equal(typingEvents[0].payload.userId, BOT_ID);
});

test("only a reply is executed, whatever else the model asked for", async () => {
  /*
   * `/reply` asks for a single `reply_dm`, but a model can return anything the schema allows. A DM
   * arriving is not licence to go and like six posts — that is what a cycle is for.
   */
  reset();
  validateResult = {
    actions: [
      { type: "like_post", postId: oid() },
      { type: "reply_dm", conversationId: CONVERSATION, text: "sure" },
      { type: "create_post", text: "unrelated" },
    ],
    rejected: [],
  };
  incoming();
  assert.ok(await waitFor(() => executed.length > 0));

  assert.equal(executed[0].actions.length, 1);
  assert.equal(executed[0].actions[0].type, "reply_dm");
  assert.equal(executed[0].context.remainingActions, 1);
  assert.equal(executed[0].context.usage.model, "claude-haiku-4-5-20251001");
});

test("choosing not to reply is a recorded outcome, not a dropped message", async () => {
  reset();
  validateResult = { actions: [{ type: "do_nothing" }], rejected: [] };
  incoming();

  assert.ok(await waitFor(() => logged.length > 0));
  assert.equal(logged[0].action, "do_nothing");
  assert.equal(logged[0].targetKey ?? logged[0].targetId, CONVERSATION);
  assert.equal(executed.length, 0);
});

test("a transient reply failure is dropped quietly — the runner will pick the message up", async () => {
  /*
   * Best-effort by design. The original message is safely stored and still unread, so the durable
   * path answers it. That relationship is what makes it acceptable for this path to be in-process.
   */
  reset();
  replyResult = { ok: false, kind: FAILURE_KINDS.TRANSIENT, error: "provider unavailable" };
  incoming();

  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.equal(executed.length, 0);
  assert.equal(replyCalls.length, 1, "it did try");
});

test("a malformed event is ignored rather than throwing into the send path", async () => {
  /*
   * `announce` already swallows listener errors, but relying on that means the listener throws on
   * every malformed event and the guard is what hides it. `null` and `undefined` are passed
   * literally here, not substituted for `{}` — the first version of this test quietly did the
   * substitution and so never exercised the case at all.
   */
  reset();
  for (const bad of [{}, { conversation: CONVERSATION }, { senderId: HUMAN_ID }, null, undefined]) {
    assert.doesNotThrow(() => onDirectMessage(bad));
  }
  await expectSilence();
});
