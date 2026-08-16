import { AUTH_STYLES, providersMatchingKeyShape, providerOf } from "../bots/providers.js";
import { redact } from "./keyVault.js";
import { pinnedGet } from "./pinnedRequest.js";

/**
 * Is this key real, and does it have credit?
 *
 * Asked once before a key is stored, and again whenever an owner presses revalidate. Generalised
 * from `anthropicKeyCheck.js`, which this replaces: the logic was already provider-shaped — probe,
 * read the status, decide — and only the URL, the auth header and the probe body were Anthropic's.
 *
 * ── The important distinction, carried over unchanged ───────────────────────
 *
 * "Invalid" and "couldn't tell" are different answers, and conflating them is the bug this function
 * exists to avoid. A 401 means the key is genuinely bad and its bots should pause. A timeout, a DNS
 * failure, a 500 or a network blip mean *nothing at all* about the key — and marking it invalid
 * would pause every bot on the platform during an upstream outage, then require every owner to
 * revalidate by hand. `unknown` is returned instead and callers leave the stored state alone.
 *
 * ── A list request, not a completion ────────────────────────────────────────
 *
 * The Anthropic version sent a one-token completion. Every provider in the table exposes a models
 * endpoint, and `GET /models` is better in three ways: it costs nothing rather than a fraction of a
 * cent, it needs no model name — so the probe can't fail because a model id in *our* source was
 * retired, which was a real hazard in the old version — and its response is the list of models this
 * key can actually reach, which is the thing the dashboard needs anyway.
 *
 * The one thing it does not prove is that the account has credit. That shows up on the first real
 * cycle as a 402, which the runner already handles by pausing the bot and telling the owner — so
 * the cost of not knowing at save time is one wasted cycle, against a saved request on every check.
 */

/*
 * Short. An owner is watching a spinner, and a provider that hasn't answered in eight seconds is
 * not going to make the difference between saving the key and not.
 */
const TIMEOUT_MS = 8000;

/** Build the auth headers for a provider. The three styles are not interchangeable. */
export const authHeadersFor = (provider, key) => {
  switch (provider.auth) {
    case AUTH_STYLES.ANTHROPIC_HEADER:
      return { "x-api-key": key, ...(provider.extraHeaders || {}) };
    case AUTH_STYLES.GOOGLE_HEADER:
      return { "x-goog-api-key": key, ...(provider.extraHeaders || {}) };
    case AUTH_STYLES.BEARER:
    default:
      return { authorization: `Bearer ${key}`, ...(provider.extraHeaders || {}) };
  }
};

/**
 * Pull model ids out of whatever shape the provider returned.
 *
 * Three shapes, and none of them is worth a separate adapter for a list of strings:
 * OpenAI-compatible and Anthropic both use `{ data: [{ id }] }`, Gemini uses
 * `{ models: [{ name: "models/gemini-…" }] }`.
 *
 * Filtered through the provider's `modelCeiling`, which is what stops a compromised or unexpected
 * response putting an arbitrary — possibly very expensive — model in front of an owner.
 */
