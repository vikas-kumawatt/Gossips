import crypto from "crypto";
import { KEY_REDACTION_SOURCES } from "../bots/providers.js";

/**
 * Encryption for owner-supplied provider keys (BYOK).
 *
 * An Anthropic key is a bearer credential that spends the owner's money. Three
 * consequences shape this file:
 *
 *   · It is encrypted at rest, so a database dump is not a wallet.
 *   · It is decrypted only in memory, only at the moment of a call, and the plaintext
 *     is never persisted, never logged, never returned by any endpoint.
 *   · Ciphertext is *authenticated*, so a row edited in the database fails to decrypt
 *     rather than silently yielding a different key.
 *
 * ── Why AES-256-GCM and not the HMAC pattern used elsewhere ─────────────────
 *
 * `utils/mediaToken.js` and `utils/chatLock.js` sign with HMAC because they only need
 * integrity — the thing being protected is already public. A provider key needs
 * confidentiality *and* integrity, which is what an AEAD cipher gives in one primitive.
 * GCM is the one in Node's core `crypto` with no dependency, and it fails closed: a
 * wrong key, a flipped byte or a swapped nonce all throw on `final()` instead of
 * returning plausible garbage.
 *
 * ── Key derivation ──────────────────────────────────────────────────────────
 *
 * `BYOK_ENCRYPTION_SECRET` is a passphrase of arbitrary length; AES-256 needs exactly 32
 * bytes. `scrypt` stretches it, with a fixed application salt rather than a per-row one.
 *
 * A per-row salt would be better practice for password hashing, where the threat is an
 * offline dictionary attack against many independent secrets. Here there is one secret,
 * held by the operator, and the salt's job is only domain separation — so a fixed salt
 * costs nothing real and lets the derivation be cached instead of run per decryption.
 * scrypt at these parameters takes ~100ms; doing that on every bot cycle would be a
 * self-inflicted rate limit.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
/*
 * 96 bits, which is the size GCM is specified for. A 12-byte nonce is used directly as
 * the counter block's IV with no rehashing, and any other length forces the
 * implementation to hash it — which is both slower and a step outside the well-analysed
 * parameter set.
 */
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/*
 * Fixed, and versioned by name. If the derivation ever needs to change, the new one gets
 * a new salt and a new `v` prefix below, and both can be read during a migration.
 */
const KDF_SALT = "gossips.byok.v1";
const VERSION = "v1";

/** scrypt's defaults, stated rather than implied. ~100ms and ~16MB per derivation. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

let cachedKey = null;
let cachedFrom = null;

/**
 * The 32-byte AES key, derived once per process per secret.
 *
 * Throws rather than falling back to a default. An encryption secret with a hardcoded
 * fallback is not encryption — every deployment that forgot to set it would share one
 * key, and the ciphertext in their database would be readable by anyone with this
 * source. Failing loudly at the first use is the only safe behaviour.
 */
