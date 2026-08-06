import assert from "node:assert";
import test from "node:test";
import mongoose from "mongoose";

process.env.BYOK_ENCRYPTION_SECRET = "test-secret-of-at-least-32-characters-long";

const ApiKey = (await import("../models/ApiKey.js")).default;
const User = (await import("../models/User.js")).default;
const BotPersona = (await import("../models/BotPersona.js")).default;
const BotMemory = (await import("../models/BotMemory.js")).default;
const BotActionLog = (await import("../models/BotActionLog.js")).default;
const { ALLOWED_MODELS, BOT_STATUSES } = await import("../models/BotPersona.js");
const { BOT_ACTIONS } = await import("../models/BotActionLog.js");

const oid = () => new mongoose.Types.ObjectId();

/*
 * Schema-level assertions, no database. Every property tested here is one that a wrong
 * answer makes unrecoverable — a leaked credential, or an AI account that renders as a
 * person — so they're checked at the only layer that holds for every query.
 */

/* ── Key exposure ─────────────────────────────────────────────────────────── */

test("THE POINT: a serialised ApiKey never carries the key or its fingerprint", () => {
  const key = new ApiKey({
    owner: oid(),
    encryptedKey: "v1.aaa.bbb.ccc",
    fingerprint: "fingerprint-value",
    keyHint: "wXyZ",
    label: "mine",
  });

  for (const [label, serialised] of [
    ["toJSON", JSON.stringify(key)],
    ["toObject", JSON.stringify(key.toObject())],
    ["express res.json", JSON.stringify({ key })],
    ["nested in an array", JSON.stringify({ keys: [key] })],
  ]) {
    assert.ok(!serialised.includes("v1.aaa"), `${label} leaked the ciphertext`);
    assert.ok(!serialised.includes("fingerprint-value"), `${label} leaked the fingerprint`);
  }
});

test("the ciphertext and fingerprint require an explicit select", () => {
  // `select: false` is what makes "forgot to exclude it" the safe default rather than the
  // dangerous one: a new endpoint that adds a projection gets no key at all.
  for (const path of ["encryptedKey", "fingerprint"]) {
    assert.equal(
      ApiKey.schema.path(path).options.select,
      false,
      `${path} must be select: false`
    );
  }
});

test("the owner view is an allowlist, not a redaction", () => {
  const key = new ApiKey({
    owner: oid(),
    encryptedKey: "v1.aaa.bbb.ccc",
    fingerprint: "fp",
    keyHint: "wXyZ",
  });
  const view = Object.keys(key.toOwnerView());

  // Allowlists stay correct when a field is added to the schema; denylists don't.
  assert.ok(!view.includes("encryptedKey"));
  assert.ok(!view.includes("fingerprint"));

  /*
   * Pinned exactly, and that is the whole value of the test: multi-provider support added
   * `availableModels` and `modelsFetchedAt` to the schema *and* to this view, and pinning the key
   * set is what forced that second decision to be made deliberately rather than inherited.
   *
   * Anything added to `ApiKey` from now on stays invisible to the owner until someone edits both
   * `toOwnerView` and this list — which is the correct amount of friction for a document whose other
   * two fields are a credential and a fingerprint of one.
   */
  assert.deepEqual(
    view.sort(),
    [
      "_id",
      "availableModels",
      "baseUrl",
      "createdAt",
      "endpointSource",
      "isValid",
      "keyHint",
      "label",
      "lastError",
      "lastValidatedAt",
      "modelsFetchedAt",
      "provider",
      "revokedAt",
    ].sort()
  );
});

test("a key's provider comes from the shared table, not a second list", async () => {
  /*
   * The enum used to be `["anthropic"]` written out here. With eight providers, a hand-copied list
   * is a list that disagrees with `providers.js` the first time one is added — and the failure mode
   * is a validation error on save that names a provider the app clearly supports.
   */
  const { PROVIDER_IDS, DEFAULT_PROVIDER } = await import("../bots/providers.js");
  // `enumValues` is Mongoose's own resolved list for a String path, not the raw option.
  const enumValues = ApiKey.schema.path("provider").enumValues;

  assert.deepEqual([...enumValues].sort(), [...PROVIDER_IDS].sort());
  assert.ok(PROVIDER_IDS.includes(DEFAULT_PROVIDER));

  // Anthropic stays the default: existing rows predate the field, and it is the one provider with a
  // measured eval history behind it.
  assert.equal(new ApiKey({ owner: oid(), encryptedKey: "x", fingerprint: "y" }).provider, "anthropic");
});

