import { redact } from "../utils/keyVault.js";

/**
 * The only thing in Node that talks to the Python reasoning service.
 *
 * Small on purpose. Everything hard about the model call — the tool schema, the prompt
 * assembly, the identity clause, the provider's error taxonomy — lives on the Python side and
 * was settled in Phase 4. What is left here is transport, a timeout, and one job that genuinely
 * belongs to the caller: turning an HTTP status into a decision the runner can act on.
 *
 * ── The error classification is the interesting part ────────────────────────
 *
 * The runner has to choose between three very different responses, and getting the choice wrong
 * is expensive in both directions:
 *
 *   · **pause the bot and tell the owner** — their key is dead. Retrying forever would hammer
 *     the provider with a credential that will never work, and the owner would never find out
 *     why their bot went quiet.
 *   · **retry later, change nothing** — a rate limit, a restart, a network blip. Pausing here
 *     would take a bot offline over something that fixed itself in thirty seconds.
 *   · **stop and shout** — *our* configuration is wrong. Not the owner's problem, and not
 *     something a retry can fix.
 *
 * Python already distinguishes these; the mapping below preserves the distinction rather than
 * flattening it into "the request failed". A `401` in particular must never be read as a bad
 * owner key: it means the internal secret is wrong on one side, and treating it as `402` would
 * pause every bot on the platform and notify every owner that their key was invalid.
 *
 * ── The key ─────────────────────────────────────────────────────────────────
 *
 * It passes through this module and is never stored, never logged, and never included in an
 * error. `redact` is applied to every string that could have come back from the far side,
 * because a badly-behaved proxy that echoes a request body would otherwise put a live key in
 * our logs.
 */

