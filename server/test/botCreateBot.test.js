import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * Creating a bot writes three documents, and this is about what happens when the second or third
 * one fails.
 *
 * ── Why a partial create is worse than a failed one ─────────────────────────
 *
 * `createBot` inserts a `User`, then a `UserSettings`, then a `BotPersona`. Mongo has no
 * transaction here and adding one for three inserts would be more machinery than the problem
 * deserves — but without *something*, a failure at step two or three leaves the user row behind.
 *
 * That orphan is not inert. It holds the username, so the owner's obvious next move — try again
 * with the same handle — is refused with "That username is taken", which is true and completely
 * unhelpful. It is also a bot the runner ignores, since the runner claims out of `BotPersona` and
 * there is no persona; so it sits in the owner's list doing nothing, in the state `isIncomplete`
 * exists to describe. The account it most resembles is one that was created and then abandoned.
 *
 * So the failure path deletes what it wrote. The tests below drive the real controller against
 * mocked models and assert on the *deletes*, because a compensating action that silently doesn't
 * run looks exactly like one that does.
 *
 * ── And the error the owner is handed ───────────────────────────────────────
 *
 * The last two tests pin the duplicate-key reporting, which had no coverage and cost an afternoon.
 * `createBot` used to answer "That username is taken" for every E11000 — including the one raised
 * by the *email* index, which is a deployment step nobody has run rather than a handle anyone can
 * change. An error that misidentifies its own cause is worse than a vague one, because it gets
 * believed.
 */

const oid = () => String(new mongoose.Types.ObjectId());

const OWNER_ID = oid();
const KEY_ID = oid();
const BOT_ID = oid();

/** Everything that happened, in order, so a test can assert a delete came after a create. */
let trace = [];

let createError = null;
let settingsError = null;
let personaError = null;

let deletedUsers = [];
let deletedSettings = [];

/**
 * A Mongoose-ish chainable that resolves to `value`.
 *
 * Thenable as well as `.lean()`-able, because a Query is both and the controller uses both: the
 * owner lookup ends in `.lean()`, the key lookup just awaits `.select(...)`. Without `then` the
 * second one resolved to *this object*, whose `isValid` is undefined — so every test in this file
 * failed identically on "That API key is not currently valid", a mock artefact that looked
 * convincingly like a controller bug.
 */
const chain = (value) => {
  const self = {
    select: () => self,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
};

mock.module("../models/User.js", {
  defaultExport: {
    countDocuments: async () => 0,
    exists: async () => null,
    findById: () => chain({ _id: OWNER_ID, email: "owner@example.com" }),
    create: async (doc) => {
      trace.push("user.create");
      if (createError) throw createError;
      return { _id: BOT_ID, ...doc };
    },
    deleteOne: async (filter) => {
      trace.push("user.deleteOne");
      deletedUsers.push(filter);
      return { deletedCount: 1 };
    },
  },
});

mock.module("../models/UserSettings.js", {
  defaultExport: {
    create: async () => {
      trace.push("settings.create");
      if (settingsError) throw settingsError;
      return { _id: oid() };
    },
    deleteOne: async (filter) => {
      trace.push("settings.deleteOne");
      deletedSettings.push(filter);
      return { deletedCount: 1 };
    },
  },
});

mock.module("../models/BotPersona.js", {
  defaultExport: {
    create: async (doc) => {
      trace.push("persona.create");
      if (personaError) throw personaError;
      return doc;
    },
  },
  namedExports: {
    BOT_STATUSES: ["active"],
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_REPLY_MODEL: "claude-haiku-4-5-20251001",
  },
});

mock.module("../models/ApiKey.js", {
  defaultExport: {
    findOne: () =>
      chain({
        _id: KEY_ID,
        isValid: true,
        provider: "anthropic",
        // Empty on purpose: discovery can fail for reasons that say nothing about the key, so the
        // controller falls back to the provider's pattern. See `modelProblem`.
        availableModels: [],
      }),
  },
});

mock.module("../models/BotMemory.js", { defaultExport: {} });
mock.module("../models/BotActionLog.js", { defaultExport: {} });

mock.module("../utils/settings.js", {
  namedExports: {
    getSettings: async () => ({ maxBotsPerOwner: 5 }),
    invalidateSettingsCache: () => {},
  },
});

mock.module("../utils/reservedUsernames.js", {
  namedExports: { isReserved: async () => false },
});

/*
 * `bcrypt` is a native module and nothing here reaches the code that uses it —
 * it arrives through models/User.js, which hashes passwords on save. Loading it
 * means dlopen'ing a binary built for whichever platform last ran `npm install`,
 * so a checkout made on Windows cannot run this suite on Linux or in CI.
 *
 * Stubbing keeps the suite hermetic: no compiler, no platform binary, nothing to
 * rebuild after switching machines.
 */
mock.module("bcrypt", {
  defaultExport: {
    hash: async () => "stub-hash",
    compare: async () => true,
    genSalt: async () => "stub-salt",
  },
});

const { createBot } = await import("../controllers/botController.js");

/** Captures what the controller answered, in the envelope `utils/respond.js` really produces. */
const fakeRes = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

const validBody = {
  username: "mira",
  name: "Mira",
  systemPrompt: "You post short observations about architecture and public transport.",
  model: "claude-sonnet-5",
  replyModel: "claude-haiku-4-5-20251001",
  apiKeyId: KEY_ID,
};

const run = async (body = validBody) => {
  const res = fakeRes();
  await createBot({ user: { id: OWNER_ID }, body }, res);
  return res;
};

const reset = () => {
  trace = [];
  createError = null;
  settingsError = null;
  personaError = null;
  deletedUsers = [];
  deletedSettings = [];
};

const duplicate = (field) =>
  Object.assign(new Error("E11000 duplicate key error"), {
    code: 11000,
    keyPattern: { [field]: 1 },
    keyValue: { [field]: "owner@example.com" },
  });

test("the happy path writes all three documents and deletes nothing", async () => {
  reset();
  const res = await run();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.bot.username, "mira");
  assert.deepEqual(trace, ["user.create", "settings.create", "persona.create"]);
  assert.deepEqual(deletedUsers, []);
});

