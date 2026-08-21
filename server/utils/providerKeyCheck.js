import { AUTH_STYLES, providersMatchingKeyShape, providerOf } from "../bots/providers.js";
import { redact } from "./keyVault.js";
import { pinnedGet, pinnedPost } from "./pinnedRequest.js";

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
 * The one-token completion this file was written to avoid, kept for the gateways that leave no
 * choice.
 *
 * `GET /models` is the right probe and stays the first one tried. But it is not universal: a
 * third-party gateway may not implement it, may 404 it, or — AgentRouter does this — may sit behind a
 * WAF that answers an unrecognised client with an HTML challenge page. Without a fallback those keys
 * cannot be added at all, because `checkProviderKey` refuses to store anything it could not verify.
 *
 * ── The HTML-page bug this also closes ──────────────────────────────────────
 *
 * The caller used to read a 2xx as proof on its own and swallow a JSON parse failure with "a valid
 * credential with an unparseable list is still a valid credential". That is true of a provider
 * returning an odd *list*, and false of a WAF challenge served with 200: any key at all, including a
 * typo, would have been stored as valid with no models. A 2xx that is not JSON is not an answer, so
 * it now falls through to here rather than being believed.
 *
 * ── Why the model comes from the owner ──────────────────────────────────────
 *
 * `chat/completions` needs a model id and a gateway with no `/models` gives us nothing to guess
 * with. Picking one would be a hardcoded id that goes stale — the exact failure the old Anthropic
 * probe had. So the owner names one, which is the id their gateway's own docs told them to use, and
 * it buys something a models list would not: gateways commonly scope a key to a subset of models, so
 * a completion proves not just that the credential is real but that it can reach something.
 *
 * `max_tokens: 1` — a fraction of a cent, once per add and once per revalidate.
 *
 * `probedModel` comes back on success so the caller can store *which* model was verified, rather
 * than inferring it from the models list. See the note on it in `botController.revalidateApiKey`:
 * inferring meant picking the alphabetically-first entry of a discovered catalogue, which is not a
 * model anybody claimed this key could reach.
 */
const chatProbe = async (provider, endpoint, key, model, addresses, modelsStatus) => {
  const response = await pinnedPost(
    `${endpoint}/chat/completions`,
    {
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    },
    { headers: authHeadersFor(provider, key), addresses, timeoutMs: TIMEOUT_MS }
  );

  /*
   * The model is returned as the available list. It is the only one we have evidence for, and an
   * empty list would leave the bot form with nothing to offer — which reads as a broken key rather
   * than as a gateway that doesn't publish a catalogue.
   */
  if (response.ok) {
    return { status: "valid", reason: "", models: [model], probedModel: model };
  }

  /*
   * A rate-limited key is a working key — but `models` stays empty, matching the main path.
   * `botController` only overwrites a stored list when this one is non-empty, precisely so a
   * throttled check cannot replace a fifty-model catalogue with the single id it happened to probe.
   */
  if (response.status === 429) {
    return { status: "valid", reason: "Key is valid but currently rate limited.", models: [] };
  }

  let message = "";
  try {
    const body = response.json();
    message = body?.error?.message || body?.error?.code || body?.message || "";
  } catch {
    // An HTML error page. The status is the only signal, which is what the branches below use.
  }

  if (response.status === 401) {
    return {
      status: "invalid",
      reason: redact(message) || "That endpoint rejected this key.",
      models: [],
    };
  }

  /*
   * Both endpoints 404 means the base URL is wrong, not the model.
   *
   * `GET /models` and `POST /chat/completions` are not both absent from anything that speaks this
   * wire format — so two 404s is almost always a base URL missing its version path,
   * `https://agentrouter.org` where `https://agentrouter.org/v1` was meant. Telling that owner to
   * "check the model id" sends them to look at the one thing that isn't wrong.
   */
  if (response.status === 404 && modelsStatus === 404) {
    return {
      status: "unknown",
      reason: "Nothing answered at that endpoint. Check the URL, including its version path.",
      models: [],
    };
  }

  /*
   * 400, 403 and a lone 404 are usually about the *model*, not the key.
   *
   * Gateways scope a key to the models its plan covers and then say so in their own vocabulary —
   * AgentRouter answers `unauthorized_client_error` or `content-blocked` for a model outside the
   * plan, with a valid credential. Reporting that as a bad key would send an owner to rotate a
   * credential that was fine. Still refused, because we have not verified anything, but refused with
   * the sentence that tells them to try a different model id.
   */
  if (response.status === 400 || response.status === 403 || response.status === 404) {
    return {
      status: "invalid",
      reason:
        redact(message) ||
        `That endpoint wouldn't serve "${model}" with this key. Check the model id, and that your plan covers it.`,
      models: [],
    };
  }

  return {
    status: "unknown",
    reason: `That endpoint returned ${response.status}. Try again shortly.`,
    models: [],
  };
};