const SERVICE_URL = (process.env.PYTHON_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

/**
 * Longer than a model call should take, shorter than a bot's cycle interval.
 *
 * Python applies its own, shorter provider timeout, so reaching this one means Python itself is
 * wedged rather than the provider being slow. The runner is holding a claim on the bot for the
 * whole of it, which is what stops this being generous.
 */
const REQUEST_TIMEOUT_MS = 90 * 1000;

/**
 * Error kinds, in the vocabulary the runner acts on rather than HTTP's.
 *
 * Exported so the runner switches on constants instead of strings, and so a new kind added here
 * breaks the switch rather than silently falling into the default.
 */
export const FAILURE_KINDS = {
  /** The owner's key is invalid or out of credit. Pause the bot, notify the owner. */
  KEY_INVALID: "key_invalid",
  /** Rate limited, restarting, or unreachable. Retry the next cycle. */
  TRANSIENT: "transient",
  /**
   * The model is gone. Pause the bot, tell the owner which one, leave the key alone.
   *
   * The fourth kind, added because a live run showed the other three all being wrong for it. It is
   * the only provider failure the owner can fix themselves without touching their credential.
   */
  MODEL_INVALID: "model_invalid",
  /** Our own misconfiguration — a missing secret, a wrong URL. Not the owner's fault. */
  CONFIG: "config",
  /** We sent something the service rejected. A bug on our side; do not blame the key. */
  BAD_REQUEST: "bad_request",
};

const fail = (kind, error, status = 0) => ({ ok: false, kind, status, error: redact(error) });

/**
 * One POST to the service.
 *
 * @param {string} path `/decide` or `/reply`
 * @param {object} body
 * @returns {Promise<{ok: true, decision: object} | {ok: false, kind: string, status: number, error: string}>}
 */
const post = async (path, body) => {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  /*
   * Checked here as well as in Python. Python returns 503 when its own copy is unset, but if
   * *ours* is missing every request would be rejected as unauthorised — which arrives looking
   * exactly like a security problem instead of a missing variable.
   */
  if (!secret) {
    return fail(FAILURE_KINDS.CONFIG, "INTERNAL_SERVICE_SECRET is not set on the Node side");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": secret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    /*
     * A refused connection, a DNS failure, or our own abort. All transient: the service is
     * restarting, or the box is briefly gone. Pausing a bot because a deploy was in progress
     * would be a self-inflicted outage.
     */
    const aborted = error?.name === "AbortError";
    return fail(
      FAILURE_KINDS.TRANSIENT,
      aborted ? "the reasoning service timed out" : `cannot reach the reasoning service: ${error?.message ?? error}`
    );
  } finally {
    clearTimeout(timer);
  }

  /*
   * The body is read before the status is examined, because the `detail` string is the only
   * explanation the owner will ever see — "Your credit balance is too low" is worth passing
   * through, and a generic "402" is not.
   */
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const detail = typeof payload?.detail === "string" ? payload.detail : "";

  if (response.ok) {
    /*
     * A valid response with a missing `actions` array is treated as an empty decision rather
     * than an error. Python already turns "the model returned no tool call" into an empty list;
     * this covers the shape being wrong for any other reason, and the validator will produce a
     * `do_nothing` from it.
     */
    return { ok: true, decision: { actions: [], reasoning: "", usage: {}, ...(payload ?? {}) } };
  }

  switch (response.status) {
    /*
     * The owner's key. Python returns this for an invalid credential *and* for exhausted
     * credit, because the provider reports the latter as a 400 about the balance rather than a
     * distinct code. Both mean the same thing to a bot: stop, and tell the owner why.
     */
    case 402:
      return fail(FAILURE_KINDS.KEY_INVALID, detail || "the provider rejected this API key", 402);

    /*
     * Our secret, not theirs. The single most important line in this switch: read as a key
     * problem it would pause every bot on the platform and tell every owner their key had
     * failed, over one wrong environment variable.
     */
    case 401:
    case 403:
      return fail(
        FAILURE_KINDS.CONFIG,
        `the reasoning service rejected our internal secret (${response.status})`,
        response.status
      );

    case 422:
    case 400: {
      let message = detail || "the reasoning service rejected the request body";
      if (payload?.fields && Array.isArray(payload.fields)) {
        message += ` (fields: ${payload.fields.join(", ")})`;
      }
      return fail(
        FAILURE_KINDS.BAD_REQUEST,
        message,
        response.status
      );
    }

    /*
     * The model this bot is configured with no longer exists at the provider.
     *
     * Permanent, and not the credential's fault. Sat under `502` until a live Gemini run showed what
     * that meant in practice — retried for ever, bot still "Active", owner never told — so Python
     * gives it a status of its own and the runner pauses on it.
     */
    case 404:
      return fail(FAILURE_KINDS.MODEL_INVALID, detail || "the provider no longer serves this model", 404);

    // Rate limited by the provider, or the provider is down. Both pass.
    case 429:
    case 502:
    case 503:
    case 504:
      return fail(FAILURE_KINDS.TRANSIENT, detail || `the provider is unavailable (${response.status})`, response.status);

    default:
      /*
       * Unrecognised, so treated as transient. The safe direction: a status we have not seen
       * before is much more likely to be a proxy or a deploy than a dead key, and the cost of
       * being wrong is one wasted cycle rather than a paused bot and a false alarm to an owner.
       */
      return fail(
        FAILURE_KINDS.TRANSIENT,
        detail || `unexpected response from the reasoning service (${response.status})`,
        response.status
      );
  }
};

/** The shape both endpoints expect for a persona. Built here so callers can't forget a field. */
const personaPayload = (persona, bot) => ({
  name: bot?.name ?? "",
  username: bot?.username ?? "",
  system_prompt: persona?.systemPrompt ?? "",
  posting_style: persona?.postingStyle ?? "",
});

/**
 * A scheduled cycle: what should this bot do about everything it can see?
 *
 * @param {object} args
 * @param {object} args.bot the bot's `User` row — for its name and handle
 * @param {object} args.persona
 * @param {object} args.perception from `buildPerception`
 * @param {object} args.memory `{ self, about }`
 * @param {string} args.apiKey plaintext, used once and not retained
 */
export const decide = ({ bot, persona, perception, memory, apiKey, provider, baseUrl }) =>
  post("/decide", {
    bot_id: String(bot?._id ?? ""),
    persona: personaPayload(persona, bot),
    perception,
    memory: memory ?? { self: "", about: {} },
    /*
     * The provider, so the service knows which wire format to use. For every hosted provider it also
     * knows the endpoint, from its own copy of the table — a URL is only sent for the self-hosted
     * one, and only after `bots/selfHosted.js` has cleared it.
     */
    provider,
    base_url: provider === "self_hosted" ? baseUrl : undefined,
    model: persona?.model,
    api_key: apiKey,
  });

/**
 * A direct message arrived: reply, or decide not to.
 *
 * Separate endpoint, and separate model. A reply is one conversation rather than a whole
 * perception and someone is waiting on it, so it uses `replyModel` — cheaper and faster, which
 * is the right trade for a single short turn.
 */
export const replyToConversation = ({
  bot,
  persona,
  conversation,
  memory,
  apiKey,
  provider,
  baseUrl,
}) =>
  post("/reply", {
    bot_id: String(bot?._id ?? ""),
    persona: personaPayload(persona, bot),
    conversation,
    memory: memory ?? { self: "", about: {} },
    provider,
    base_url: provider === "self_hosted" ? baseUrl : undefined,
    model: persona?.replyModel,
    api_key: apiKey,
  });

/**
 * Is the service up?
 *
 * Used by the runner at startup to log a clear warning rather than discovering the answer once
 * per bot, and by the owner dashboard in Phase 8. Deliberately does not send the internal
 * secret — `/health` does not require it, and a reachability probe should not need a credential.
 */
export const serviceHealthy = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${SERVICE_URL}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
