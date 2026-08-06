/**
 * Every model provider the platform can talk to, in one table.
 *
 * This is the keystone of multi-provider support: the key-validation probe, the model picker, the
 * persona schema, the controller's validation and the Python adapters all read from here. A provider
 * added to this table is a provider the whole feature supports; nothing else needs editing.
 *
 * ── Three adapters, not eight ───────────────────────────────────────────────
 *
 * The wire format is what actually differs, and most providers share one. OpenAI, xAI, Groq,
 * DeepSeek, Moonshot and Alibaba all speak the OpenAI `chat/completions` shape, so `openai` is one
 * adapter serving six providers — and any future provider that speaks it needs a row here and no
 * code at all. Anthropic and Gemini get their own because their tool-calling config genuinely
 * differs.
 *
 * ── The base URL never comes from the owner ─────────────────────────────────
 *
 * An owner picks a provider from this enum; the URL is looked up here. That is not a convenience,
 * it is the SSRF defence: if an owner could type a URL, our server would make authenticated
 * requests to it, and `http://169.254.169.254/` is cloud-metadata credentials while
 * `http://127.0.0.1:27017` is a port scan of our own host from inside the perimeter.
 *
 * It is also exactly why self-hosted endpoints — Ollama, LM Studio, vLLM — are a separate phase
 * rather than another row. They are the one case where the URL *must* come from the owner, and
 * doing that safely needs scheme allowlisting, private-range rejection after DNS resolution to
 * defeat rebinding, and no redirect following. That is a different piece of work from an adapter.
 *
 * ── Forced tool use is not optional ─────────────────────────────────────────
 *
 * Every guarantee in this feature rests on the model being unable to emit anything except a
 * well-formed action from a closed enum. `forcesToolUse` records whether a provider can actually
 * promise that. A provider that cannot is not listed, because the alternative — parsing actions out
 * of prose — reintroduces precisely the injection surface the closed schema exists to remove, and
 * only for the bots least likely to be watched.
 *
 * Support varies by *model* as well as by provider on some of these, which is what `modelCeiling`
 * and runtime discovery below are for.
 */

/**
 * Where the API key goes.
 *
 * Three styles, and they are not interchangeable: Anthropic wants its own header, OpenAI-compatible
 * providers want a bearer token, and Gemini takes it as a header on the REST API. Getting this wrong
 * produces a 401 that looks exactly like a bad key, which would have us telling an owner their
 * credential failed when in fact we sent it in the wrong place.
 */
export const AUTH_STYLES = {
  ANTHROPIC_HEADER: "x-api-key",
  BEARER: "bearer",
  GOOGLE_HEADER: "x-goog-api-key",
};

/**
 * The pattern a key of this kind plausibly matches.
 *
 * Used for two things, neither of them security: telling an owner they have probably pasted an
 * OpenAI key into the Anthropic slot before we spend a round trip finding out, and widening
 * `redact` so no provider's key shape can survive into a log. The real validation is the probe.
 *
 * `null` means the provider has no recognisable prefix — several don't — in which case only length
 * is checked. A pattern that guessed would reject valid keys, which is the worse failure.
 */
const KEY_SHAPES = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,
  xai: /^xai-[A-Za-z0-9_-]{20,}$/,
  groq: /^gsk_[A-Za-z0-9_-]{20,}$/,
  google: /^AIza[A-Za-z0-9_-]{30,}$/,
  deepseek: /^sk-[A-Za-z0-9_-]{20,}$/,
  moonshot: /^sk-[A-Za-z0-9_-]{20,}$/,
  none: null,
};

/**
 * The providers, keyed by the id stored on `ApiKey.provider`.
 *
 * `modelCeiling` is a *pattern*, not a list, and the distinction matters. Model ids churn faster
 * than deploys — every provider in this table has renamed or retired its flagship at least once —
 * so a hardcoded list of exact ids is stale within months and its failure mode is a picker offering
 * a model the provider no longer serves.
 *
 * So the real list is **discovered from the provider** using the owner's own key (see
 * `utils/providerModels.js`), which has the additional virtue of showing only models that key can
 * actually reach. The ceiling here is the safety net around that: a bound on what a discovered or
 * admin-configured id is allowed to look like, so a compromised discovery response cannot point a
 * bot at something arbitrary and expensive.
 */
