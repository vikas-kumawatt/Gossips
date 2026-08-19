import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * `services/groupMessage.js`, extracted from `socket.on("sendGroupMessage")`.
 *
 * The extraction's whole claim is that nothing changed except who can call it, so
 * these assert the behaviours the handler had and that were previously untestable
 * — there was no way to reach that code without a live socket server.
 *
 * The two that matter most are the gate running *before* anything is written, and
 * the sender not receiving their own message twice.
 */

const settings = { current: { maintenanceMode: false, directMessagesEnabled: true } };
const access = { current: { ok: true, group: { _id: "grp-1", name: "The Group" } } };

const saved = [];
const emits = [];
const pushes = [];

/*
 * Swappable, like `settings` and `access` above: a module mock cannot be
 * redefined once registered, so a test that needs different behaviour changes
 * the implementation rather than the mock.
 */
const pushImpl = {
  current: async (groupId, senderId, notification) =>
    pushes.push({ groupId, senderId, notification }),
};

class FakeMessage {
  constructor(data) {
    Object.assign(this, data);
    this._id = { toString: () => "msg-1" };
  }
  async save() {
    saved.push({ ...this });
  }
  async populate() {}
  toObject() {
    return { _id: "msg-1", content: this.content, group: this.group };
  }
}
FakeMessage.groupConversationKey = (id) => `g:${id}`;
FakeMessage.findOne = async () => null;

mock.module("../models/Message.js", { defaultExport: FakeMessage });

mock.module("../config/socket.js", {
  namedExports: {
    getIO: () => ({
      to(room) {
        const chain = {
          except: (excluded) => ({
            emit: (event, payload) => emits.push({ event, room, except: excluded, payload }),
          }),
          emit: (event, payload) => emits.push({ event, room, payload }),
        };
        return chain;
      },
    }),
    notifyGroupMembers: (...args) => pushImpl.current(...args),
  },
});

mock.module("../utils/settings.js", {
  namedExports: { getSettings: async () => settings.current },
});
mock.module("../utils/messageContent.js", {
  namedExports: {
    parseSendPayload: ({ content, media, messageType }) =>
      content || media?.length
        ? { content, media: media ?? [], messageType }
        : { error: "Message content is required" },
  },
});
mock.module("../utils/chatAccess.js", {
  namedExports: {
    resolveGroupSend: async () => access.current,
    resolveReplyTo: async (replyTo) => replyTo ?? null,
  },
});
mock.module("../utils/mentions.js", {
  namedExports: { messageEntities: async () => ({ mentions: [], hashtags: [] }) },
});

const { sendGroupMessage } = await import("../services/groupMessage.js");

const reset = () => {
  settings.current = { maintenanceMode: false, directMessagesEnabled: true };
  access.current = { ok: true, group: { _id: "grp-1", name: "The Group" } };
  saved.length = 0;
  emits.length = 0;
  pushes.length = 0;
  pushImpl.current = async (groupId, senderId, notification) =>
    pushes.push({ groupId, senderId, notification });
};

const send = (overrides = {}) =>
  sendGroupMessage({
    senderId: "user-1",
    groupId: "grp-1",
    content: "hello",
    actorRole: "user",
    ...overrides,
  });

// ── The gate ─────────────────────────────────────────────────────────────────

test("THE POINT: maintenance mode refuses before anything is written", async () => {
  /*
   * The handler had no gate at all until one was added, which meant maintenance
   * mode stopped direct messages and left every group in the app running. It has
   * to run first — before validation and before any query — or a paused platform
   * still writes.
   */
  reset();
  settings.current = { maintenanceMode: true, maintenanceMessage: "Back shortly." };

  const result = await send();

  assert.equal(result.ok, false);
  assert.equal(result.error, "Back shortly.");
  assert.equal(saved.length, 0, "nothing may be persisted");
  assert.equal(emits.length, 0, "and nothing broadcast");
});

test("an empty maintenance message cannot switch maintenance mode off", async () => {
  // `maintenanceMessage` is admin-editable with no minimum length.
  reset();
  settings.current = { maintenanceMode: true, maintenanceMessage: "" };

  const result = await send();

  assert.equal(result.ok, false);
  assert.match(result.error, /maintenance/i);
});

test("the messaging flag governs groups too, and staff bypass both switches", async () => {
  reset();
  settings.current = { maintenanceMode: false, directMessagesEnabled: false };
  assert.equal((await send()).ok, false);

  // Otherwise disabling messaging would also stop a moderator checking the fix.
  reset();
  settings.current = { maintenanceMode: true, directMessagesEnabled: false };
  assert.equal((await send({ actorRole: "admin" })).ok, true);
});

