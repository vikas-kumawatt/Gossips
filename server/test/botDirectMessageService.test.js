import assert from "node:assert";
import test, { beforeEach, mock } from "node:test";
import mongoose from "mongoose";

/**
 * The DM send path, asserted by the operations it performs.
 *
 * This extraction is the riskiest in the phase: ~200 lines lifted out of the socket handler,
 * every line of which was the fix for something. So the expectations below are the *ordered*
 * sequence of gates, writes, emits and pushes read off the original handler before the move
 * — not off the service.
 *
 * Requires `--experimental-test-module-mocks`.
 */

const oid = () => new mongoose.Types.ObjectId();

let calls = [];
const names = () => calls.map((c) => c.name);
const callTo = (name) => calls.find((c) => c.name === name);
const push = (name, args = []) => calls.push({ name, args });

const query = (result) => {
  const chain = {
    select: () => chain,
    lean: () => Promise.resolve(result),
    then: (r) => Promise.resolve(result).then(r),
  };
  return chain;
};

const SENDER = oid();
const RECEIVER = oid();
const MESSAGE = oid();

let state = {};
const resetState = () => {
  state = {
    settings: { maintenanceMode: false, directMessagesEnabled: true, maintenanceMessage: "" },
    sender: { _id: SENDER, username: "sender", name: "Sender" },
    receiver: { _id: RECEIVER, username: "receiver", name: "Receiver" },
    blocks: false,
    messageable: true,
    ttlSeconds: null,
    muted: false,
    receiverSockets: [{ id: "s1" }],
    payloadError: null,
    saveError: null,
  };
};

/** A stand-in Message document that records what happens to it. */
const makeDoc = (data) => ({
  ...data,
  _id: MESSAGE,
  save: async () => {
    if (state.saveError) throw state.saveError;
    push("message.save", [data]);
  },
  populate: async (paths) => {
    push("message.populate", [paths.map((p) => p.path)]);
  },
  markAsDelivered: async () => push("message.markAsDelivered"),
  toObject: () => ({ ...data, _id: MESSAGE }),
});

mock.module("../models/User.js", {
  defaultExport: {
    findById: (id) => {
      push("User.findById(sender)", [id]);
      return query(state.sender);
    },
    findOne: (filter) => {
      // The receiver lookup — asserted separately because ACTIVE_ACCOUNT must be applied.
      push("User.findOne(receiver)", [filter]);
      return query(state.receiver);
    },
  },
});

/*
 * One mock for `Message`, because the service uses it two ways: `new Message(data)` and the
 * statics `dmConversationKey` / `findOne`. A function serves both — `new` on a function that
 * returns an object yields that object — and `mock.module` refuses a second mock of the same
 * specifier, so this cannot be split.
 */
const MessageMock = function (data) {
  return makeDoc(data);
};
MessageMock.dmConversationKey = (a, b) => {
  push("dmConversationKey", [String(a), String(b)]);
  return [String(a), String(b)].sort().join("_");
};
MessageMock.findOne = (filter) => {
  push("Message.findOne(idempotency)", [filter]);
  return Promise.resolve(state.existingByClientId || null);
};

mock.module("../models/Message.js", { defaultExport: MessageMock, namedExports: {} });

mock.module("../models/UserRelation.js", {
  defaultExport: {
    eitherBlocks: (...a) => {
      push("UserRelation.eitherBlocks", a);
      return Promise.resolve(state.blocks);
    },
  },
});

mock.module("../utils/settings.js", {
  namedExports: {
    getSettings: () => {
      push("getSettings");
      return Promise.resolve(state.settings);
    },
  },
});

mock.module("../utils/messageContent.js", {
  namedExports: {
    parseSendPayload: ({ content, media, messageType }) => {
      push("parseSendPayload", [{ content, media, messageType }]);
      if (state.payloadError) return { error: state.payloadError };
      return { content: content ?? "", media: media ?? [], messageType };
    },
    messageEntities: async () => {
      push("messageEntities");
      return { mentions: [], hashtags: [] };
    },
  },
});

mock.module("../utils/pushNotifications.js", {
  namedExports: {
    sendPushNotification: (...a) => {
      push("sendPushNotification", a);
      return Promise.resolve();
    },
  },
});