test("THE POINT: an unfamiliar key shape is probed, not refused", async () => {
  /*
   * A real bug, reported by an owner with a working Gemini key: `AIza…` is not the only shape Google
   * issues any more, and the shape check refused anything else with "that doesn't look like a Google
   * Gemini key. Check you've chosen the right provider." Confidently wrong, and unarguable.
   *
   * Prefixes are a guess about how providers format credentials *today*. The provider is the
   * authority and asking it costs one request, so an unrecognised shape has to reach the probe.
   */
  const { providersMatchingKeyShape } = await import("../bots/providers.js");

  // A plausible modern Google key that does not begin `AIza`. Nothing claims it, so nothing refuses
  // it — `checkProviderKey` only stops a key when the answer names a *different* provider.
  assert.deepEqual(providersMatchingKeyShape("ya29.a0ARrdaM9zQ7xKpLmNoPqRsTuVwXyZ012345678"), []);

  /*
   * The half worth keeping: a key that plainly belongs to someone else. This is the mistake the
   * check was written for, and unlike a rotated prefix it is certain.
   */
  assert.deepEqual(providersMatchingKeyShape("AIzaSyD-1234567890abcdefghijklmnopqrstuvwx"), ["google"]);
  assert.deepEqual(providersMatchingKeyShape("gsk_1234567890abcdefghijklmnopqrstuvwxyz"), ["groq"]);

  /*
   * And the ambiguity that makes this a list rather than a guess: `sk-` belongs to three providers,
   * and an Anthropic key matches OpenAI's pattern as well as its own. A function returning one id
   * would have to pick, and picking wrong produces a message that names the wrong provider.
   */
  const skAnt = providersMatchingKeyShape("sk-ant-api03-1234567890abcdefghijklmnop");
  assert.ok(skAnt.includes("anthropic"), "its own provider");
  assert.ok(skAnt.includes("openai"), "and OpenAI's looser pattern, which is why one answer wouldn't do");
});

test("the live-key uniqueness index is partial, not sparse", () => {
  /*
   * The trap `Message.js` documents. A sparse unique index still indexes `null`, and every
   * unrevoked key has `revokedAt: null` — so the second key an owner added would collide
   * with the first. That is the common case, not an edge one.
   */
  const [, options] =
    ApiKey.schema.indexes().find(([spec]) => spec.owner === 1 && spec.fingerprint === 1) || [];

  assert.ok(options?.unique, "must be unique");
  assert.ok(options?.partialFilterExpression, "must be partial");
  assert.ok(!options?.sparse, "must not be sparse");
  assert.deepEqual(options.partialFilterExpression, { revokedAt: null });
});

/* ── Disclosure ───────────────────────────────────────────────────────────── */

test("THE POINT: isBot survives an inclusive projection", () => {
  /*
   * The disclosure is a legal requirement, and there are ~50 distinct user projections in
   * this codebase. `select: true` makes Mongoose merge the field into any inclusive
   * projection, so every existing query gains it and every future one inherits it — which
   * is the difference between one rule and fifty chances to forget it.
   */
  const query = User.find().select("username name profilePic isVerified");
  query._applyPaths();

  assert.equal(query._fields.isBot, 1, "isBot must be projected without being asked for");
  assert.equal(User.schema.path("isBot").options.select, true);
});

test("owner and apiKey are stripped from a serialised user", () => {
  // Who runs a bot is not public: disclosing it would deanonymise anyone experimenting
  // under a persona. The requirement is that the account is disclosed as AI, not who wrote
  // its prompt.
  const bot = new User({
    username: "somebot",
    isBot: true,
    owner: oid(),
    apiKey: oid(),
  });
  const json = JSON.parse(JSON.stringify(bot));

  assert.equal(json.isBot, true, "the disclosure itself must survive");
  assert.ok(!("owner" in json), "owner must not be public");
  assert.ok(!("apiKey" in json), "apiKey must not be public");
});

test("a bot shares its owner's email, and carries no credentials", () => {
  /*
   * The owner is the accountable contact for a bot: everything the platform would send
   * about one goes to the person who runs it, so the row carries their address. Several
   * bots therefore share one address, which is why uniqueness is enforced among humans
   * only.
   */
  const bot = new User({
    username: "abot",
    email: "owner@example.com",
    isBot: true,
    owner: oid(),
  });

  assert.equal(bot.validateSync(), undefined, "a password-less bot is valid");
  assert.equal(bot.password, undefined, "and carries no password");
  assert.equal(
    bot.isEmailVerified,
    false,
    "the owner's address is verified on the owner's row, not this one"
  );

  assert.equal(new User({ username: "aperson" }).isBot, false, "humans default to not-bot");
});

