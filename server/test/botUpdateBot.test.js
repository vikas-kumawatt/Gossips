import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * Reassigning a bot's API key, and the pause it is supposed to lift.
 *
 * ── The dead end this file exists to keep closed ────────────────────────────
 *
 * `revokeApiKey` stops every bot on that key with `paused_key_invalid` and the reason "The API key
 * this bot used was revoked. Assign another to resume." Assigning another did not resume, and
 * nothing else did either:
 *
 *   · `RESUMABLE` in `updateBot` excluded `paused_key_invalid`, so `status: "active"` returned 409
 *   · `canResume` in the frontend excluded it too, so no button was rendered
 *   · `revalidateApiKey` resumes only bots on the key being revalidated — and that key is revoked,
 *     so it cannot be found, let alone revalidated
 *
 * Three correct-looking local decisions that together made a stopped bot permanently stopped, for an
 * owner who did exactly what the product told them to. None of the three was covered by a test, and
 * the gap was between them rather than inside any one of them — which is why these tests drive the
 * real controller and assert on what is *written to the persona*, not on any single guard.
 *
 * The mocking follows `botCreateBot.test.js`, including its `chain` helper and the note on why it
 * has to be thenable as well as `.lean()`-able.
 */

const oid = () => String(new mongoose.Types.ObjectId());

const OWNER_ID = oid();
const BOT_ID = oid();
const OLD_KEY_ID = oid();
const NEW_KEY_ID = oid();

/** What the controller wrote to the persona, so a test can assert the status transition. */
let personaWrites = [];
/** The persona as it stands before the patch. Each test sets this. */
let personaDoc = null;
/** The key `ApiKey.findOne` will answer with. */
let keyDoc = null;

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
    findOne: () => chain({ _id: BOT_ID, username: "ana", owner: OWNER_ID, isBot: true }),
    findById: () => chain({ _id: BOT_ID, username: "ana" }),
    updateOne: async () => ({ modifiedCount: 1 }),
  },
});

mock.module("../models/BotPersona.js", {
  defaultExport: {
    findOne: () => chain(personaDoc),
    updateOne: async (_filter, update) => {
      personaWrites.push(update.$set);
      return { modifiedCount: 1 };
    },
  },
  namedExports: {
    BOT_STATUSES: ["active"],
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_REPLY_MODEL: "claude-haiku-4-5-20251001",
  },
});

mock.module("../models/ApiKey.js", {
  defaultExport: { findOne: () => chain(keyDoc) },
});

mock.module("../models/BotMemory.js", { defaultExport: {} });
mock.module("../models/BotActionLog.js", { defaultExport: {}, namedExports: { BOT_ACTIONS: [] } });

/*
 * The native binding, which is prebuilt per platform and does not survive a checkout moving between
 * machines — the same stub, and the same reason, as `attachments.test.js`. Nothing here hashes
 * anything; it is reachable only because the controller's import graph leads to `User.js`.
 */
mock.module("bcrypt", {
  defaultExport: {
    hash: async () => "stub-hash",
    compare: async () => true,
    genSalt: async () => "stub-salt",
  },
});

const { updateBot } = await import("../controllers/botController.js");

/** The bits of `res` the respond helpers touch. */
const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const patch = async (body, { status = "paused_key_invalid", keyValid = true } = {}) => {
  personaWrites = [];
  personaDoc = { model: "claude-sonnet-5", replyModel: "claude-haiku-4-5-20251001", status };
  keyDoc = {
    _id: NEW_KEY_ID,
    isValid: keyValid,
    provider: "anthropic",
    // Empty on purpose — discovery can fail for reasons that say nothing about the key, and the
    // controller falls back to the provider's pattern. Same note as botCreateBot.test.js.
    availableModels: [],
  };

  const res = makeRes();
  await updateBot({ params: { id: BOT_ID }, user: { id: OWNER_ID }, body }, res);
  return res;
};

/** The status the patch wrote, or undefined if it wrote none. */
const writtenStatus = () => personaWrites.find((write) => "status" in write)?.status;

test("THE POINT: assigning a working key resumes a bot stopped by a revoked one", async () => {
  const res = await patch({ apiKeyId: NEW_KEY_ID });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(writtenStatus(), "active", "the bot is still stopped after the fix it was told to make");

  const write = personaWrites.find((entry) => "status" in entry);
  assert.equal(write.statusReason, "", "the revoked-key sentence must not survive the fix");
  assert.ok(write.nextRunAt instanceof Date, "and it has to be scheduled, or it resumes to nothing");
});

test("the key and the resume can arrive in one patch, which is what the edit form sends", async () => {
  /*
   * The natural gesture: open a stopped bot, change the key, save. The client diffs the form, so
   * both fields go in one request — and `RESUMABLE` refused it, on the grounds that the problem the
   * patch is fixing had not been fixed yet.
   */
  const res = await patch({ apiKeyId: NEW_KEY_ID, status: "active" });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(writtenStatus(), "active");
});

test("a key that isn't valid resumes nothing", async () => {
  const res = await patch({ apiKeyId: NEW_KEY_ID }, { keyValid: false });

  assert.equal(res.statusCode, 400);
  assert.equal(personaWrites.length, 0, "a refused patch must not half-apply");
});

test("THE POINT: a new key lifts a key pause and nothing else", async () => {
  /*
   * The failure mode of the fix, and the more serious direction of the two. A new credential says
   * nothing about a rate limit, a retired model, or an owner's own pause — and lifting
   * `paused_by_admin` because an owner picked a different key from a dropdown would be a moderation
   * bypass dressed up as a convenience.
   */
  for (const status of [
    "paused_by_admin",
    "paused_rate_limited",
    "paused_by_owner",
    "paused_model_invalid",
  ]) {
    const res = await patch({ apiKeyId: NEW_KEY_ID }, { status });

    assert.equal(res.statusCode, 200, status);
    assert.equal(writtenStatus(), undefined, `${status} was lifted by a key change`);
  }
});

test("a status-only resume is still refused for a bot whose key is untouched", async () => {
  /*
   * The original rule, which was right and stays. Without a new key there is nothing to suggest the
   * credential works, and resuming would pause the bot again on its next cycle.
   */
  const res = await patch({ status: "active" });

  assert.equal(res.statusCode, 409);
  assert.match(res.body?.error?.message || "", /can't simply be resumed/);
  assert.equal(personaWrites.length, 0);
});

test("an admin pause is not liftable by an owner even with a key in the same patch", async () => {
  const res = await patch({ apiKeyId: NEW_KEY_ID, status: "active" }, { status: "paused_by_admin" });

  assert.equal(res.statusCode, 409, "an owner must not be able to undo a moderation action");
  assert.equal(personaWrites.length, 0);
});