/**
 * @returns `{ status: "valid" | "invalid" | "unknown", reason: string, models: string[] }`
 *
 * `reason` is safe to show an owner: either the provider's own message or a phrase written here.
 * Passed through `redact` regardless, because provider errors do sometimes echo the request.
 *
 * `probeModel` is optional and only ever used as the fallback described on `chatProbe`. It is
 * additionally *ignored* for any provider whose base URL is in the table, which is a check here and
 * not only in the caller: an earlier version relied on the caller to pass it for the right providers,
 * `revalidateApiKey` passed it for all of them, and an Anthropic key whose `/models` 404'd got an
 * OpenAI-shaped completion request and then a verdict of `invalid`. The rule belongs where the
 * comment claiming it lives.
 */
export const checkProviderKey = async (
  providerId,
  plaintextKey,
  { baseUrl, addresses, probeModel } = {}
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
  /*
   * A provider with no declared shape is exempt, and this is the fix for a bug that was already
   * live.
   *
   * The refusal below reads "this key belongs to someone else", and it can only mean that if we know
   * what *this* provider's keys look like. For a provider whose `keyShape` is `null` we don't — and
   * the answer was coming out backwards. Alibaba issues DashScope keys as `sk-…`, so a correct Qwen
   * key was being refused as an OpenAI key; every OpenAI-compatible gateway reissues credentials in
   * the same shape, so the new provider could never have accepted one at all. In both cases the
   * owner is told to "check you've chosen the right provider" when they already had.
   *
   * A shapeless provider therefore accepts any shape and lets the probe decide, which is what the
   * comment below has always said the probe is for.
   */
  const resembles = provider.keyShape ? providersMatchingKeyShape(key) : [];
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

    /*
     * A usable list is the whole answer. A 2xx that isn't JSON is not — see the note on `chatProbe`
     * for the WAF page that used to be read as a valid key — so it falls through with the statuses
     * that mean "this gateway has no models endpoint".
     */
    if (response.ok) {
      try {
        return { status: "valid", reason: "", models: parseModels(provider, response.json()) };
      } catch {
        // Not JSON. Nothing has been verified yet; `fallback` below decides what to do about it.
      }
    }

    /*
     * "The list is unusable", which is three different responses meaning one thing: a 2xx we could
     * not parse (the WAF page), or a 404/405 saying this endpoint has no models route at all.
     *
     * Named for that rather than for "no models endpoint", which the 2xx case isn't — and it was the
     * name that produced the wrong sentence for it.
     */
    const listUnusable = response.ok || response.status === 404 || response.status === 405;

    /*
     * The one place a second request is worth making, and only for a provider whose endpoint did not
     * come from our own table. A hosted provider answering its own `/models` route with a 404 is
     * telling us something about the provider, not inviting a completion against a URL we chose.
     */
    if (listUnusable && probeModel && provider.baseUrl === null) {
      return chatProbe(provider, endpoint, key, probeModel, addresses, response.status);
    }
    if (listUnusable && provider.baseUrl === null) {
      return {
        status: "unknown",
        reason: "That endpoint didn't return a model list. Name a model to verify the key against.",
        models: [],
      };
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
      const body = response.json();
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