mock.module("../utils/chatAccess.js", {
  namedExports: {
    ACTIVE_ACCOUNT: { accountStatus: { $nin: ["deleted", "suspended"] } },
    MAX_TTL_SECONDS: 604800,
    conversationTtlSeconds: async () => {
      push("conversationTtlSeconds");
      return state.ttlSeconds;
    },
    isConversationMuted: async () => {
      push("isConversationMuted");
      return state.muted;
    },
    messageableIdSet: async (_actor, targets) => {
      push("messageableIdSet");
      /*
       * Answers about whoever was asked, rather than about RECEIVER specifically. Hard-coding
       * the id made the note-to-self case fail: the service asks about the *sender*, the set
       * didn't contain them, and the send was refused as "they don't accept messages from
       * you" — a mock artefact that looked exactly like a real permissions bug.
       */
      if (!state.messageable) return new Set();
      return new Set((targets || []).map((t) => String(t)));
    },
    resolveReplyTo: async () => {
      push("resolveReplyTo");
      return null;
    },
  },
});

mock.module("../config/socket.js", {
  namedExports: {
    getIO: () => ({
      in: () => ({ fetchSockets: async () => state.receiverSockets }),
      to: (room) => ({
        emit: (event, payload) => push(`emit:${event}`, [String(room), payload]),
      }),
    }),
  },
});

const { sendDirectMessage } = await import("../services/directMessage.js");

beforeEach(() => {
  calls = [];
  resetState();
});

const send = (over = {}) =>
  sendDirectMessage({
    senderId: SENDER,
    receiverId: RECEIVER,
    content: "hello",
    media: [],
    messageType: "text",
    clientId: "temp-1",
    actorRole: "user",
    ...over,
  });

/* ── The gate order ───────────────────────────────────────────────────────── */

test("THE POINT: the gates run in the handler's original order", async () => {
  const result = await send();
  assert.equal(result.ok, true);

  const gateOrder = names().filter((n) =>
    [
      "getSettings",
      "parseSendPayload",
      "User.findById(sender)",
      "UserRelation.eitherBlocks",
      "messageableIdSet",
      "message.save",
    ].includes(n)
  );

  assert.deepEqual(gateOrder, [
    "getSettings",
    "parseSendPayload",
    "User.findById(sender)",
    "UserRelation.eitherBlocks",
    "messageableIdSet",
    "message.save",
  ]);
});

test("maintenance mode refuses before anything is validated or queried", async () => {
  state.settings = { maintenanceMode: true, maintenanceMessage: "Back soon", directMessagesEnabled: true };

  const result = await send();

  assert.equal(result.ok, false);
  assert.equal(result.error, "Back soon");
  assert.deepEqual(names(), ["getSettings"], "nothing else runs");
});

test("an empty maintenance message can't switch maintenance mode off", async () => {
  // `maintenanceMessage` is admin-editable with no minimum length, and the caller treats a
  // falsy return as "proceed" — so an empty string here used to mean messaging stayed open.
  state.settings = { maintenanceMode: true, maintenanceMessage: "", directMessagesEnabled: true };

  const result = await send();

  assert.equal(result.ok, false);
  assert.match(result.error, /maintenance/i);
});

test("the messaging feature flag refuses, and staff bypass both switches", async () => {
  state.settings = { maintenanceMode: false, directMessagesEnabled: false, maintenanceMessage: "" };
  assert.equal((await send()).ok, false);

  for (const role of ["admin", "super_admin"]) {
    calls = [];
    resetState();
    state.settings = { maintenanceMode: true, directMessagesEnabled: false, maintenanceMessage: "down" };
    const result = await send({ actorRole: role });
    assert.equal(result.ok, true, `${role} must bypass`);
    assert.equal(callTo("getSettings"), undefined, "staff don't even read the settings");
  }
});

test("an unknown role is treated as non-staff, not as a bypass", async () => {
  // Fails closed: a caller that forgets to pass a role gets the stricter behaviour.
  state.settings = { maintenanceMode: true, maintenanceMessage: "down", directMessagesEnabled: true };
  assert.equal((await send({ actorRole: undefined })).ok, false);
});

/* ── Permissions ──────────────────────────────────────────────────────────── */

