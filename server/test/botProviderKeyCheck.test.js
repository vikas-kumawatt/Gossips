import assert from "node:assert";
import test, { mock } from "node:test";

process.env.BYOK_ENCRYPTION_SECRET = "test-secret-of-at-least-32-characters-long";

/**
 * The key probe — the one request that decides whether a credential is stored.
 *
 * Untested until now, which is how two of the three bugs asserted below survived. Both are the same
 * mistake in different directions: treating a *guess* about a provider as an *answer* about a key.
 * The prefix table guessed which provider a key belonged to and refused correct ones; a 2xx status
 * guessed that a response was a model list and accepted incorrect ones.
 *
 * The HTTP layer is mocked at `pinnedRequest.js` rather than at the socket, because that module's own
 * job — pinning resolution to a validated address — is tested in `botSelfHosted.test.js`, and what
 * matters here is purely how a response is classified.
 */

/** Queued responses, popped per request, so a test can assert a *second* call was or wasn't made. */
let queued = [];
let requests = [];

const respond = ({ status = 200, body, text }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: text ?? JSON.stringify(body ?? {}),
  json: () => JSON.parse(text ?? JSON.stringify(body ?? {})),
});

const serve = (url, options) => {
  requests.push({ url, ...options });
  if (!queued.length) throw new Error(`unexpected request to ${url}`);
  return Promise.resolve(respond(queued.shift()));
};

mock.module("../utils/pinnedRequest.js", {
  namedExports: {
    pinnedRequest: serve,
    pinnedGet: (url, options = {}) => serve(url, { ...options, method: "GET" }),
    pinnedPost: (url, body, options = {}) => serve(url, { ...options, method: "POST", body }),
  },
});

const { checkProviderKey } = await import("../utils/providerKeyCheck.js");

const KEY = `sk-${"x".repeat(40)}`;
const GATEWAY = "https://gateway.example.com/v1";

/** Reset between tests, since the queue is module-level state shared by all of them. */
const given = (...responses) => {
  queued = responses;
  requests = [];
};

/* ── The prefix table is a courtesy, not an authority ─────────────────────── */

test("THE POINT: a provider with no declared key shape accepts an sk- key", async () => {
  /*
   * The bug this pins. `sk-` is OpenAI's, DeepSeek's and Moonshot's shape, so
   * `providersMatchingKeyShape` names all three for any gateway credential — and the guard used to
   * refuse the key on the grounds that it "belongs to" one of them.
   *
   * That was already wrong before this provider existed: Alibaba issues DashScope keys as `sk-…` too,
   * so a correct Qwen key was refused with "check you've chosen the right provider" when the owner
   * had. Both providers are asserted, because the fix is one rule and the regression would be one
   * revert.
   */
  for (const provider of ["openai_compatible", "qwen"]) {
    given({ body: { data: [{ id: "gpt-4o" }] } });
    const result = await checkProviderKey(provider, KEY, { baseUrl: GATEWAY });
    assert.equal(result.status, "valid", `${provider} refused an sk- key`);
  }
});

test("a key that plainly belongs to a named provider is still refused, without a request", async () => {
  // The useful half of the old check. `sk-ant-` in the Gemini slot is a slip, and a 401 for it would
  // read as "your key is bad" when the key is fine and the slot is wrong.
  given();
  const result = await checkProviderKey("google", `sk-ant-api03-${"x".repeat(40)}`);

  assert.equal(result.status, "invalid");
  assert.match(result.reason, /Anthropic/);
  assert.equal(requests.length, 0, "no round trip for a mistake we can see");
});

/* ── A 2xx is not an answer ───────────────────────────────────────────────── */

