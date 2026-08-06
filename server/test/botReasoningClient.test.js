import assert from "node:assert";
import test from "node:test";

/**
 * The Node→Python transport, and the error classification the runner acts on.
 *
 * No module mocking: `fetch` is a global, so it is replaced directly. What is actually under test
 * is the status→kind mapping, because every branch of it leads somewhere expensive. Reading a
 * transient failure as a dead key pauses a working bot and tells its owner their credential
 * failed; reading a dead key as transient hammers the provider forever with a credential that
 * will never work.
 */

process.env.INTERNAL_SERVICE_SECRET = "test-secret-value";
process.env.PYTHON_SERVICE_URL = "http://127.0.0.1:9999/";

const { FAILURE_KINDS, decide, replyToConversation, serviceHealthy } = await import(
  "../bots/reasoningClient.js"
);

const OWNER_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

/** The last request `fetch` was asked to make. */
let lastCall = null;
const originalFetch = globalThis.fetch;

/** Replace fetch with a canned response. */
const respondWith = ({ status = 200, body = {}, throws = null, name = "" } = {}) => {
  globalThis.fetch = async (url, options) => {
    lastCall = { url, options };
    if (throws) {
      const error = new Error(throws);
      if (name) error.name = name;
      throw error;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
};

const restore = () => {
  globalThis.fetch = originalFetch;
  lastCall = null;
};

const persona = {
  systemPrompt: "You are Mira, who bakes.",
  postingStyle: "short, dry",
  model: "claude-sonnet-5",
  replyModel: "claude-haiku-4-5-20251001",
};
const bot = { _id: "507f1f77bcf86cd799439011", username: "mira", name: "Mira" };

const callDecide = () =>
  decide({ bot, persona, perception: { feed_posts: [] }, memory: { self: "", about: {} }, apiKey: OWNER_KEY });

/* ── The request ──────────────────────────────────────────────────────────── */

test("the internal secret rides on the request, and the trailing slash is not doubled", async () => {
  respondWith({ body: { actions: [], reasoning: "" } });
  await callDecide();

  assert.equal(lastCall.url, "http://127.0.0.1:9999/decide", "the configured trailing slash must be stripped");
  assert.equal(lastCall.options.headers["X-Internal-Secret"], "test-secret-value");
  assert.equal(lastCall.options.method, "POST");
  restore();
});

test("the persona and model are assembled here, so a caller cannot forget a field", async () => {
  respondWith({ body: { actions: [] } });
  await callDecide();

  const sent = JSON.parse(lastCall.options.body);
  assert.equal(sent.persona.username, "mira");
  assert.equal(sent.persona.system_prompt, "You are Mira, who bakes.");
  assert.equal(sent.persona.posting_style, "short, dry");
  assert.equal(sent.model, "claude-sonnet-5");
  assert.equal(sent.bot_id, "507f1f77bcf86cd799439011");
  restore();
});

test("a reply uses the reply model, not the cycle model", async () => {
  /*
   * The economics of the two paths differ: a reply is one short turn with someone waiting, so it
   * gets the cheap fast model. Sending `model` here instead of `replyModel` would silently bill
   * every DM at cycle rates.
   */
  respondWith({ body: { actions: [] } });
  await replyToConversation({ bot, persona, conversation: { id: "a:b" }, apiKey: OWNER_KEY });

  const sent = JSON.parse(lastCall.options.body);
  assert.equal(lastCall.url, "http://127.0.0.1:9999/reply");
  assert.equal(sent.model, "claude-haiku-4-5-20251001");
  restore();
});

test("a missing memory becomes an empty one rather than undefined", async () => {
  respondWith({ body: { actions: [] } });
  await decide({ bot, persona, perception: {}, apiKey: OWNER_KEY });
  const sent = JSON.parse(lastCall.options.body);
  assert.deepEqual(sent.memory, { self: "", about: {} });
  restore();
});

/* ── Success ──────────────────────────────────────────────────────────────── */

test("a decision comes back whole, and a missing actions array becomes an empty one", async () => {
  respondWith({ body: { actions: [{ type: "do_nothing" }], reasoning: "quiet", usage: { input_tokens: 12 } } });
  const good = await callDecide();
  assert.equal(good.ok, true);
  assert.equal(good.decision.actions.length, 1);
  assert.equal(good.decision.usage.input_tokens, 12);

  /*
   * A 200 with an unexpected shape is an empty decision, not an error. Python already turns "the
   * model returned no tool call" into an empty list; raising here would record a cycle failure and
   * eventually back off a bot over a refusal.
   */
  respondWith({ body: { unexpected: true } });
  const odd = await callDecide();
  assert.equal(odd.ok, true);
  assert.deepEqual(odd.decision.actions, []);
  restore();
});

/* ── The classification ───────────────────────────────────────────────────── */

test("402 means the owner's key is dead — pause and tell them", async () => {
  respondWith({ status: 402, body: { detail: "Your credit balance is too low" } });
  const result = await callDecide();

  assert.equal(result.ok, false);
  assert.equal(result.kind, FAILURE_KINDS.KEY_INVALID);
  // The provider's own wording survives, because "your balance is low" is actionable and "402" is not.
  assert.match(result.error, /credit balance/);
  restore();
});

test("THE IMPORTANT ONE: 401 is our secret, not the owner's key", async () => {
  /*
   * Read as a key problem, one wrong environment variable would pause every bot on the platform
   * and notify every owner that their credential had failed. `config` is not retried against the
   * key and never touches `ApiKey.isValid`.
   */
  for (const status of [401, 403]) {
    respondWith({ status, body: { detail: "invalid_internal_secret" } });
    const result = await callDecide();
    assert.equal(result.kind, FAILURE_KINDS.CONFIG, `${status} must be a config failure`);
    assert.notEqual(result.kind, FAILURE_KINDS.KEY_INVALID);
  }
  restore();
});

test("THE OTHER IMPORTANT ONE: a retired model is neither the key nor a blip", async () => {
  /*
   * 404 has its own kind because the two neighbouring answers are both wrong for it. Transient
   * retries a model that will never exist again, for ever, with the bot still reading "Active";
   * `key_invalid` marks a working credential dead and sends the owner to regenerate it.
   *
   * A live Gemini run is what turned this from a hypothetical into a bug: Google retires flash
   * models on a schedule, and a key's discovered list can still name one it refuses to serve.
   */
  respondWith({ status: 404, body: { detail: "provider_model_not_found" } });
  const result = await callDecide();

  assert.equal(result.ok, false);
  assert.equal(result.kind, FAILURE_KINDS.MODEL_INVALID);
  assert.notEqual(result.kind, FAILURE_KINDS.TRANSIENT);
  assert.notEqual(result.kind, FAILURE_KINDS.KEY_INVALID);
  assert.equal(result.status, 404);
  restore();
});

test("our own malformed request is our bug, not the owner's", async () => {
  for (const status of [400, 422]) {
    respondWith({ status, body: { detail: "field required" } });
    const result = await callDecide();
    assert.equal(result.kind, FAILURE_KINDS.BAD_REQUEST);
  }
  restore();
});

test("rate limits and outages are transient", async () => {
  for (const status of [429, 502, 503, 504]) {
    respondWith({ status, body: { detail: "later" } });
    const result = await callDecide();
    assert.equal(result.kind, FAILURE_KINDS.TRANSIENT, `${status} must be transient`);
    assert.equal(result.status, status);
  }
  restore();
});

test("an unrecognised status is transient, which is the safe direction", async () => {
  /*
   * A status we have never seen is far more likely to be a proxy or a deploy than a dead key. The
   * cost of guessing wrong this way is one wasted cycle; the other way it is a paused bot and a
   * false alarm to its owner.
   */
  respondWith({ status: 418, body: {} });
  const result = await callDecide();
  assert.equal(result.kind, FAILURE_KINDS.TRANSIENT);
  restore();
});

test("an unreachable service and a timeout are both transient", async () => {
  respondWith({ throws: "ECONNREFUSED" });
  const refused = await callDecide();
  assert.equal(refused.kind, FAILURE_KINDS.TRANSIENT);
  assert.match(refused.error, /cannot reach/);

  respondWith({ throws: "aborted", name: "AbortError" });
  const timedOut = await callDecide();
  assert.equal(timedOut.kind, FAILURE_KINDS.TRANSIENT);
  assert.match(timedOut.error, /timed out/);
  restore();
});

test("a missing internal secret is reported as config, without a request", async () => {
  const saved = process.env.INTERNAL_SERVICE_SECRET;
  delete process.env.INTERNAL_SERVICE_SECRET;
  respondWith({ body: { actions: [] } });
  lastCall = null;

  const result = await callDecide();
  assert.equal(result.kind, FAILURE_KINDS.CONFIG);
  assert.equal(lastCall, null, "there is nothing to ask if we cannot authenticate");

  process.env.INTERNAL_SERVICE_SECRET = saved;
  restore();
});

/* ── The key ──────────────────────────────────────────────────────────────── */

test("the owner's key never appears in an error, even when echoed back at us", async () => {
  /*
   * A badly-behaved proxy that reflects the request body would otherwise put a live credential
   * into our logs, since the `detail` string is passed through to the owner and the console.
   */
  respondWith({ status: 402, body: { detail: `rejected key ${OWNER_KEY}` } });
  const result = await callDecide();

  assert.ok(!result.error.includes(OWNER_KEY), "the key must be redacted out of the reason");
  assert.match(result.error, /REDACTED/);
  restore();
});

/* ── Health ───────────────────────────────────────────────────────────────── */

test("the health probe sends no credential and never throws", async () => {
  respondWith({ status: 200, body: { ok: true } });
  assert.equal(await serviceHealthy(), true);
  assert.equal(lastCall.options?.headers, undefined, "a reachability probe needs no secret");

  respondWith({ throws: "ECONNREFUSED" });
  assert.equal(await serviceHealthy(), false);
  restore();
});
