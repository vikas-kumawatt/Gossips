import assert from "node:assert";
import test, { beforeEach } from "node:test";

/*
 * Set before the module loads: the vault reads the secret at first use and caches the
 * derived key, so a test that sets it afterwards would derive from whatever was there.
 */
process.env.BYOK_ENCRYPTION_SECRET = "test-secret-of-at-least-32-characters-long";

const {
  encryptSecret,
  decryptSecret,
  keyHint,
  keyFingerprint,
  redact,
  redactDeep,
  __resetDerivedKey,
} = await import("../utils/keyVault.js");

const KEY = "sk-ant-api03-" + "x".repeat(80) + "wXyZ";

beforeEach(() => {
  process.env.BYOK_ENCRYPTION_SECRET = "test-secret-of-at-least-32-characters-long";
  __resetDerivedKey();
});

test("a key round-trips through encryption unchanged", () => {
  assert.equal(decryptSecret(encryptSecret(KEY)), KEY);
});

test("the ciphertext never contains the plaintext", () => {
  // The failure this guards against is a "cipher" that turns out to be an encoding.
  const envelope = encryptSecret(KEY);
  assert.ok(!envelope.includes(KEY));
  assert.ok(!envelope.includes(KEY.slice(20, 60)));
  assert.ok(!Buffer.from(envelope).includes(Buffer.from("sk-ant")));
});