export const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: AUTH_STYLES.ANTHROPIC_HEADER,
    keyShape: KEY_SHAPES.anthropic,
    forcesToolUse: true,
    /** The dated version header the Messages API requires. Pinned, not tracking latest. */
    extraHeaders: { "anthropic-version": "2023-06-01" },
    modelsPath: "/models",
    modelCeiling: /^claude-[a-z0-9.-]+$/i,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },

  openai: {
    id: "openai",
    label: "OpenAI",
    adapter: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: AUTH_STYLES.BEARER,
    keyShape: KEY_SHAPES.openai,
    forcesToolUse: true,
    modelsPath: "/models",
    // gpt-*, o1/o3/o4-*, chatgpt-*. Deliberately loose: the families change, the shapes don't.
    modelCeiling: /^(gpt|o\d|chatgpt)[a-z0-9._-]*$/i,
    keyUrl: "https://platform.openai.com/api-keys",
  },

  google: {
    id: "google",
    label: "Google Gemini",
    adapter: "gemini",
    /*
     * `v1beta` rather than `v1`, because function calling and `toolConfig` have consistently
     * landed there first and the stable path has lagged. Pinned so the contract can't move under a
     * running deployment.
     */
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: AUTH_STYLES.GOOGLE_HEADER,
    keyShape: KEY_SHAPES.google,
    forcesToolUse: true,
    modelsPath: "/models",
    /*
     * The bare id, without Gemini's `models/` prefix.
     *
     * This used to accept `models/gemini-2.0-flash` as well, on the reasoning that Gemini's own
     * catalogue and documentation print ids that way. It was the wrong tolerance in two directions.
     * `providerKeyCheck.parseModels` strips the prefix before storing, so discovery never produces
     * that form — and `providers.py` checks a bare `gemini-` prefix, so the one path that could
     * produce it, an owner typing the id by hand, passed every check here and was refused by the
     * service as a malformed request. A 422 the owner cannot act on, for writing the id the way the
     * provider's docs show it.
     *
     * Refusing it here instead means they get "that isn't a Google Gemini model" while they are
     * still looking at the field.
     */
    modelCeiling: /^gemini-[a-z0-9.-]+$/i,
    keyUrl: "https://aistudio.google.com/apikey",
  },

  xai: {
    id: "xai",
    label: "xAI Grok",
    adapter: "openai",
    baseUrl: "https://api.x.ai/v1",
    auth: AUTH_STYLES.BEARER,
    keyShape: KEY_SHAPES.xai,
    forcesToolUse: true,
    modelsPath: "/models",
    modelCeiling: /^grok[a-z0-9._-]*$/i,
    keyUrl: "https://console.x.ai",
  },

  groq: {
    id: "groq",
    label: "Groq",
    adapter: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: AUTH_STYLES.BEARER,
    keyShape: KEY_SHAPES.groq,
    /*
     * Groq serves other people's open models, and tool-calling support is a property of the model
     * rather than of Groq. So the provider can force a tool call — the API supports it — but a
     * given model may not honour it, and discovery cannot tell us which. That is the one case where
     * an owner can select something that will fail, and it fails *safely*: no tool block means an
     * empty decision, which the runner records as `do_nothing` rather than acting on prose.
     */
    forcesToolUse: true,
    modelsPath: "/models",
    /*
     * The one provider with no usable prefix, because it serves other people's models:
     * `llama-3.3-70b-versatile`, `qwen/qwen3-32b`, `moonshotai/kimi-k2-instruct`.
     *
     * The first version of this was `^[a-z0-9][a-z0-9._\-/]{2,80}$`, which accepted almost any
     * lowercase token — including `not-a-model`. That mattered far beyond Groq: `BotPersona`'s
     * schema check is the *union* of every provider's ceiling, so one loose member made the whole
     * bound meaningless while still looking like a bound. Worse than useless, and a test caught it.
     *
     * The lookahead is what makes it discriminating: an open catalogue of community models is
     * essentially always versioned or namespaced, so requiring a digit or a slash admits every real
     * id and rejects prose. `gemma2-9b-it` passes, `foo-bar-baz` does not.
     */
    modelCeiling: /^(?=.*[0-9/])[a-z0-9][a-z0-9._\-/]{2,80}$/i,
    keyUrl: "https://console.groq.com/keys",
  },

  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    adapter: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    auth: AUTH_STYLES.BEARER,
    keyShape: KEY_SHAPES.deepseek,
    forcesToolUse: true,
    modelsPath: "/models",
    modelCeiling: /^deepseek[a-z0-9._-]*$/i,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },

  moonshot: {
    id: "moonshot",
    label: "Moonshot Kimi",
    adapter: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: AUTH_STYLES.BEARER,
    keyShape: KEY_SHAPES.moonshot,
    forcesToolUse: true,
    modelsPath: "/models",
    modelCeiling: /^(kimi|moonshot)[a-z0-9._-]*$/i,
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
  },

  /*
   * Qwen, and the one provider in this table whose endpoint is not a single constant.
   *
   * Alibaba's compatible-mode URL is regional, and several of the published forms are templated with
   * a workspace id. Rather than let an owner supply a URL — which is the SSRF door this table exists
   * to keep shut — the region is a *choice from a fixed set*, and `dashscope-us` is the one form that
   * needs no workspace template. Other regions are a matter of adding rows here, each with a URL we
   * control.
   */
  /*
   * A self-hosted, OpenAI-compatible endpoint: Ollama, LM Studio, vLLM, llama.cpp.
   *
   * The only provider whose `baseUrl` is **not** in this table, and the only one where that is safe —
   * see `bots/selfHosted.js` for what makes it so. The URL comes either from the operator's settings
   * or, if they have explicitly enabled it, from the owner with the full SSRF check applied.
   *
   * `auth` is bearer because that is what the OpenAI format expects, but most local runtimes ignore
   * the header entirely. `ApiKey` still requires a value, and that is left alone rather than special
   * cased: a placeholder is a smaller cost than an optional-credential path through code whose whole
   * job is handling credentials carefully.
   *
   * `forcesToolUse` is `true` for the *API* and unknowable for the model. A small local model that
   * cannot honour a forced tool call will return no tool block, which the service reports as an empty
   * decision and the runner records as `do_nothing`. It fails safe and it fails visibly in the
   * activity log — but an owner pointing a 3B model at this should expect a bot that rarely acts.
   */
  self_hosted: {
    id: "self_hosted",
    label: "Self-hosted (Ollama, vLLM, LM Studio)",
    adapter: "openai",
    // Resolved per key. Never a constant, and never from a request body without validation.
    baseUrl: null,
    auth: AUTH_STYLES.BEARER,
    keyShape: KEY_SHAPES.none,
    forcesToolUse: true,
    modelsPath: "/models",
    /*
     * The loosest ceiling in the table, because a local catalogue is whatever the owner pulled:
     * `llama3.2`, `qwen2.5-coder:7b`, `hf.co/user/repo:Q4_K_M`. Colons and slashes are ordinary here.
     * Bounded by character set and length only — the discovered list from `/models` is what actually
     * constrains this, and unlike a hosted provider that list is authoritative because it is the
     * owner's own machine reporting what it has.
     */
    modelCeiling: /^[a-z0-9][a-z0-9._:\-/]{1,90}$/i,
    keyUrl: "https://docs.ollama.com/openai",
  },

  qwen: {
    id: "qwen",
    label: "Alibaba Qwen",
    adapter: "openai",
    baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    auth: AUTH_STYLES.BEARER,
    keyShape: KEY_SHAPES.none,
    forcesToolUse: true,
    modelsPath: "/models",
    modelCeiling: /^(qwen|qwq|qvq)[a-z0-9._-]*$/i,
    keyUrl: "https://bailian.console.alibabacloud.com",
  },
};