test("THE POINT: a 2xx that isn't JSON is not a valid key", async () => {
  /*
   * The bug that mattered most, and the reason this file exists.
   *
   * `GET /models` behind a WAF answers an unrecognised client with an HTML challenge page — served,
   * in AgentRouter's case, with a 200. The old code read `response.ok` as proof, then swallowed the
   * parse failure with "a valid credential with an unparseable list is still a valid credential".
   * True of a provider returning an odd list; false of a page that would be returned for *any* key,
   * including a typo. Every such key was stored as valid with no models, and the owner found out from
   * a bot that never posted.
   */
  const waf = { status: 200, text: "<html><body>Verifying your browser…</body></html>" };

  given(waf);
  const gateway = await checkProviderKey("openai_compatible", KEY, { baseUrl: GATEWAY });
  assert.notEqual(gateway.status, "valid");
  assert.equal(gateway.status, "unknown", "not attributable to the key either — nothing was learned");

  /*
   * The same for a first-party provider, which is a deliberate behaviour change and the right
   * direction: a proxy in front of Anthropic answering `/models` with an HTML page used to make any
   * string an addable key. `unknown` means `addApiKey` refuses with a 503 and stores nothing.
   */
  given(waf);
  const hosted = await checkProviderKey("anthropic", `sk-ant-api03-${"x".repeat(40)}`);
  assert.equal(hosted.status, "unknown");
  assert.match(hosted.reason, /returned 200/, "and it says what actually happened");
});

test("a working models endpoint is the whole answer, and costs one request", async () => {
  given({ body: { data: [{ id: "claude-opus-4-6" }, { id: "gpt-4o" }, { id: "nonsense id!" }] } });
  const result = await checkProviderKey("openai_compatible", KEY, {
    baseUrl: GATEWAY,
    // Present, and must go unused: a provider that answers `/models` never needs the fallback.
    probeModel: "gpt-4o",
  });

  assert.equal(result.status, "valid");
  assert.deepEqual(result.models, ["claude-opus-4-6", "gpt-4o"], "filtered through the ceiling");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
});

/* ── The completion fallback ──────────────────────────────────────────────── */

test("THE POINT: a gateway with no models endpoint is verified by a one-token completion", async () => {
  given(
    { status: 405, body: { error: { message: "method not allowed" } } },
    { body: { choices: [{ message: { content: "hi" } }] } }
  );
  const result = await checkProviderKey("openai_compatible", KEY, {
    baseUrl: GATEWAY,
    probeModel: "claude-opus-4-6",
  });

  assert.equal(result.status, "valid");
  /*
   * The probed model becomes the available list. It is the only model we have evidence for, and an
   * empty list would leave the bot form with nothing to offer — which reads as a broken key.
   */
  assert.deepEqual(result.models, ["claude-opus-4-6"]);
  /*
   * And it is reported separately, as *the model a completion succeeded against*, so the caller can
   * store that fact. Inferring it from `availableModels[0]` instead was the bug this replaces: for
   * any key with a real discovered catalogue that is the alphabetically-first entry, which nobody
   * ever verified.
   */
  assert.equal(result.probedModel, "claude-opus-4-6");

  const probe = requests[1];
  assert.equal(probe.url, `${GATEWAY}/chat/completions`);
  assert.equal(probe.method, "POST");
  assert.equal(probe.body.model, "claude-opus-4-6");
  assert.equal(probe.body.max_tokens, 1, "a probe must not be able to cost real money");
});

test("without a model to probe, an absent list is 'couldn't tell' and says what to do", async () => {
  given({ status: 404, body: {} });
  const result = await checkProviderKey("openai_compatible", KEY, { baseUrl: GATEWAY });

  assert.equal(result.status, "unknown", "never invalid — the key was never actually asked about");
  assert.match(result.reason, /model/i, "the owner has to be told what would fix it");
  assert.equal(requests.length, 1, "no completion without a model");
});

test("a gateway refusing the model is not a gateway refusing the key", async () => {
  /*
   * Gateways scope a key to the models its plan covers, then say so in their own vocabulary —
   * AgentRouter answers `unauthorized_client_error` or `content-blocked` with a perfectly valid
   * credential. Reporting that as a bad key would send an owner to rotate one that was fine.
   */
  given(
    { status: 404, body: {} },
    { status: 403, body: { error: { code: "unauthorized_client_error" } } }
  );
  const result = await checkProviderKey("openai_compatible", KEY, {
    baseUrl: GATEWAY,
    probeModel: "gpt-5",
  });

  assert.equal(result.status, "invalid", "refused, because nothing was verified");
  assert.match(result.reason, /unauthorized_client_error/, "the gateway's own wording, not ours");
});