test("encrypting twice gives different ciphertext", () => {
  // A fresh nonce per call. Reuse under GCM is catastrophic, not merely untidy: two
  // messages under one nonce leak their XOR and can forge the authentication tag.
  const a = encryptSecret(KEY);
  const b = encryptSecret(KEY);
  assert.notEqual(a, b);
  assert.notEqual(a.split(".")[1], b.split(".")[1], "the nonce must differ");
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test("the envelope is versioned, so the derivation can change later", () => {
  assert.match(encryptSecret(KEY), /^v1\./);
});

test("THE POINT: every form of tampering fails closed", () => {
  const envelope = encryptSecret(KEY);
  const [v, iv, tag, data] = envelope.split(".");

  const flipped = Buffer.from(data, "base64url");
  flipped[0] ^= 1;

  const cases = {
    "flipped ciphertext byte": [v, iv, tag, flipped.toString("base64url")].join("."),
    "swapped nonce": [v, Buffer.alloc(12, 7).toString("base64url"), tag, data].join("."),
    "zeroed tag": [v, iv, Buffer.alloc(16).toString("base64url"), data].join("."),
    "truncated tag": [v, iv, tag.slice(0, 10), data].join("."),
    "missing tag": [v, iv, "", data].join("."),
    "empty ciphertext": [v, iv, tag, ""].join("."),
    "unknown version": ["v9", iv, tag, data].join("."),
    "too few parts": [v, iv, tag].join("."),
    "not an envelope": "just-a-string",
    "empty string": "",
  };

  for (const [label, bad] of Object.entries(cases)) {
    assert.throws(() => decryptSecret(bad), undefined, `${label} must throw`);
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => decryptSecret(bad), undefined, `${typeof bad} must throw`);
  }
});

test("ciphertext from one secret is unreadable with another", () => {
  const envelope = encryptSecret(KEY);

  process.env.BYOK_ENCRYPTION_SECRET = "a-completely-different-secret-32-chars";
  __resetDerivedKey();

  assert.throws(() => decryptSecret(envelope));
});

test("a missing or too-short secret refuses to encrypt at all", () => {
  // Produced while the secret is still valid, so the only fault under test is the secret.
  const wellFormed = encryptSecret(KEY);
  // No fallback key. A default would mean every deployment that forgot to configure this
  // shares one, and the ciphertext is then readable by anyone holding the source.
  for (const bad of ["", "short", "x".repeat(31)]) {
    process.env.BYOK_ENCRYPTION_SECRET = bad;
    __resetDerivedKey();
    assert.throws(() => encryptSecret(KEY), /BYOK_ENCRYPTION_SECRET/);
    /*
     * A *well-formed* envelope, so this asserts what it means to. With a deliberately
     * malformed one it passed for the wrong reason — the envelope checks fired first and
     * reported "bad iv length", which is exactly the misleading diagnostic the vault now
     * avoids by deriving the key before validating the input.
     */
    assert.throws(() => decryptSecret(wellFormed), /BYOK_ENCRYPTION_SECRET/);
  }
});

test("encrypting nothing is refused rather than stored", () => {
  for (const bad of ["", null, undefined, 0]) {
    assert.throws(() => encryptSecret(bad), /nothing to encrypt/);
  }
});

test("the hint is the last four characters, not the first", () => {
  // Anthropic keys share a fixed leading prefix, so leading characters identify nothing
  // and disclosing more of them only leaks more of the secret.
  assert.equal(keyHint(KEY), "wXyZ");
  assert.ok(!keyHint(KEY).includes("sk"));
  assert.equal(keyHint("abc"), "", "too short to hint at");
  assert.equal(keyHint(null), "");
});

test("the fingerprint is stable, keyed, and not the key", () => {
  const fp = keyFingerprint(KEY);
  assert.equal(fp, keyFingerprint(KEY), "stable across calls");
  assert.notEqual(fp, keyFingerprint(KEY + "1"), "distinguishes keys");
  assert.ok(!fp.includes(KEY.slice(-10)), "reveals nothing of the key");

  // Keyed: a different encryption secret gives a different fingerprint, so a leaked
  // fingerprint from one deployment can't be checked against another's keys.
  process.env.BYOK_ENCRYPTION_SECRET = "another-secret-of-at-least-32-characters";
  __resetDerivedKey();
  assert.notEqual(fp, keyFingerprint(KEY));
});

test("redact scrubs anything key-shaped from a string", () => {
  /*
   * The replacement lost its `sk-` prefix when the feature went multi-provider: a Google key is
   * `AIza…` and an xAI one is `xai-…`, so `sk-***REDACTED***` was actively misleading about what
   * had been scrubbed.
   */
  assert.equal(redact(`auth failed for ${KEY}`), "auth failed for ***REDACTED***");
  assert.ok(!redact(`${KEY} and ${KEY}`).includes("sk-ant-api03"));
  // Not key-shaped, left alone.
  assert.equal(redact("nothing secret here"), "nothing secret here");
  assert.equal(redact("sk-short"), "sk-short");
  assert.equal(redact(null), null);
});

test("THE POINT: every provider's key shape is scrubbed, not just Anthropic's", async () => {
  /*
   * `sk-…` alone covered four of the eight providers and silently missed Google, xAI and Groq —
   * the exact bug that gets discovered by finding a live credential in a log line. The patterns are
   * now derived from `bots/providers.js`, so a provider added there is a provider scrubbed here
   * without anyone remembering to do it.
   *
   * This test asserts the derivation, not a list: it walks the real table.
   */
  const { PROVIDERS, PROVIDER_IDS } = await import("../bots/providers.js");

  const samples = {
    anthropic: `sk-ant-api03-${"x".repeat(40)}`,
    openai: `sk-proj-${"x".repeat(40)}`,
    google: `AIza${"x".repeat(35)}`,
    xai: `xai-${"x".repeat(40)}`,
    groq: `gsk_${"x".repeat(40)}`,
    deepseek: `sk-${"x".repeat(40)}`,
    moonshot: `sk-${"x".repeat(40)}`,
  };

  for (const [providerId, sample] of Object.entries(samples)) {
    const scrubbed = redact(`the provider said: ${sample}`);
    assert.ok(!scrubbed.includes(sample), `${providerId} key survived redaction`);
    assert.match(scrubbed, /REDACTED/);
  }

  /*
   * The prefix-less providers, listed by name so adding one is a decision rather than a default.
   *
   * It has already done its job once: `self_hosted` arrived in the next phase and this assertion
   * failed, which is exactly the prompt it exists to give. Both entries are legitimate — Alibaba
   * issues keys with no distinguishing prefix, and a local runtime usually ignores the key entirely,
   * so its value is often a placeholder.
   *
   * Neither is covered by pattern matching, and that is accepted rather than papered over: a
   * catch-all broad enough to match them also eats request ids and ciphertext out of `statusReason`,
   * which is shown to owners. The other two defences carry them — `select: false` and the `toJSON`
   * strip — and for a self-hosted placeholder there is usually no secret to leak in the first place.
   */
  const prefixless = PROVIDER_IDS.filter((id) => !PROVIDERS[id].keyShape).sort();
  assert.deepEqual(
    prefixless,
    ["qwen", "self_hosted"],
    "a new prefix-less provider needs a decision, not a default"
  );
});

test("redactDeep scrubs by value AND by field name", () => {
  const payload = {
    anthropic_api_key: KEY,
    apiKey: "anything at all",
    Authorization: "Bearer abc",
    message: `request used ${KEY}`,
    nested: { deeper: { secret: KEY, harmless: "fine" } },
    list: [KEY, "fine"],
  };
  const clean = redactDeep(payload);
  const serialised = JSON.stringify(clean);

  assert.ok(!serialised.includes("sk-ant-api03"), "no key survives anywhere");
  assert.equal(clean.anthropic_api_key, "***REDACTED***", "by name");
  assert.equal(clean.apiKey, "***REDACTED***", "by name, even when the value looks innocent");
  assert.equal(clean.Authorization, "***REDACTED***");
  assert.equal(clean.message, "request used ***REDACTED***", "by value");
  assert.equal(clean.nested.deeper.harmless, "fine", "untouched");
  assert.equal(clean.list[0], "***REDACTED***", "inside arrays");
});

test("redactDeep survives an error object and a cycle", () => {
  const err = new Error(`boom with ${KEY}`);
  assert.equal(redactDeep(err).message, "boom with ***REDACTED***");

  const cyclic = { name: "root" };
  cyclic.self = cyclic;
  // Bounded depth, so a logger can never hang on this.
  assert.doesNotThrow(() => JSON.stringify(redactDeep(cyclic)));
});