/** The ids, for schema enums and validation. */
export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Anthropic stays the default: it is the one provider with a measured eval history behind it. */
export const DEFAULT_PROVIDER = "anthropic";

export const providerOf = (id) => PROVIDERS[id] || null;

/** Providers whose endpoint is supplied rather than looked up. Currently exactly one. */
export const needsEndpoint = (id) => PROVIDERS[id]?.baseUrl === null;

/**
 * The base URL to call for a given key.
 *
 * One function, so no caller has to remember that one provider is different. A self-hosted key
 * without a stored endpoint returns null rather than a broken URL — the runner treats that as a
 * configuration problem and pauses the bot with a reason, which is better than a request to
 * `null/chat/completions`.
 */
export const baseUrlFor = (apiKey) => {
  const provider = providerOf(apiKey?.provider);
  if (!provider) return null;
  if (provider.baseUrl !== null) return provider.baseUrl;
  return apiKey?.baseUrl || null;
};

/**
 * What an owner is shown when choosing a provider. No URLs, no regexes — those are ours.
 */
export const listProvidersForOwner = () =>
  PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDERS[id].label,
    keyUrl: PROVIDERS[id].keyUrl,
  }));

/**
 * Which providers issue keys shaped like this one?
 *
 * ── This replaces a check that refused valid keys ────────────────────────────
 *
 * The previous version answered "does this look like a key for *this* provider", and a `false` from
 * it refused the key outright. Its own comment said it must never be the authority, because "a
 * provider that rotates its prefix must not lock owners out" — and then it was exactly that. Google
 * issues AI Studio keys that do not begin `AIza`, so a correct Gemini key was rejected with "that
 * doesn't look like a Google Gemini key. Check you've chosen the right provider", which is both
 * wrong and confidently misleading. An owner cannot argue with it.
 *
 * The useful half of that check was never the negative. It was the *positive* on a different
 * provider: a key beginning `sk-ant-` in the Gemini slot really is a mistake, and saying so is
 * better than a 401 that reads as "your key is bad". So this reports what the shape resembles and
 * lets the caller decide, and the caller only refuses when the answer names somebody else.
 *
 * Several ids can match one key: `sk-` covers OpenAI, DeepSeek and Moonshot, and every `sk-ant-`
 * key matches OpenAI's pattern too. That ambiguity is why this returns a list rather than a guess.
 */
