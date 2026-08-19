import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * `POST /chats/messages`, the HTTP fallback for sending a direct message.
 *
 * The point of these is that the fallback and the socket are the *same* send. The
 * controller is a mapper: session to `senderId`, body to arguments, service result
 * to a status code. Everything that decides whether a message may be sent lives in
 * `services/directMessage.js` and is tested against that.
 *
 * So what is worth asserting is exactly the mapping — and in particular that the
 * sender cannot be taken from the request body, which is the one place this path
 * could differ from the socket in a way that matters.
 */

/*
 * Mocked once, at module scope. `mock.module` refuses a second registration for
 * the same specifier, so each test swaps `impl` rather than re-mocking — which
 * also means the controller is imported once instead of per test.
 */
let impl = async () => ({ ok: true });

const sendDirectMessage = mock.fn((...args) => impl(...args));
mock.module("../services/directMessage.js", { namedExports: { sendDirectMessage } });

/*
 * `bcrypt` is stubbed because it is a *native* module and this file never reaches
 * the code that uses it — chatController imports it for the chat-lock PIN, which
 * is nowhere near sending a message. Loading it means dlopen'ing a binary built
 * for whichever platform last ran `npm install`, so a checkout made on Windows
 * cannot run this suite on Linux or in CI.
 *
 * Stubbing it keeps the test hermetic: no compiler, no platform binary, nothing
 * to rebuild after switching machines.
 */
mock.module("bcrypt", {
  defaultExport: {
    hash: async () => "stub-hash",
    compare: async () => true,
    genSalt: async () => "stub-salt",
  },
});

const { sendMessage } = await import("../controllers/chatController.js");

/** The happy path, unless a test says otherwise. */
const succeeds = () => {
  impl = async () => ({
    ok: true,
    message: { _id: { toString: () => "msg-1" } },
    messageObject: { _id: "msg-1", content: "hi" },
    receiverOnline: true,
  });
  sendDirectMessage.mock.resetCalls();
};

/** The smallest `res` the controller uses. */
const fakeRes = () => {
  const captured = { code: null, body: null };
  const res = {
    status(code) {
      captured.code = code;
      return res;
    },
    json(body) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
};

const request = (body = {}, user = { _id: "user-1", role: "user" }) => ({ body, user });

test("the sender comes from the session, never from the body", async () => {
  /*
   * The socket handler refuses when `data.senderId` is not the authenticated user.
   * Over HTTP there is nothing to compare against — so the body's value must be
   * ignored outright rather than checked. If this ever reads `req.body.senderId`,
   * anyone can send a message as anyone.
   */
  succeeds();
  const { res } = fakeRes();

  await sendMessage(
    request({ senderId: "someone-else", receiverId: "user-2", content: "hi" }),
    res
  );

  const passed = sendDirectMessage.mock.calls[0].arguments[0];
  assert.equal(passed.senderId, "user-1");
  assert.notEqual(passed.senderId, "someone-else");
});

test("tempId is forwarded as the idempotency key", async () => {
  // This is what makes an HTTP retry safe: the service returns the original
  // message rather than sending a second one.
  succeeds();
  const { res } = fakeRes();

  await sendMessage(request({ receiverId: "user-2", content: "hi", tempId: "temp-9" }), res);

  assert.equal(sendDirectMessage.mock.calls[0].arguments[0].clientId, "temp-9");
});

test("the caller's role is passed, so staff bypass the feature gate as they do on the socket", async () => {
  succeeds();
  const { res } = fakeRes();

  await sendMessage(
    request({ receiverId: "user-2", content: "hi" }, { _id: "user-1", role: "admin" }),
    res
  );

  assert.equal(sendDirectMessage.mock.calls[0].arguments[0].actorRole, "admin");
});

test("a successful send answers 201 with the ids the client needs to settle its bubble", async () => {
  succeeds();
  const { res, captured } = fakeRes();

  await sendMessage(request({ receiverId: "user-2", content: "hi", tempId: "temp-9" }), res);

  assert.equal(captured.code, 201);
  // `tempId` echoed back, matching the socket ack — the optimistic row is keyed on it.
  assert.equal(captured.body.tempId, "temp-9");
  assert.equal(captured.body.messageId, "msg-1");
  // The full message, because there is no socket echo on this path to supply it.
  assert.deepEqual(captured.body.message, { _id: "msg-1", content: "hi" });
});

test("defaults match the socket handler's", async () => {
  succeeds();
  const { res } = fakeRes();

  await sendMessage(request({ receiverId: "user-2", content: "hi" }), res);

  const passed = sendDirectMessage.mock.calls[0].arguments[0];
  assert.equal(passed.messageType, "text");
  assert.equal(passed.isEphemeral, false);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

const refuseWith = async (error) => {
  impl = async () => ({ ok: false, error });
  const { res, captured } = fakeRes();
  await sendMessage(request({ receiverId: "user-2", content: "hi" }), res);
  return captured;
};

test("a refusal about who is involved is 403, not 400", async () => {
  /*
   * The service returns one flat string for every refusal, so the controller draws
   * the distinction. A block is not a malformed request and a client should not
   * retry it as though correcting the payload would help.
   */
  assert.equal((await refuseWith("Cannot send message to blocked user")).code, 403);
  assert.equal((await refuseWith("They don't accept messages from you")).code, 403);
});

test("a malformed payload is 400", async () => {
  assert.equal((await refuseWith("No recipient")).code, 400);
  assert.equal((await refuseWith("Message content is required")).code, 400);
});

test("the refusal reason reaches the client verbatim", async () => {
  // The service's wording is the wording the person sees; the controller must not
  // replace it with something generic.
  const captured = await refuseWith("Gossips is down for maintenance.");
  assert.equal(captured.body.error, "Gossips is down for maintenance.");
});

test("an unexpected throw is a 500 with a fixed string", async () => {
  // An internal error message routinely carries a query, a path or a stack frame.
  impl = async () => {
    throw new Error("Mongo timeout at /srv/app/models/Message.js:214");
  };
  const { res, captured } = fakeRes();

  await sendMessage(request({ receiverId: "user-2", content: "hi" }), res);

  assert.equal(captured.code, 500);
  assert.equal(captured.body.error, "Failed to send message");
  assert.doesNotMatch(JSON.stringify(captured.body), /Mongo|models\//);
});