test("an unknown role is treated as non-staff, not as a bypass", async () => {
  reset();
  settings.current = { maintenanceMode: true, maintenanceMessage: "Back shortly." };
  assert.equal((await send({ actorRole: "moderator" })).ok, false);
  assert.equal((await send({ actorRole: undefined })).ok, false);
});

// ── Permissions and validation ───────────────────────────────────────────────

test("group permissions are the shared check, and its reason is returned verbatim", async () => {
  // Membership, bans, mute, media rules and slow mode all live in
  // resolveGroupSend, shared with /share and forwarding.
  reset();
  access.current = { ok: false, reason: "Slow mode is on — wait 30s" };

  const result = await send();

  assert.deepEqual(result, { ok: false, error: "Slow mode is on — wait 30s" });
  assert.equal(saved.length, 0);
});

test("an empty payload is refused after the gate but before the permission check", async () => {
  reset();
  const result = await send({ content: "" });
  assert.equal(result.ok, false);
  assert.equal(saved.length, 0);
});

// ── Delivery ─────────────────────────────────────────────────────────────────

test("THE POINT: the sender is excluded from the broadcast, then sent their own copy", async () => {
  /*
   * The handler used `socket.to(room)`, which excludes the calling socket. A
   * service has no socket, so this is `io.to(room).except(senderRoom)` — and it is
   * better in one respect: it also excludes the sender's *other* tabs from the
   * `isOwn: false` copy, which would otherwise render as though someone else sent it.
   */
  reset();
  await send({ clientId: "temp-7" });

  const broadcast = emits.find((e) => e.except);
  assert.equal(broadcast.room, "grp-1");
  assert.equal(broadcast.except, "user-1");
  assert.equal(broadcast.payload.isOwn, false);

  const own = emits.find((e) => !e.except);
  assert.equal(own.room, "user-1", "the sender's own room, so every tab gets it");
  assert.equal(own.payload.isOwn, true);

  // Both carry the optimistic id so a client can reconcile its bubble either way.
  assert.equal(broadcast.payload.tempId, "temp-7");
  assert.equal(own.payload.tempId, "temp-7");
});

test("offline members are notified with the group's name and the sender's", async () => {
  reset();
  await send();

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].groupId, "grp-1");
  assert.equal(pushes[0].senderId, "user-1");
  assert.equal(pushes[0].notification.title, "The Group");
});

test("a failed push does not fail a message that is already delivered", async () => {
  /*
   * The message is saved and broadcast before the fan-out runs. Letting a push
   * error escape would report a send as failed when everyone online already has it.
   */
  reset();
  pushImpl.current = async () => {
    throw new Error("FCM unreachable");
  };

  const result = await send();

  assert.equal(result.ok, true);
  assert.equal(emits.length, 2, "delivery already happened and must stand");
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test("a clientId is stored, so a retry is idempotent", async () => {
  reset();
  await send({ clientId: "temp-7" });
  assert.equal(saved[0].clientId, "temp-7");
});

test("no clientId means no clientId field, rather than an explicit undefined", async () => {
  // A stored `clientId: undefined` would collide with every other such row on
  // the unique index.
  reset();
  await send();
  assert.ok(!("clientId" in saved[0]));
});

test("a duplicate save resolves to the existing row instead of erroring", async () => {
  reset();
  const existing = { _id: { toString: () => "msg-existing" }, toObject: () => ({}), populate: async () => {} };
  FakeMessage.prototype.save = async function save() {
    throw Object.assign(new Error("dup"), { code: 11000 });
  };
  FakeMessage.findOne = async () => existing;

  const result = await send({ clientId: "temp-7" });

  assert.equal(result.ok, true);
  assert.equal(result.message._id.toString(), "msg-existing");

  FakeMessage.prototype.save = async function save() {
    saved.push({ ...this });
  };
  FakeMessage.findOne = async () => null;
});

test("a duplicate with no clientId is a real error, not an idempotent retry", async () => {
  reset();
  FakeMessage.prototype.save = async function save() {
    throw Object.assign(new Error("dup"), { code: 11000 });
  };

  await assert.rejects(() => send(), /dup/);

  FakeMessage.prototype.save = async function save() {
    saved.push({ ...this });
  };
});

test("the conversation key comes from the group's own id, not the caller's string", async () => {
  // Rooms are keyed on the group's `_id`; a differently-cased id from a client
  // would broadcast to nothing.
  reset();
  await send({ groupId: "GRP-1" });
  assert.equal(saved[0].conversation, "g:grp-1");
  assert.equal(saved[0].isGroupMessage, true);
});