test("THE POINT: email is unique among humans, not across bots", () => {
  const [, options] =
    User.schema.indexes().find(([spec]) => spec.email === 1) || [];

  assert.ok(options?.unique, "humans must still be one-per-address");
  assert.ok(options?.partialFilterExpression, "and bots must be excluded");
  assert.ok(!options?.sparse, "sparse would index nulls and defeat the point");

  /*
   * `{ isBot: false }` rather than `{ isBot: { $ne: true } }`.
   *
   * `partialFilterExpression` accepts equality, `$exists`, `$type`, the range operators,
   * `$and`, `$or` and `$in` — not `$ne`. Mongo rejects an index containing one outright, so
   * this is a correctness requirement, not a style choice. It is also why the migration has
   * to backfill the field onto older accounts: with no `isBot` at all they fall outside this
   * filter and lose email uniqueness entirely.
   */
  assert.deepEqual(options.partialFilterExpression, { isBot: false });

  const expression = JSON.stringify(options.partialFilterExpression);
  assert.ok(!expression.includes("$ne"), "$ne is not a legal partial-filter operator");
});

test("the field-level unique flag is gone, so only the partial index governs email", () => {
  // Leaving `unique: true` on the path would have Mongoose recreate the global index on the
  // next autoIndex run, silently undoing the migration.
  assert.notEqual(User.schema.path("email").options.unique, true);
  assert.equal(User.schema.path("email").options.required, true, "still required of everyone");
});

/* ── Persona ──────────────────────────────────────────────────────────────── */

const personaWith = (model) =>
  new BotPersona({ bot: oid(), systemPrompt: "x".repeat(30), model });

test("the schema bounds the model by shape — length and character set, nothing cleverer", () => {
  /*
   * ── Two failed attempts are recorded here, because the third design is only defensible in light
   *    of them ────────────────────────────────────────────────────────────────
   *
   * 1. A three-item Claude `enum`. Correct with one provider, impossible with eight: which models are
   *    legal depends on the key, and a schema cannot reach `ApiKey.provider`.
   *
   * 2. The **union** of every provider's ceiling. It failed twice, identically. Groq has no model
   *    prefix — it serves other people's models — so its pattern had to be permissive, and a union is
   *    only as strict as its loosest member: `not-a-model` passed. Tightening Groq to require a digit
   *    or slash fixed it, until `self_hosted` arrived equally prefix-less and `not-a-model` passed
   *    again.
   *
   * A third patch would have been treating a structural problem as a series of accidents. Two
   * providers legitimately accept almost any token, so a union across all of them cannot mean much —
   * and a check that looks precise while conveying nothing is worse than one that admits its scope.
   *
   * So this layer refuses what a *shape* can refuse, and the per-provider question moves entirely to
   * the controller. `not-a-model` now passes here, on purpose, and the test below is what stops
   * anyone reading that as the whole story.
   */
  for (const nonsense of [
    "",
    "   ",
    "'; DROP TABLE users",
    "../../etc/passwd",
    "model name with spaces",
    "model\nwith\nnewlines",
    "x".repeat(120),
    "-leading-hyphen",
  ]) {
    assert.ok(
      personaWith(nonsense).validateSync()?.errors?.model,
      `${JSON.stringify(nonsense)} must be refused`
    );
  }

  for (const model of [
    "claude-sonnet-5",
    "gpt-4o",
    "o3-mini",
    "gemini-2.0-flash",
    "grok-3",
    "deepseek-chat",
    "kimi-k2",
    "qwen-max",
    // Groq: versioned, sometimes namespaced.
    "llama-3.3-70b-versatile",
    "qwen/qwen3-32b",
    // Self-hosted: Ollama tags, where a colon is ordinary and a bare name is valid.
    "llama3.2",
    "qwen2.5-coder:7b",
    "mistral",
    "hf.co/user/repo:Q4_K_M",
  ]) {
    assert.equal(
      personaWith(model).validateSync()?.errors?.model,
      undefined,
      `${model} must survive the schema`
    );
  }
});

test("THE BOUNDARY: the schema is not the per-provider check, and cannot be", () => {
  /*
   * The half of the design most likely to be misread later, and the reason the shape check is allowed
   * to be as loose as it is.
   *
   * `gpt-4o` passes the schema for a bot on an Anthropic key, and so does `not-a-model` — the schema
   * only knows the string is *shaped* like a model id. Whether it is one this key's provider serves is
   * the controller's question, because only the controller holds the key and the list discovered with
   * it.
   *
   * Asserted explicitly so nobody reads this validator as the authority and deletes the controller
   * check as redundant. Without it a bot can be configured with a model its provider has never heard
   * of, which fails on every cycle with a provider 404 and pauses the bot for a reason its owner
   * cannot act on.
   */
  for (const passesShapeButNeedsTheController of ["gpt-4o", "claude-sonnet-5", "not-a-model"]) {
    assert.equal(
      personaWith(passesShapeButNeedsTheController).validateSync()?.errors?.model,
      undefined,
      `${passesShapeButNeedsTheController} is the controller's to judge, not the schema's`
    );
  }
});