export const providersMatchingKeyShape = (key) => {
  if (typeof key !== "string") return [];
  const trimmed = key.trim();
  return PROVIDER_IDS.filter((id) => PROVIDERS[id].keyShape?.test(trimmed));
};

/**
 * Is this model id acceptable for this provider?
 *
 * The ceiling, not the list. The list is discovered per key; this bounds what a discovered or
 * admin-supplied id may look like, so neither a compromised discovery response nor a typo in
 * settings can point a bot at an arbitrary — possibly very expensive — model.
 */
export const modelAllowedFor = (providerId, model) => {
  const provider = providerOf(providerId);
  if (!provider || typeof model !== "string" || !model.trim()) return false;
  if (model.length > 100) return false;
  return provider.modelCeiling.test(model.trim());
};

/**
 * Every key shape we know about, as one pattern, for `redact`.
 *
 * Built from the table rather than written out again, because a provider added above with its own
 * prefix must not be a provider whose keys can appear in a log line. That is the failure this
 * derivation exists to make impossible.
 */
export const KEY_REDACTION_SOURCES = [
  ...new Set(
    PROVIDER_IDS.map((id) => PROVIDERS[id].keyShape)
      .filter(Boolean)
      // Strip the anchors: a key inside a sentence has no string boundaries around it.
      .map((pattern) => pattern.source.replace(/^\^/, "").replace(/\$$/, ""))
  ),
];