test("a 401 on the completion is a bad key, and an HTML error body doesn't change that", async () => {
  given({ status: 404, body: {} }, { status: 401, text: "<html>Forbidden</html>" });
  const result = await checkProviderKey("openai_compatible", KEY, {
    baseUrl: GATEWAY,
    probeModel: "gpt-4o",
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.reason, "an unparseable body still gets a sentence");
});

test("THE POINT: a first-party provider is never probed by completion, whatever it is passed", async () => {
  /*
   * The regression this exists to stop, and it was live for a while.
   *
   * `revalidateApiKey` passed a probe model for *every* provider — it read `availableModels[0]`, and
   * that is populated for all of them. So an Anthropic key whose `/models` briefly 404'd got an
   * OpenAI-shaped `POST /chat/completions` sent to `api.anthropic.com` under the `x-api-key` header,
   * a guaranteed 404 back, and a verdict of `invalid`. A working key marked dead and its bots paused,
   * over a transient failure — plus an owner-facing sentence calling Anthropic a gateway.
   *
   * The caller is fixed, and so is this: a provider with a URL in the table cannot reach the
   * fallback even when handed a model, because the rule belongs next to the comment claiming it.
   */
  // A key matching no provider's pattern, so the shape guard has no opinion and every provider here
  // gets as far as the probe.
  const shapeless = `zz-${"x".repeat(40)}`;

  for (const provider of ["anthropic", "openai", "google", "qwen"]) {
    given({ status: 404, body: {} });
    const result = await checkProviderKey(provider, shapeless, { probeModel: "some-model" });

    assert.equal(requests.length, 1, `${provider} made a second request`);
    assert.equal(result.status, "unknown", provider);
    // The old wording, which is right for a provider that has no field to fill in.
    assert.match(result.reason, /returned 404/, provider);
  }
});

test("a throttled completion does not shrink a stored catalogue to one entry", async () => {
  /*
   * The main path returns `models: []` on a 429 so that `botController` — which only overwrites when
   * the list is non-empty — leaves a good catalogue alone. The fallback returned `[model]`, which
   * would replace a fifty-model list with the single id it happened to probe.
   */
  given({ status: 405, body: {} }, { status: 429, body: {} });
  const result = await checkProviderKey("openai_compatible", KEY, {
    baseUrl: GATEWAY,
    probeModel: "gpt-4o",
  });

  assert.equal(result.status, "valid", "a throttled key is a working key");
  assert.deepEqual(result.models, [], "nothing to overwrite a real list with");
  assert.ok(!result.probedModel, "and nothing was actually verified against a model");
});

test("both routes 404 means the URL is wrong, and says so instead of blaming the model", async () => {
  /*
   * Nothing that speaks this wire format is missing *both* `/models` and `/chat/completions`. Two
   * 404s is a base URL without its version path — `https://agentrouter.org` where
   * `https://agentrouter.org/v1` was meant — and "check the model id" sends the owner to look at the
   * one thing that isn't wrong.
   */
  given({ status: 404, body: {} }, { status: 404, body: {} });
  const result = await checkProviderKey("openai_compatible", KEY, {
    baseUrl: "https://gateway.example.com",
    probeModel: "gpt-4o",
  });

  assert.equal(result.status, "unknown", "not the key's fault, so not invalid");
  assert.match(result.reason, /endpoint|URL/i);
  assert.doesNotMatch(result.reason, /model id/, "the model is not the thing to check");
});

/* ── The endpoint is not optional for a provider that has none ────────────── */

test("a provider whose endpoint is supplied refuses to be probed without one", async () => {
  given();
  for (const provider of ["openai_compatible", "self_hosted"]) {
    const result = await checkProviderKey(provider, KEY);
    assert.equal(result.status, "invalid", provider);
    assert.match(result.reason, /endpoint/i);
  }
  assert.equal(requests.length, 0, "a missing URL must never become a default one");
});