test("an over-long system prompt is refused", () => {
  // A cap, because the prompt is a per-call cost the owner pays every cycle — and because
  // an unbounded system prompt is a way to push the identity clause out of attention.
  const persona = new BotPersona({ bot: oid(), systemPrompt: "x".repeat(4001) });
  assert.ok(persona.validateSync()?.errors?.systemPrompt);
});

test("every pause reason is a real status, and the default is active", () => {
  assert.equal(new BotPersona({ bot: oid(), systemPrompt: "x".repeat(30) }).status, "active");

  const bad = new BotPersona({ bot: oid(), systemPrompt: "x".repeat(30), status: "asleep" });
  assert.ok(bad.validateSync()?.errors?.status);

  // The states the product must render calmly rather than as errors.
  for (const status of [
    "paused_key_invalid",
    "paused_by_owner",
    "paused_rate_limited",
    // The runner sets this one on a 404 from the provider, so the enum has to accept it or the
    // pause would throw a validation error and leave the bot running against a dead model.
    "paused_model_invalid",
  ]) {
    assert.ok(BOT_STATUSES.includes(status), `${status} must be a known state`);
  }
});

test("a new bot is due immediately but not synchronised", () => {
  // `nextRunAt` defaults to now; the controller jitters it on create. What matters here is
  // that the default exists at all, since a null would never be selected by the runner.
  const persona = new BotPersona({ bot: oid(), systemPrompt: "x".repeat(30) });
  assert.ok(persona.nextRunAt instanceof Date);
});

/* ── Memory ───────────────────────────────────────────────────────────────── */

test("memory uniqueness handles the self-memory without colliding across bots", () => {
  /*
   * `subject: null` is the bot's memory of itself. A single sparse unique index on
   * `{bot, subject}` would index those nulls and let only one bot on the platform ever
   * have one. Two partial indexes instead: one for real subjects, one for the self row.
   */
  const indexes = BotMemory.schema.indexes();

  const perSubject = indexes.find(
    ([spec, o]) => spec.bot === 1 && spec.subject === 1 && o?.unique
  );
  assert.ok(perSubject, "a unique index per (bot, subject)");
  assert.deepEqual(perSubject[1].partialFilterExpression, { subject: { $type: "objectId" } });

  const selfMemory = indexes.find(
    ([spec, o]) => spec.bot === 1 && spec.subject === undefined && o?.unique
  );
  assert.ok(selfMemory, "a unique index for the self-memory");
  assert.deepEqual(selfMemory[1].partialFilterExpression, { subject: null });

  for (const [, options] of indexes) {
    assert.ok(!options?.sparse, "no sparse unique indexes anywhere");
  }
});

/* ── Audit ────────────────────────────────────────────────────────────────── */

test("every action in the agreed space is loggable, including refusals", () => {
  // The twelve actions from the plan, plus the two cycle outcomes.
  for (const action of [
    "scroll_feed", "view_profile", "like_post", "comment_post", "repost_post",
    "quote_post", "follow_user", "send_follow_request", "send_dm", "reply_dm",
    "create_post", "do_nothing", "cycle_skipped", "cycle_failed",
  ]) {
    assert.ok(BOT_ACTIONS.includes(action), `${action} must be loggable`);
  }
});

test("a rejected action is a valid log row, not an error path", () => {
  /*
   * The most useful row in the collection: a bot that *tried* to act and was stopped. Its
   * absence would make a blocked attempt indistinguishable from the model never trying,
   * which is the distinction a prompt-injection post-mortem turns on.
   */
  const entry = new BotActionLog({
    bot: oid(),
    owner: oid(),
    action: "send_dm",
    outcome: "rejected",
    targetType: "User",
    targetId: oid(),
    reason: "target not in perception",
  });
  assert.equal(entry.validateSync(), undefined);
  assert.equal(entry.outcome, "rejected");
});

test("an unknown action can't be logged", () => {
  const entry = new BotActionLog({ bot: oid(), owner: oid(), action: "delete_account" });
  assert.ok(entry.validateSync()?.errors?.action);
});

test("the log defaults to 'executed' and carries cost attribution", () => {
  const entry = new BotActionLog({ bot: oid(), owner: oid(), action: "like_post" });
  assert.equal(entry.outcome, "executed");
  assert.equal(entry.usage.inputTokens, 0);
  assert.equal(entry.usage.model, "");
});