const derivedKey = () => {
  const secret = process.env.BYOK_ENCRYPTION_SECRET;

  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error(
      "BYOK_ENCRYPTION_SECRET must be set to at least 32 characters. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }

  // Re-derive if the secret changed under us (a test, or a reloaded config).
  if (cachedKey && cachedFrom === secret) return cachedKey;

  cachedKey = crypto.scryptSync(secret, KDF_SALT, KEY_LENGTH, SCRYPT_PARAMS);
  cachedFrom = secret;
  return cachedKey;
};

/** Test seam: forget the derived key so a changed secret takes effect. */
export const __resetDerivedKey = () => {
  cachedKey = null;
  cachedFrom = null;
};

/**
 * Encrypt a provider key for storage.
 *
 * @returns `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * A self-describing string rather than four columns: the version, nonce and tag belong
 * with the ciphertext they authenticate, and a single field cannot be half-migrated or
 * mismatched by a partial update. Base64url so it survives JSON, URLs and logs without
 * escaping — not that it should ever reach a log.
 */
export const encryptSecret = (plaintext) => {
  if (typeof plaintext !== "string" || !plaintext) {
    throw new Error("encryptSecret: nothing to encrypt");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
};

/**
 * Decrypt a stored provider key.
 *
 * Throws on anything that isn't intact and ours: an unknown version, a malformed
 * envelope, a tampered ciphertext, a swapped nonce, or the wrong secret. Callers treat a
 * throw as "this key is unusable", mark it invalid and pause the bot — see the graceful
 * degradation path in the plan. It must never return a partial or wrong plaintext,
 * because the consequence would be an authentication failure against the provider that
 * looks like the owner's key being revoked.
 */
export const decryptSecret = (envelope) => {
  if (typeof envelope !== "string") {
    throw new Error("decryptSecret: not a string");
  }

  /*
   * The secret is checked before the envelope is.
   *
   * Order matters for diagnostics: with `BYOK_ENCRYPTION_SECRET` unset, validating the
   * envelope first reports something like "bad iv length" — which sends an operator to
   * inspect the database when the actual fault is a missing environment variable. A
   * misconfiguration should always announce itself as one, whatever it is handed.
   */
  derivedKey();

  const parts = envelope.split(".");
  if (parts.length !== 4) throw new Error("decryptSecret: malformed envelope");

  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== VERSION) {
    throw new Error(`decryptSecret: unsupported version "${version}"`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");

  /*
   * Lengths checked before use. `createDecipheriv` accepts a wrong-length IV for some
   * algorithms and `setAuthTag` accepts a short tag, which would weaken the
   * authentication this whole function exists to provide.
   */
  if (iv.length !== IV_LENGTH) throw new Error("decryptSecret: bad iv length");
  if (tag.length !== AUTH_TAG_LENGTH) throw new Error("decryptSecret: bad tag length");
  if (!data.length) throw new Error("decryptSecret: empty ciphertext");

  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  // `final()` is what verifies the tag, so both calls have to be inside the try.
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
};

/**
 * The tail of a key, for the owner to recognise which one this is.
 *
 * The *last* four characters, not the first. Anthropic keys begin with a fixed
 * `sk-ant-...` prefix, so leading characters identify nothing and showing more of them
 * only leaks more of the secret. Four is enough to distinguish two keys in a list and
 * short enough to be useless to an attacker.
 *
 * Named `keyPrefix` in the schema because that is what the spec calls it; what it holds
 * is the suffix.
 */
export const keyHint = (plaintext) =>
  typeof plaintext === "string" && plaintext.length >= 4 ? plaintext.slice(-4) : "";

/*
 * A fingerprint, so the same key added twice can be recognised without decrypting.
 *
 * HMAC rather than a bare hash: an unkeyed digest of a credential is offline-guessable
 * for any key format with structure, and `sk-ant-` plus base64 has plenty. Keyed with the
 * same secret, so a fingerprint is only meaningful inside this deployment.
 */
export const keyFingerprint = (plaintext) =>
  crypto
    .createHmac("sha256", derivedKey())
    .update(String(plaintext))
    .digest("base64url");

/*
 * Anything shaped like a provider key, for scrubbing logs and error payloads.
 *
 * Deliberately broad, and at the cost of occasionally redacting a string that merely looks
 * like a key. That trade is the right way round: a false positive costs a confusing log
 * line, a false negative costs a leaked credential.
 *
 * ── Derived from the provider table, not written out again ───────────────────
 *
 * `sk-…` alone covered Anthropic, OpenAI, DeepSeek and Moonshot — and silently missed
 * Google's `AIza…`, xAI's `xai-…` and Groq's `gsk_…`. Multi-provider support turned a
 * hardcoded pattern here into a list that has to be kept in step with a list somewhere
 * else, which is the shape of bug that gets discovered by finding a live key in a log.
 *
 * So the shapes come from `bots/providers.js`, where a provider is added. A provider added
 * there with a new prefix is a provider whose keys are scrubbed here, without anyone
 * remembering to do it.
 *
 * ── No catch-all for prefix-less keys, deliberately ─────────────────────────
 *
 * A generic `[A-Za-z0-9_-]{32,}` would catch Qwen, which has no recognisable prefix. It was
 * written and then removed: `redact` is applied to `statusReason`, which is **shown to the
 * owner in the dashboard**, and a rule that broad eats request ids, ciphertext envelopes,
 * cycle ids and any long token out of the very messages an owner needs in order to fix
 * their key. Trading a legible error for a marginal gain is the wrong way round, because
 * this is not the primary defence in the first place — the plaintext is `select: false`,
 * stripped in `toJSON`, and never passed to a logger. This is the net for a key that leaks
 * into a provider's own error string, and for a prefix-less key those other two still hold.
 */
const KEY_PATTERN = new RegExp(`\\b(?:${KEY_REDACTION_SOURCES.join("|")})\\b`, "g");

/** Replace anything key-shaped in a string. */
export const redact = (text) =>
  typeof text === "string" ? text.replace(KEY_PATTERN, "***REDACTED***") : text;

/**
 * Deep-redact a value for logging: strings scrubbed, and any key whose *name* suggests a
 * secret dropped entirely regardless of its value.
 *
 * Both halves are needed. Pattern matching misses a key stored under a name like
 * `anthropic_api_key` if the value doesn't match the shape — a truncated key, a
 * placeholder, a future format — and name matching misses a key that turns up inside a
 * message string. Together they cover both.
 */
const SECRET_KEY_NAMES = /(api[_-]?key|secret|token|password|authorization|credential)/i;

export const redactDeep = (value, depth = 0) => {
  // Bounded: a cyclic or pathologically nested object must not hang the logger.
  if (depth > 6) return "[depth limit]";

  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message) };
  }

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY_NAMES.test(key) ? "***REDACTED***" : redactDeep(inner, depth + 1);
  }
  return out;
};