test("the receiver lookup filters deleted and suspended accounts", async () => {
  /*
   * `/share` always filtered these and this path didn't, so a DM to a deleted account
   * succeeded over the socket and was stored forever.
   */
  await send();
  const filter = callTo("User.findOne(receiver)").args[0];
  assert.ok(filter.accountStatus, "ACTIVE_ACCOUNT must be part of the receiver query");
});

test("a block in either direction refuses before the whoCanMessage check", async () => {
  state.blocks = true;
  const result = await send();

  assert.equal(result.ok, false);
  assert.match(result.error, /blocked/);
  assert.equal(callTo("messageableIdSet"), undefined, "stops at the block");
  assert.equal(callTo("message.save"), undefined);
});

test("whoCanMessage refuses without writing", async () => {
  state.messageable = false;
  const result = await send();

  assert.equal(result.ok, false);
  assert.match(result.error, /don't accept messages/);
  assert.equal(callTo("message.save"), undefined);
});

test("a payload error is returned verbatim and stops the send", async () => {
  state.payloadError = "That message is too long";
  const result = await send();

  assert.equal(result.error, "That message is too long");
  assert.equal(callTo("User.findById(sender)"), undefined, "refused before any lookup");
});

test("no recipient is refused after validation, as it was", async () => {
  const result = await send({ receiverId: null });
  assert.equal(result.error, "No recipient");
  assert.ok(callTo("parseSendPayload"), "payload is still checked first");
});

/* ── Persistence ──────────────────────────────────────────────────────────── */

test("the conversation key is built from the database's id, not the caller's string", async () => {
  /*
   * `dmConversationKey` sorts raw strings, so an uppercase-hex id yields a different key and
   * the message lands in a conversation neither party's thread query will match.
   */
  await send({ receiverId: RECEIVER.toString().toUpperCase() });

  const [, second] = callTo("dmConversationKey").args;
  assert.equal(second, RECEIVER.toString(), "the canonical lowercase id, not what was passed");
});

test("the client id is stored, so a retry is idempotent", async () => {
  await send({ clientId: "temp-42" });
  assert.equal(callTo("message.save").args[0].clientId, "temp-42");
});

test("no client id means no clientId field, rather than an explicit undefined", async () => {
  await send({ clientId: undefined });
  assert.ok(!("clientId" in callTo("message.save").args[0]));
});

test("a duplicate save resolves to the existing row instead of erroring", async () => {
  const existing = { _id: MESSAGE, populate: async () => {}, toObject: () => ({ _id: MESSAGE }), markAsDelivered: async () => {} };
  state.saveError = Object.assign(new Error("dup"), { code: 11000 });
  state.existingByClientId = existing;

  const result = await send({ clientId: "temp-1" });

  assert.equal(result.ok, true, "a retry looks like a slow first attempt");
  assert.ok(callTo("Message.findOne(idempotency)"), "the first attempt is looked up");
});

test("a duplicate with no client id is a real error, not an idempotent retry", async () => {
  state.saveError = Object.assign(new Error("dup"), { code: 11000 });
  await assert.rejects(() => send({ clientId: undefined }));
});

test("THE POINT: a negative TTL cannot shorten a message's life", async () => {
  /*
   * The client used to send `selfDestructTimer` and the server applied it verbatim, so a
   * negative value produced an `expiresAt` in the past and the TTL index deleted the message
   * within the minute — an unsend with no time limit.
   */
  for (const bad of [-60, 0, 1.5, Number.MAX_SAFE_INTEGER, null, undefined, "abc", NaN]) {
    calls = [];
    resetState();
    await send({ isEphemeral: true, selfDestructTimer: bad });
    const saved = callTo("message.save").args[0];
    assert.ok(!saved.expiresAt, `${bad} must not set an expiry`);
    assert.ok(!saved.isEphemeral, `${bad} must not mark the message ephemeral`);
  }
});

test("a numeric string is coerced, matching the original's Number() call", async () => {
  /*
   * `"60"` is valid, and deliberately so: the handler has always done
   * `Number(selfDestructTimer)`, and JSON from a client can carry a string. This test exists
   * because the first draft asserted the opposite and failed against correct code — the
   * coercion is behaviour to preserve, not a bug to fix.
   */
  await send({ isEphemeral: true, selfDestructTimer: "60" });
  assert.equal(callTo("message.save").args[0].selfDestructSeconds, 60);
});

test("the conversation's own TTL applies even when the caller asks for nothing", async () => {
  state.ttlSeconds = 3600;
  await send({ isEphemeral: false });

  const saved = callTo("message.save").args[0];
  assert.equal(saved.isEphemeral, true);
  assert.equal(saved.selfDestructSeconds, 3600);
  assert.ok(saved.expiresAt instanceof Date);
});

test("a caller may shorten its own message, never lengthen it past the conversation's", async () => {
  state.ttlSeconds = 3600;
  await send({ isEphemeral: true, selfDestructTimer: 60 });
  assert.equal(callTo("message.save").args[0].selfDestructSeconds, 60, "the shorter wins");

  calls = [];
  resetState();
  state.ttlSeconds = 600;
  await send({ isEphemeral: true, selfDestructTimer: 99999 });
  assert.equal(
    callTo("message.save").args[0].selfDestructSeconds,
    600,
    "the conversation's setting is the floor"
  );
});

test("replyTo is populated, so the sender's reply preview doesn't collapse", async () => {
  await send();
  const populated = callTo("message.populate").args[0];
  assert.deepEqual(populated, ["sender", "receiver", "replyTo"]);
});

/* ── Delivery ─────────────────────────────────────────────────────────────── */

test("an online receiver gets the message and a delivery receipt", async () => {
  const result = await send();

  const emits = names().filter((n) => n.startsWith("emit:"));
  assert.deepEqual(emits, [
    "emit:receiveMessage", // to the receiver
    "emit:receiveMessage", // echoed to the sender's other tabs
    "emit:chatUpdated", // sender
    "emit:chatUpdated", // receiver
  ]);
  assert.ok(callTo("message.markAsDelivered"), "delivered when they're connected");
  assert.equal(callTo("sendPushNotification"), undefined, "no push to someone who's here");
  assert.equal(result.receiverOnline, true);
});

test("an offline receiver gets a push and no delivery receipt", async () => {
  state.receiverSockets = [];
  const result = await send();

  assert.equal(callTo("message.markAsDelivered"), undefined);
  assert.ok(callTo("sendPushNotification"), "offline means push");
  assert.equal(result.receiverOnline, false);

  // The sender's echo still happens; the receiver's live emit does not.
  const emits = names().filter((n) => n.startsWith("emit:"));
  assert.deepEqual(emits, ["emit:receiveMessage", "emit:chatUpdated"]);
});

test("a muted conversation suppresses the push but still stores the message", async () => {
  state.receiverSockets = [];
  state.muted = true;

  const result = await send();

  assert.equal(result.ok, true);
  assert.ok(callTo("message.save"));
  assert.equal(callTo("sendPushNotification"), undefined, "muting must actually mute");
});

test("THE POINT: a note to self is delivered once, and pushes nothing", async () => {
  /*
   * Sender and receiver being the same account made the receiver emit reach the sending
   * socket, so the message arrived twice — once as incoming from yourself, once as your own.
   */
  state.receiver = { _id: SENDER, username: "sender", name: "Sender" };

  const result = await send({ receiverId: SENDER });

  assert.equal(result.receiverOnline, false, "self-notes are never 'online' deliveries");
  const receiveEmits = names().filter((n) => n === "emit:receiveMessage");
  assert.equal(receiveEmits.length, 1, "exactly one delivery");
  assert.equal(callTo("sendPushNotification"), undefined, "never push yourself");
});

test("the sender's echo goes to their room, not one socket", async () => {
  // A second tab or another device would otherwise never see a message this account sent.
  await send();
  const senderEcho = calls.filter(
    (c) => c.name === "emit:receiveMessage" && c.args[1].isOwn === true
  );
  assert.equal(senderEcho.length, 1);
  assert.equal(senderEcho[0].args[0], SENDER.toString(), "addressed to the sender's room");
});

test("the receiver's chat row carries no unreadCount, the sender's carries zero", async () => {
  /*
   * It used to be hard-coded to 1 for the receiver, which is only right when they had no
   * unread messages already — the badge showed "1" over a thread with thirty unread.
   */
  await send();
  const [senderRow, receiverRow] = calls
    .filter((c) => c.name === "emit:chatUpdated")
    .map((c) => c.args[1]);

  assert.equal(senderRow.unreadCount, 0);
  assert.ok(!("unreadCount" in receiverRow), "the client counts for itself");
});