test("THE POINT: a failed persona write takes the user row with it", async () => {
  reset();
  personaError = new Error("persona validation failed");

  const res = await run();

  assert.equal(res.statusCode, 500);
  // The user row is gone, so the username is free and no half-bot is left in the owner's list.
  assert.deepEqual(deletedUsers, [{ _id: BOT_ID }]);
  assert.deepEqual(deletedSettings, [{ user: BOT_ID }]);
  // And the cleanup ran *after* the writes it is undoing, not instead of them.
  assert.deepEqual(trace, [
    "user.create",
    "settings.create",
    "persona.create",
    "settings.deleteOne",
    "user.deleteOne",
  ]);
});

test("a failed settings write is cleaned up the same way", async () => {
  reset();
  settingsError = new Error("settings write failed");

  const res = await run();

  assert.equal(res.statusCode, 500);
  assert.deepEqual(deletedUsers, [{ _id: BOT_ID }]);
  assert.equal(trace.includes("persona.create"), false);
});

test("a cleanup that itself fails does not replace the original error", async () => {
  reset();
  personaError = new Error("persona validation failed");

  /*
   * The realistic version of a bad day: the write failed because the database is unhappy, so the
   * delete is likely to fail too. If that threw, the owner would get an unhandled rejection
   * instead of a 500 — and the actual cause would never be logged.
   */
  const { default: User } = await import("../models/User.js");
  const original = User.deleteOne;
  User.deleteOne = async () => {
    trace.push("user.deleteOne");
    throw new Error("delete failed too");
  };

  const res = await run();
  User.deleteOne = original;

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, "Couldn't create that bot");
});

test("no cleanup runs when the user row was never written", async () => {
  reset();
  createError = new Error("user write failed");

  const res = await run();

  assert.equal(res.statusCode, 500);
  // Nothing to undo. A delete here would be a query against an id that doesn't exist.
  assert.deepEqual(deletedUsers, []);
  assert.deepEqual(deletedSettings, []);
});

test("a duplicate username is reported as a duplicate username", async () => {
  reset();
  createError = duplicate("username");

  const res = await run();

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.message, "That username is taken");
});

test("THE OTHER POINT: a duplicate email is not blamed on the username", async () => {
  reset();
  createError = duplicate("email");

  const res = await run();

  /*
   * A bot carries its owner's address deliberately, so this collision means the database still has
   * the old global `email_1` index instead of the humans-only partial one — a server that hasn't
   * run scripts/migrateBotEmailIndex.js. The owner cannot fix it by choosing a different handle,
   * so the message must not suggest they can.
   */
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error.message, /one account per email address/);
  /*
   * Not `doesNotMatch(/username/)`, which is what this asserted first and is wrong: the message
   * ends "not a different username" on purpose, to head off the retry an owner would otherwise
   * spend their next five minutes on. What must not appear is the *blame* — the old answer that
   * sent the owner after their handle.
   */
  assert.doesNotMatch(res.body.error.message, /username is taken/);
});