const parseModels = (provider, body) => {
  const raw = Array.isArray(body?.data)
    ? body.data.map((row) => row?.id)
    : Array.isArray(body?.models)
      ? body.models.map((row) => row?.name)
      : [];

  return [
    ...new Set(
      raw
        .filter((id) => typeof id === "string" && id)
        // Gemini prefixes every id with `models/`; store the bare id.
        .map((id) => id.replace(/^models\//, ""))
        .filter((id) => provider.modelCeiling.test(id))
    ),
  ].sort();
};

/**
 * @returns `{ status: "valid" | "invalid" | "unknown", reason: string, models: string[] }`
 *
 * `reason` is safe to show an owner: either the provider's own message or a phrase written here.
 * Passed through `redact` regardless, because provider errors do sometimes echo the request.
 */
export const checkProviderKey = async (
  providerId,
  plaintextKey,
  { baseUrl, addresses } = {}
) => {
  const provider = providerOf(providerId);
  if (!provider) {
    return { status: "invalid", reason: "That provider isn't supported.", models: [] };
  }

  /*
   * The endpoint. `null` in the table means self-hosted, and then the caller must supply one that has
   * already been through `bots/selfHosted.js`. Refusing here rather than defaulting is deliberate: a
   * fallback would be a URL nobody validated.
   */
  const endpoint = provider.baseUrl ?? baseUrl;
  if (!endpoint) {
    return { status: "invalid", reason: "That provider needs an endpoint URL.", models: [] };
  }

  if (typeof plaintextKey !== "string" || plaintextKey.trim().length < 20) {
    return { status: "invalid", reason: "That doesn't look like an API key.", models: [] };
  }

  const key = plaintextKey.trim();

  /*
   * A courtesy, and now actually a courtesy rather than a gate.
   *
   * This used to refuse any key that didn't match the chosen provider's prefix, which locked owners
   * out of Gemini the moment Google started issuing keys that don't begin `AIza`. The prefix table
   * is a guess about how providers format credentials today; the provider itself is the authority,
   * the probe below asks it, and it costs one request.
   *
   * What is still worth refusing without asking is a key that plainly belongs to someone else —
   * `sk-ant-…` in the Gemini slot is a slip, not a rotated format, and a 401 for it reads as "your
   * key is bad" when the key is fine and the slot is wrong.
   */
  const resembles = providersMatchingKeyShape(key);
  if (resembles.length && !resembles.includes(providerId)) {
    // Phrased without an article, so the message doesn't have to know that it is "an OpenAI key"
    // and "a Groq key" — and the list can grow without the grammar going wrong.
    const labels = resembles.map((id) => providerOf(id).label).join(" or ");
    return {
      status: "invalid",
      reason: `That key looks like it belongs to ${labels}, not ${provider.label}. Check you've chosen the right provider.`,
      models: [],
    };
  }

  try {
    /*
     * `pinnedGet` rather than `fetch`, and `addresses` rather than nothing.
     *
     * This request carries the owner's API key to an endpoint they nominated, so
     * it is the one request in this file worth aiming somewhere else. The caller
     * has already had `bots/selfHosted.js` resolve the host and reject every
     * private or reserved address it returned — but the list was then discarded
     * and `fetch` resolved the name again, so a record with a short TTL could
     * answer differently for the request than it did for the check. Connecting
     * to the address that was validated closes that window; the URL still names
     * the hostname, so SNI, certificate validation and the Host header are
     * unchanged.
     *
     * `addresses` is undefined for every provider in the fixed table, whose
     * hostnames are not owner-supplied and have nothing to rebind, and
     * resolution for those is ordinary. Redirects are not followed, for the same
     * reason the previous `redirect: "manual"` said.
     */
    const response = await pinnedGet(`${endpoint}${provider.modelsPath}`, {
      headers: authHeadersFor(provider, key),
      addresses,
      timeoutMs: TIMEOUT_MS,
    });

    if (response.ok) {
      let models = [];
      try {
        models = parseModels(provider, await response.json());
      } catch {
        // A valid credential with an unparseable list is still a valid credential.
      }
      return { status: "valid", reason: "", models };
    }

    /*
     * A rate-limited key is a *working* key. 429 means the provider recognised the credential and
     * is throttling it, which is the one thing that proves it is genuine.
     */
    if (response.status === 429) {
      return {
        status: "valid",
        reason: "Key is valid but currently rate limited.",
        models: [],
      };
    }

    let providerMessage = "";
    try {
      const body = await response.json();
      // OpenAI-compatible and Anthropic use `error.message`; Gemini uses the same under `error`.
      providerMessage = body?.error?.message || body?.message || "";
    } catch {
      // A non-JSON error body tells us nothing extra; the status is the signal.
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: "invalid",
        reason: redact(providerMessage) || `${provider.label} rejected this key.`,
        models: [],
      };
    }

    /*
     * 400 needs reading, not assuming. A `GET /models` request has no body to malform, so a 400
     * here is usually about the account — "credit balance is too low", "billing not configured" —
     * which is a key that cannot be used. Anything else is not attributable to the key.
     */
    if (response.status === 400 || response.status === 402) {
      const looksLikeBilling = /credit|balance|quota|billing|payment|insufficient/i.test(
        providerMessage
      );
      return looksLikeBilling
        ? { status: "invalid", reason: redact(providerMessage), models: [] }
        : {
            status: "unknown",
            reason: redact(providerMessage) || `${provider.label} rejected the check itself.`,
            models: [],
          };
    }

    /*
     * A redirect lands here rather than being followed, and it is treated as unknown: it says
     * nothing about the key, and it may well say something about our base URL being stale.
     */
    if (response.status >= 300 && response.status < 400) {
      return {
        status: "unknown",
        reason: `${provider.label} redirected the check. Try again shortly.`,
        models: [],
      };
    }

    // 5xx and anything else: the provider's problem, not the key's.
    return {
      status: "unknown",
      reason: `${provider.label} returned ${response.status}. Try again shortly.`,
      models: [],
    };
  } catch (error) {
    /*
     * Aborts, DNS failures and socket errors all mean the same thing: we did not get an answer.
     * Never `invalid`.
     */
    return {
      status: "unknown",
      reason:
        error?.name === "AbortError"
          ? `${provider.label} didn't respond in time. Try again shortly.`
          : `Couldn't reach ${provider.label}. Try again shortly.`,
      models: [],
    };
  }
};
