import mongoose from "mongoose";
import User from "../models/User.js";
import UserSettings from "../models/UserSettings.js";
import ApiKey from "../models/ApiKey.js";
import BotPersona, {
  BOT_STATUSES,
  DEFAULT_MODEL,
  DEFAULT_REPLY_MODEL,
} from "../models/BotPersona.js";
import BotMemory from "../models/BotMemory.js";
import BotActionLog from "../models/BotActionLog.js";
import { encryptSecret, keyFingerprint, keyHint } from "../utils/keyVault.js";
import { checkProviderKey } from "../utils/providerKeyCheck.js";
import {
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  listProvidersForOwner,
  modelAllowedFor,
  needsEndpoint,
  providerOf,
} from "../bots/providers.js";
import { ENDPOINT_SOURCE, assertSafeEndpoint, checkEndpointShape } from "../bots/selfHosted.js";
import { validateUsernameFormat, normalizeUsername } from "../utils/username.js";
import { isReserved } from "../utils/reservedUsernames.js";
import { getSettings } from "../utils/settings.js";
import { ok, created, fail, serverError } from "../utils/respond.js";
import { getChats, getMessages } from "./chatController.js";

/**
 * Owner-facing management of BYOK keys and bot accounts.
 *
 * Everything here is scoped to `req.user.id` as the owner. There is no admin path and no
 * cross-owner read: every query filters on `owner`, so an id belonging to someone else is
 * a 404 rather than a 403 — the same reason `unsendMessage` returns 404 for a message you
 * don't own, since a distinct status would confirm that the id exists.
 */

/**
 * The cap, from `AppSettings.maxBotsPerOwner` — an operator lever, not a constant.
 *
 * Enforced on `owner` rather than per key, so adding a second key doesn't buy a second
 * allowance. `0` is a meaningful value: it stops new bots being created without disturbing
 * the ones that exist.
 */
const botLimit = async () => {
  const settings = await getSettings();
  const configured = settings?.maxBotsPerOwner;
  // A settings document that predates this field must not read as a limit of zero.
  return Number.isFinite(configured) ? configured : 5;
};

const isId = (value) => mongoose.isValidObjectId(value);

/* ── Keys ─────────────────────────────────────────────────────────────────── */

/**
 * Add a key.
 *
 * Validated against the provider *before* it is stored, so a mistyped or already-revoked
 * key is refused at the point the owner can still fix it, rather than silently producing a
 * bot that never acts.
 *
 * The plaintext exists in three places for the life of this function — the request body,
 * the probe call, and the encrypt call — and nowhere else, ever. It is not logged, not
 * echoed in the response, and not returned by any later read.
 */
export const addApiKey = async (req, res) => {
  try {
    const { key, label, provider: requestedProvider } = req.body || {};

    if (typeof key !== "string" || !key.trim()) {
      return fail(res, "An API key is required");
    }
    const plaintext = key.trim();
    if (plaintext.length > 500) {
      return fail(res, "That doesn't look like an API key");
    }

    /*
     * Which provider this key is for.
     *
     * Defaulted rather than required, so a client written before multi-provider support still works
     * and lands on Anthropic — which is what those clients meant.
     *
     * Note what is *not* accepted: a base URL. The owner names a provider and the URL is looked up
     * from `bots/providers.js`, because a URL from a request body is a URL our server would then make
     * an authenticated call to. See the SSRF note there.
     */
    const provider = requestedProvider === undefined ? DEFAULT_PROVIDER : requestedProvider;
    if (!PROVIDER_IDS.includes(provider)) {
      return fail(res, `provider must be one of: ${PROVIDER_IDS.join(", ")}`);
    }

    /*
     * ── The endpoint, for the one provider that needs one ─────────────────────
     *
     * Two paths, and which one applies is decided here rather than by the owner. If the URL matches
     * something the operator published, it is an operator endpoint and its private address is fine.
     * Otherwise it is owner-supplied, which requires the operator to have opted in and gets the full
     * SSRF check — https, no credentials, publicly-resolving only.
     *
     * An owner cannot promote their own URL by claiming a source: `endpointSource` is derived from
     * whether the URL is on the operator's list, never read from the request.
     */
    let endpoint = "";
    let endpointSource = "";
    if (needsEndpoint(provider)) {
      const settings = await getSettings();
      const published = settings?.botSelfHostedEndpoints || [];
      const requested = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";

      if (!requested) {
        return fail(res, "Choose an endpoint for this self-hosted provider");
      }

      const normalised = checkEndpointShape(requested, ENDPOINT_SOURCE.OPERATOR);
      const isPublished = normalised.ok && published.includes(normalised.url);

      if (isPublished) {
        endpoint = normalised.url;
        endpointSource = ENDPOINT_SOURCE.OPERATOR;
      } else {
        if (!settings?.botAllowCustomEndpoints) {
          return fail(res, "Choose one of the endpoints offered by this server");
        }
        const checked = await assertSafeEndpoint(requested, ENDPOINT_SOURCE.OWNER);
        if (!checked.ok) return fail(res, checked.error);
        endpoint = checked.url;
        endpointSource = ENDPOINT_SOURCE.OWNER;
      }
    } else if (req.body?.baseUrl) {
      /*
       * Refused rather than ignored. A `baseUrl` stored against a hosted provider is a field some
       * future caller might start honouring, which is how a validated URL becomes an arbitrary one.
       */
      return fail(res, "That provider's endpoint isn't configurable");
    }

    /*
     * The duplicate check runs before the provider call.
     *
     * Re-adding a key you already have is the most likely mistake, and it would otherwise
     * cost a provider round trip before failing on the unique index — with a raw E11000
     * that says nothing useful to the owner.
     */
    const fingerprint = keyFingerprint(plaintext);
    const existing = await ApiKey.findOne({
      owner: req.user.id,
      fingerprint,
      revokedAt: null,
    }).select("_id label");
    if (existing) {
      return fail(res, `You've already added this key${existing.label ? ` as "${existing.label}"` : ""}`);
    }

    const check = await checkProviderKey(provider, plaintext, { baseUrl: endpoint });
    if (check.status === "invalid") {
      return fail(res, check.reason || "The provider rejected this key");
    }
    /*
     * `unknown` is refused too, but with different wording and without recording anything.
     *
     * Storing a key we couldn't verify would mean an owner walks away believing their bots
     * are configured, and finds out otherwise from a bot that never posts. Asking them to
     * retry a transient failure is the honest outcome.
     */
    if (check.status === "unknown") {
      return fail(res, check.reason || "Couldn't verify that key just now — try again", 503);
    }

    const apiKey = await ApiKey.create({
      owner: req.user.id,
      provider,
      baseUrl: endpoint,
      endpointSource,
      encryptedKey: encryptSecret(plaintext),
      fingerprint,
      keyHint: keyHint(plaintext),
      label: typeof label === "string" ? label.trim().slice(0, 60) : "",
      isValid: true,
      lastValidatedAt: new Date(),
      lastError: "",
      /*
       * The models this key can reach, straight from the provider's own list. Stored so the bot
       * form can offer them without a second round trip, and refreshed on every revalidate — a
       * list this stale is a list offering a retired model.
       */
      availableModels: check.models,
      modelsFetchedAt: check.models.length ? new Date() : null,
    });

    return created(res, { key: apiKey.toOwnerView() });
  } catch (error) {
    /*
     * A duplicate can still land here if two requests race past the check above. The
     * unique partial index is the real guarantee; this turns its error into a sentence.
     */
    if (error?.code === 11000) {
      return fail(res, "You've already added this key");
    }
    return serverError(res, error, "Couldn't add that key");
  }
};

/** The owner's keys. Live ones first; revoked ones stay listed so history makes sense. */
export const listApiKeys = async (req, res) => {
  try {
    const keys = await ApiKey.find({ owner: req.user.id }).sort({
      revokedAt: 1,
      createdAt: -1,
    });

    /*
     * `toOwnerView` per document rather than returning the array.
     *
     * `select: false` and the `toJSON` transform both already keep the ciphertext out, but
     * an explicit allowlist is the only version of this that stays correct when a field is
     * added to the schema later. The other two mechanisms are denials; this one is a
     * permission.
     */
    /*
     * The provider list rides along, because this is the page that adds a key and it would
     * otherwise need a second request to know what it may offer. Labels and sign-up links only —
     * base URLs and key patterns stay server-side.
     */
    const settings = await getSettings();
    return ok(res, {
      keys: keys.map((k) => k.toOwnerView()),
      providers: listProvidersForOwner(),
      /*
       * What the self-hosted provider may point at. The operator's published endpoints, and whether an
       * owner may type their own — so the form can offer a picker rather than a free-text field that
       * is usually refused.
       */
      selfHostedEndpoints: settings?.botSelfHostedEndpoints || [],
      allowCustomEndpoints: Boolean(settings?.botAllowCustomEndpoints),
    });
  } catch (error) {
    return serverError(res, error, "Couldn't load your keys");
  }
};

/** Rename a key. The label is the only mutable field — a key's *value* is never edited. */
export const updateApiKey = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, "Key not found", 404);
    const { label } = req.body || {};
    if (typeof label !== "string") return fail(res, "A label is required");

    const apiKey = await ApiKey.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.id },
      { $set: { label: label.trim().slice(0, 60) } },
      { new: true }
    );
    if (!apiKey) return fail(res, "Key not found", 404);

    return ok(res, { key: apiKey.toOwnerView() });
  } catch (error) {
    return serverError(res, error, "Couldn't update that key");
  }
};

/**
 * Revoke a key.
 *
 * Soft, and it pauses rather than deletes. The bots that used this key keep their profiles,
 * posts, memories and history — they stop generating new activity and their owner is asked
 * to reassign. Deleting them would destroy content other people have interacted with, to
 * undo a billing decision.
 */
export const revokeApiKey = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, "Key not found", 404);

    const apiKey = await ApiKey.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.id, revokedAt: null },
      { $set: { revokedAt: new Date(), isValid: false } },
      { new: true }
    );
    if (!apiKey) return fail(res, "Key not found", 404);

    const bots = await User.find({ owner: req.user.id, isBot: true, apiKey: apiKey._id })
      .select("_id")
      .lean();
    const botIds = bots.map((b) => b._id);

    if (botIds.length) {
      await BotPersona.updateMany(
        { bot: { $in: botIds } },
        {
          $set: {
            status: "paused_key_invalid",
            statusReason: "The API key this bot used was revoked. Assign another to resume.",
          },
        }
      );
    }

    return ok(res, {
      key: apiKey.toOwnerView(),
      pausedBots: botIds.length,
    });
  } catch (error) {
    return serverError(res, error, "Couldn't revoke that key");
  }
};

/**
 * Re-check a key against the provider.
 *
 * The manual version of what a failed bot cycle does automatically, for an owner who has
 * just topped up their credit and doesn't want to wait for the next cycle to find out.
 *
 * A successful revalidation also un-pauses the bots that this key paused — but only those,
 * and only if that is *why* they were paused. A bot the owner paused deliberately, or one
 * an admin paused, stays paused: resuming it would silently overturn someone's decision.
 */
export const revalidateApiKey = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, "Key not found", 404);

    const apiKey = await ApiKey.findOne({
      _id: req.params.id,
      owner: req.user.id,
      revokedAt: null,
    }).select("+encryptedKey +baseUrl");
    if (!apiKey) return fail(res, "Key not found", 404);

    let plaintext;
    try {
      // Imported lazily so a decrypt failure is attributable to this line in a stack trace.
      const { decryptSecret } = await import("../utils/keyVault.js");
      plaintext = decryptSecret(apiKey.encryptedKey);
    } catch {
      /*
       * Undecryptable ciphertext means the encryption secret changed, or the row was
       * altered. Neither is recoverable and neither is the owner's fault — but the key is
       * unusable either way, so it is marked invalid and they are told to re-add it.
       */
      apiKey.isValid = false;
      apiKey.lastError = "This key can no longer be read and must be re-added.";
      apiKey.lastValidatedAt = new Date();
      await apiKey.save();
      return fail(res, apiKey.lastError, 409);
    }

    /*
     * An owner-supplied endpoint is re-checked here, not trusted from when it was saved. A name that
     * resolved publicly then can resolve to loopback now, and "revalidate" is exactly the moment to
     * find that out. The operator's own endpoints skip it — they own the network.
     */
    if (apiKey.endpointSource === ENDPOINT_SOURCE.OWNER) {
      const recheck = await assertSafeEndpoint(apiKey.baseUrl, ENDPOINT_SOURCE.OWNER);
      if (!recheck.ok) {
        apiKey.isValid = false;
        apiKey.lastError = recheck.error;
        apiKey.lastValidatedAt = new Date();
        await apiKey.save();
        return fail(res, recheck.error, 409);
      }
    }

    const check = await checkProviderKey(apiKey.provider, plaintext, { baseUrl: apiKey.baseUrl });

    // `unknown` leaves the stored state untouched — see providerKeyCheck.js.
    if (check.status === "unknown") {
      return fail(res, check.reason, 503);
    }

    apiKey.isValid = check.status === "valid";
    apiKey.lastError = check.status === "valid" ? "" : check.reason;
    apiKey.lastValidatedAt = new Date();
    /*
     * Refreshed, which is half the point of revalidating. Providers retire models, and an owner
     * pressing this after their bot started failing wants the *current* list — not the one captured
     * whenever the key was added. Only overwritten when the provider actually returned something,
     * so a rate-limited check doesn't blank a good list.
     */
    if (check.models.length) {
      apiKey.availableModels = check.models;
      apiKey.modelsFetchedAt = new Date();
    }
    await apiKey.save();

    let resumedBots = 0;
    if (apiKey.isValid) {
      const bots = await User.find({ owner: req.user.id, isBot: true, apiKey: apiKey._id })
        .select("_id")
        .lean();
      if (bots.length) {
        const result = await BotPersona.updateMany(
          { bot: { $in: bots.map((b) => b._id) }, status: "paused_key_invalid" },
          { $set: { status: "active", statusReason: "", nextRunAt: new Date() } }
        );
        resumedBots = result.modifiedCount || 0;
      }
    }

    return ok(res, { key: apiKey.toOwnerView(), resumedBots });
  } catch (error) {
    return serverError(res, error, "Couldn't revalidate that key");
  }
};

/* ── Bots ─────────────────────────────────────────────────────────────────── */

/**
 * Is this model one the given key can actually be used with?
 *
 * Two checks, in order of confidence.
 *
 * The **ceiling** is a pattern from `bots/providers.js` and always applies: `gpt-4o` on an Anthropic
 * key is refused here, which is the mistake an owner is most likely to make after switching keys.
 *
 * The **discovered list** is the precise check, and it is deliberately skipped when empty. Discovery
 * can fail for reasons that say nothing about the key — a rate-limited check, a provider that
 * changed its list format — and treating an empty list as "no models are allowed" would lock an
 * owner out of creating any bot at all because of a transient failure somewhere else.
 *
 * @returns an error string, or null
 */
const modelProblem = (apiKey, field, value) => {
  const provider = providerOf(apiKey.provider);
  const label = provider?.label || apiKey.provider;

  if (!modelAllowedFor(apiKey.provider, value)) {
    return `${value} isn't a ${label} model. Check the model matches the key you've chosen.`;
  }

  const available = apiKey.availableModels || [];
  if (available.length && !available.includes(value)) {
    /*
     * A few examples rather than the whole list: some providers return well over a hundred, and an
     * error message is not a picker. The dashboard has the full list.
     */
    return `${label} didn't list ${value} for this key. Available include: ${available.slice(0, 5).join(", ")}.`;
  }

  return null;
};

/**
 * Resolve the two model fields against a key, or explain why not.
 *
 * ── There is no default model for a provider we haven't met ──────────────────
 *
 * `DEFAULT_MODEL` is a Claude id, and quietly applying it to an OpenAI key would create a bot that
 * fails on every cycle with a provider 404 — then pauses itself for a reason its owner cannot act
 * on. That is the direct consequence of not hardcoding model lists, and the honest resolution is to
 * ask: for any provider but Anthropic, a model must be chosen explicitly.
 *
 * @returns `{ ok: true, model, replyModel }` or `{ ok: false, error }`
 */
const resolveModels = (apiKey, { model, replyModel }) => {
  const provider = providerOf(apiKey.provider);
  const label = provider?.label || apiKey.provider;
  const isAnthropic = apiKey.provider === "anthropic";

  const resolved = {};
  for (const [field, value, fallback] of [
    ["model", model, DEFAULT_MODEL],
    ["replyModel", replyModel, DEFAULT_REPLY_MODEL],
  ]) {
    if (value === undefined || value === null || value === "") {
      if (!isAnthropic) {
        return { ok: false, error: `Choose a ${field === "model" ? "model" : "reply model"} for your ${label} key.` };
      }
      resolved[field] = fallback;
      continue;
    }
    if (typeof value !== "string") return { ok: false, error: `${field} must be a model name` };

    const problem = modelProblem(apiKey, field, value.trim());
    if (problem) return { ok: false, error: problem };
    resolved[field] = value.trim();
  }

  return { ok: true, ...resolved };
};

/** What an owner sees about their own bot. Never includes the persona's prompt in a list. */
const botSummary = (bot, persona) => ({
  _id: bot._id,
  username: bot.username,
  name: bot.name,
  profilePic: bot.profilePic,
  bio: bot.bio,
  isPrivate: bot.isPrivate,
  createdAt: bot.createdAt,
  apiKey: bot.apiKey,
  persona: persona
    ? {
        status: persona.status,
        statusReason: persona.statusReason,
        model: persona.model,
        replyModel: persona.replyModel,
        postsPerDay: persona.postsPerDay,
        interests: persona.interests,
        activeHours: persona.activeHours,
        lastRunAt: persona.lastRunAt,
        nextRunAt: persona.nextRunAt,
      }
    : null,
});

export const listBots = async (req, res) => {
  try {
    const bots = await User.find({ owner: req.user.id, isBot: true })
      .select("username name profilePic bio isPrivate apiKey createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const personas = await BotPersona.find({ bot: { $in: bots.map((b) => b._id) } }).lean();
    const byBot = new Map(personas.map((p) => [String(p.bot), p]));

    const limit = await botLimit();
    return ok(res, {
      bots: bots.map((bot) => botSummary(bot, byBot.get(String(bot._id)))),
      limit,
      remaining: Math.max(0, limit - bots.length),
      /*
       * The providers travel with the payload; the *models* no longer do.
       *
       * This used to send `ALLOWED_MODELS` — three Claude ids. With eight providers there is no
       * single model list to send: which models exist depends on the key, so the picker reads
       * `availableModels` off whichever key the owner selects, discovered from that provider with
       * that key. That is the design that cannot go stale.
       *
       * No URLs and no key patterns are included. Those are ours — see the SSRF note in
       * providers.js.
       */
      providers: listProvidersForOwner(),
      /*
       * Kept only as the Anthropic default, and named so. There is deliberately no default for the
       * other providers: applying a Claude id to an OpenAI key would create a bot that 404s every
       * cycle and then pauses itself for a reason its owner can't act on.
       */
      anthropicDefaults: { model: DEFAULT_MODEL, replyModel: DEFAULT_REPLY_MODEL },
    });
  } catch (error) {
    return serverError(res, error, "Couldn't load your bots");
  }
};

/** One bot, including its prompt — the edit view. */
export const getBot = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, "Bot not found", 404);

    const bot = await User.findOne({ _id: req.params.id, owner: req.user.id, isBot: true })
      .select("username name profilePic bio isPrivate apiKey createdAt")
      .lean();
    if (!bot) return fail(res, "Bot not found", 404);

    const persona = await BotPersona.findOne({ bot: bot._id }).lean();

    return ok(res, {
      bot: {
        ...botSummary(bot, persona),
        // Only on the single-bot read: it's large, and a list of five would carry 20KB.
        systemPrompt: persona?.systemPrompt || "",
        postingStyle: persona?.postingStyle || "",
      },
    });
  } catch (error) {
    return serverError(res, error, "Couldn't load that bot");
  }
};

/**
 * Create a bot.
 *
 * Not the signup flow. There is no email, no password, no verification loop and no
 * session — see `utils/botAccounts.js` for why that separation is enforced in the auth
 * queries rather than trusted to happen.
 */
export const createBot = async (req, res) => {
  try {
    const {
      username,
      name,
      bio,
      profilePic,
      systemPrompt,
      postingStyle,
      interests,
      postsPerDay,
      activeHours,
      model,
      replyModel,
      apiKeyId,
      isPrivate,
    } = req.body || {};

    /*
     * The cap, counted at the moment of creation.
     *
     * Racy in principle — two simultaneous creates could both see four — and deliberately
     * not solved with a lock. The consequence of losing that race is a sixth bot, which is
     * a quota accounting error, not a security boundary; a transaction or a distributed
     * lock to prevent it would be more machinery than the problem deserves. The count is
     * re-checked on every subsequent create, so the state self-corrects rather than
     * compounding.
     */
    const limit = await botLimit();
    if (limit <= 0) {
      return fail(res, "Bot accounts are currently disabled", 403);
    }
    const botCount = await User.countDocuments({ owner: req.user.id, isBot: true });
    if (botCount >= limit) {
      return fail(res, `You can have at most ${limit} bot${limit === 1 ? "" : "s"}`, 403);
    }

    if (typeof systemPrompt !== "string" || systemPrompt.trim().length < 20) {
      return fail(res, "A system prompt of at least 20 characters is required");
    }
    if (systemPrompt.length > 4000) {
      return fail(res, "The system prompt must be 4000 characters or fewer");
    }

    // The key must belong to this owner, be live, and be known-good.
    if (!isId(apiKeyId)) return fail(res, "Choose an API key for this bot");
    const apiKey = await ApiKey.findOne({
      _id: apiKeyId,
      owner: req.user.id,
      revokedAt: null,
    }).select("_id isValid provider availableModels");
    if (!apiKey) return fail(res, "That API key doesn't exist");
    if (!apiKey.isValid) return fail(res, "That API key is not currently valid");

    /*
     * The username goes through the same validator and the same reserved list a human's
     * does. A bot that could claim `admin` or `support` would be an impersonation surface,
     * and the disclosure badge does not undo a handle that reads as official.
     */
    const handle = normalizeUsername(username || "");
    const formatError = validateUsernameFormat(handle);
    if (formatError) return fail(res, formatError);
    if (await isReserved(handle)) return fail(res, "That username isn't available");
    if (await User.exists({ username: handle })) {
      return fail(res, "That username is taken");
    }

    /*
     * Validated against *this key's* provider, not a global list. Which models are legal is a
     * property of the key, so this check needs the key in hand — which is why it lives here and not
     * in the schema.
     */
    const models = resolveModels(apiKey, { model, replyModel });
    if (!models.ok) return fail(res, models.error);

    /*
     * The bot carries its owner's email address.
     *
     * The owner is the accountable contact: anything the platform would ever send about a
     * bot — its key expired, it was paused, it was reported — is addressed to the person
     * who runs it, because there is nobody else to tell. Giving the row the same address as
     * that person is the honest representation of that, and it means a support query about a
     * bot resolves to a real human by the same lookup as any other account.
     *
     * Several rows therefore share one address, which is why `users.email` is unique among
     * humans only — see the partial index in models/User.js and the migration that installs
     * it. **That migration must have run**, or this create fails on the old global index.
     *
     * Nothing can log in with it. `HUMAN_ACCOUNT` excludes bots from every credential
     * lookup, so a password reset or a Google sign-in on this address resolves to the owner
     * and never to the bot. `isEmailVerified` stays false: the *owner's* address is
     * verified, on the owner's row, and a bot has verified nothing.
     */
    const ownerAccount = await User.findById(req.user.id).select("email").lean();
    if (!ownerAccount?.email) {
      return fail(res, "Your account needs an email address before you can create a bot");
    }

    const bot = await User.create({
      email: ownerAccount.email,
      username: handle,
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 50) : handle,
      bio: typeof bio === "string" ? bio.trim().slice(0, 300) : "",
      profilePic: typeof profilePic === "string" ? profilePic : undefined,
      isPrivate: Boolean(isPrivate),
      isBot: true,
      owner: req.user.id,
      apiKey: apiKey._id,
      /*
       * No password, no email. The schema allows both to be absent, and the auth queries
       * exclude `isBot` accounts outright, so there is nothing here to log in with.
       */
    });

    /*
     * The account exists from here on, so every later failure has to undo it.
     *
     * Three inserts and no transaction — which is a reasonable trade for three inserts, but only
     * with this block. Without it, a failure at either of the next two steps leaves a user row
     * that holds the username and has no persona: the owner's obvious next move is to retry the
     * same handle, and it is refused as taken. Meanwhile the row sits in their list as a bot the
     * runner will never claim, because the runner claims out of `BotPersona`.
     *
     * A compensating delete, not a transaction. It is not atomic — a process killed between the
     * throw and the delete still leaves the orphan — but it covers every failure the application
     * can actually see, which is all of them except power loss.
     */
    try {
      /*
       * Every account in this app has a settings row — `authController` creates one on both
       * signup paths, and `chatController` lazily creates one when it finds none. A bot
       * without one would work by accident, via that lazy path, on whichever request happened
       * to need it first.
       */
      await UserSettings.create({ user: bot._id });

      const persona = await BotPersona.create({
        bot: bot._id,
        systemPrompt: systemPrompt.trim(),
        postingStyle: typeof postingStyle === "string" ? postingStyle.trim().slice(0, 500) : "",
        interests: Array.isArray(interests)
          ? interests.filter((i) => typeof i === "string").slice(0, 20).map((i) => i.trim().slice(0, 40))
          : [],
        postsPerDay: Number.isFinite(postsPerDay) ? Math.min(12, Math.max(0, postsPerDay)) : 1,
        activeHours: {
          startHour: Number.isFinite(activeHours?.startHour) ? activeHours.startHour : 8,
          endHour: Number.isFinite(activeHours?.endHour) ? activeHours.endHour : 23,
          timezone: typeof activeHours?.timezone === "string" ? activeHours.timezone : "UTC",
        },
        model: models.model,
        replyModel: models.replyModel,
        status: "active",
        /*
         * Jittered, not `now`.
         *
         * Five bots created in one sitting would otherwise all be due at the same instant,
         * and every cycle after that would stay in lockstep — which is both a load spike and
         * the most obvious tell that a group of accounts is automated.
         */
        nextRunAt: new Date(Date.now() + Math.floor(Math.random() * 15 * 60 * 1000)),
      });

      return created(res, { bot: botSummary(bot, persona) });
    } catch (error) {
      /*
       * Best effort, and swallowed individually: whatever made the write fail is likely to make
       * the delete fail too, and a failed cleanup must not replace the error that caused it. The
       * original goes on to the handler below, which is the one that gets logged.
       *
       * Settings first, then the account — the row is meaningless without it, and an orphaned
       * settings document is invisible while an orphaned account is not.
       */
      await UserSettings.deleteOne({ user: bot._id }).catch(() => {});
      await User.deleteOne({ _id: bot._id }).catch(() => {});
      throw error;
    }
  } catch (error) {
    /*
     * A duplicate key — but this used to report *every* duplicate as "That username is taken",
     * and that answer pointed at the one thing that couldn't be wrong. The username is checked
     * free thirty lines above, so reaching here means a different unique index collided.
     *
     * The one it will be is `email`. A bot is created carrying its owner's address deliberately
     * (see the note above `User.create`), which collides with the owner's own row for as long as
     * the database still has the old global `email_1` index instead of the humans-only partial
     * one. That is a server that hasn't run `scripts/migrateBotEmailIndex.js` — a deployment
     * step, not anything the owner filling in the form did wrong.
     *
     * So: name the field that actually collided. An error that misidentifies its own cause is
     * worse than a generic one, because it is believed.
     */
    if (error?.code === 11000) {
      const collided = Object.keys(error.keyPattern || error.keyValue || {});

      if (collided.includes("username")) return fail(res, "That username is taken");

      if (collided.includes("email")) {
        // The path belongs in the operator's log, not in an owner's error toast.
        console.error(
          "createBot: duplicate key on email. This database still enforces one account per " +
            "email address for bots. Run server/scripts/migrateBotEmailIndex.js.",
          error.keyValue
        );
        return fail(
          res,
          "Bot accounts aren't set up on this server yet — its database still allows only one " +
            "account per email address. This needs an administrator, not a different username.",
          409
        );
      }

      return fail(
        res,
        `That bot collides with an existing account on ${collided.join(", ") || "an indexed field"}`,
        409
      );
    }
    return serverError(res, error, "Couldn't create that bot");
  }
};

/** Edit a bot: its profile, its persona, its pacing, its key, or whether it's running. */
export const updateBot = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, "Bot not found", 404);

    const bot = await User.findOne({ _id: req.params.id, owner: req.user.id, isBot: true });
    if (!bot) return fail(res, "Bot not found", 404);

    const body = req.body || {};
    const userUpdates = {};
    if (typeof body.name === "string") userUpdates.name = body.name.trim().slice(0, 50);
    if (typeof body.bio === "string") userUpdates.bio = body.bio.trim().slice(0, 300);
    if (typeof body.profilePic === "string") userUpdates.profilePic = body.profilePic;
    if (typeof body.isPrivate === "boolean") userUpdates.isPrivate = body.isPrivate;

    /*
     * The username is deliberately not editable here.
     *
     * Humans rename through `userController`, which enforces a change quota, holds the old
     * handle, and records history — all of it there to make impersonation by rename
     * traceable. A second rename path that skipped it would be a hole, and duplicating it
     * would be the wrong abstraction. Renaming a bot can go through the same route as a
     * human's when there's a reason to want it.
     */
    if (body.username !== undefined && normalizeUsername(body.username) !== bot.username) {
      return fail(res, "A bot's username can't be changed here", 400);
    }

    /*
     * The key this bot will use *after* this patch: either the one being assigned, or the one it
     * already has. Resolved up front because the model check depends on it — and because the awkward
     * case is a patch that changes both at once.
     */
    let effectiveKey = null;
    if (body.apiKeyId !== undefined) {
      if (!isId(body.apiKeyId)) return fail(res, "That API key doesn't exist");
      effectiveKey = await ApiKey.findOne({
        _id: body.apiKeyId,
        owner: req.user.id,
        revokedAt: null,
      }).select("_id isValid provider availableModels");
      if (!effectiveKey) return fail(res, "That API key doesn't exist");
      if (!effectiveKey.isValid) return fail(res, "That API key is not currently valid");
      userUpdates.apiKey = effectiveKey._id;
    } else if (bot.apiKey) {
      effectiveKey = await ApiKey.findById(bot.apiKey).select("_id provider availableModels");
    }

    const personaUpdates = {};
    if (typeof body.systemPrompt === "string") {
      const prompt = body.systemPrompt.trim();
      if (prompt.length < 20) return fail(res, "A system prompt of at least 20 characters is required");
      if (prompt.length > 4000) return fail(res, "The system prompt must be 4000 characters or fewer");
      personaUpdates.systemPrompt = prompt;
    }
    if (typeof body.postingStyle === "string") {
      personaUpdates.postingStyle = body.postingStyle.trim().slice(0, 500);
    }
    if (Array.isArray(body.interests)) {
      personaUpdates.interests = body.interests
        .filter((i) => typeof i === "string")
        .slice(0, 20)
        .map((i) => i.trim().slice(0, 40));
    }
    if (Number.isFinite(body.postsPerDay)) {
      personaUpdates.postsPerDay = Math.min(12, Math.max(0, body.postsPerDay));
    }
    if (body.activeHours && typeof body.activeHours === "object") {
      if (Number.isFinite(body.activeHours.startHour)) {
        personaUpdates["activeHours.startHour"] = body.activeHours.startHour;
      }
      if (Number.isFinite(body.activeHours.endHour)) {
        personaUpdates["activeHours.endHour"] = body.activeHours.endHour;
      }
      if (typeof body.activeHours.timezone === "string") {
        personaUpdates["activeHours.timezone"] = body.activeHours.timezone;
      }
    }
    /*
     * ── Models, and the case that would otherwise break a bot silently ────────
     *
     * Re-checked on every edit, not only on create. But there is a second thing to catch here:
     * **reassigning a bot to a key from a different provider invalidates its stored model.** An
     * Anthropic bot moved onto an OpenAI key still says `claude-sonnet-5`, which OpenAI has never
     * heard of — so every cycle would fail with a provider 404 and the bot would pause itself for a
     * reason its owner could do nothing about, having just done something that looked like a fix.
     *
     * So a provider change requires the models in the same patch. Refusing with an explanation is
     * better than either silently guessing a replacement or accepting a configuration that cannot
     * work.
     */
    if (effectiveKey) {
      const current = await BotPersona.findOne({ bot: bot._id }).select("model replyModel").lean();
      const providerChanged =
        body.apiKeyId !== undefined &&
        current?.model &&
        !modelAllowedFor(effectiveKey.provider, current.model);

      if (providerChanged && body.model === undefined) {
        const label = providerOf(effectiveKey.provider)?.label || effectiveKey.provider;
        return fail(
          res,
          `This bot uses ${current.model}, which isn't a ${label} model. Choose a model for the new key at the same time.`
        );
      }

      for (const field of ["model", "replyModel"]) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== "string") return fail(res, `${field} must be a model name`);

        const problem = modelProblem(effectiveKey, field, body[field].trim());
        if (problem) return fail(res, problem);
        personaUpdates[field] = body[field].trim();
      }
    } else if (body.model !== undefined || body.replyModel !== undefined) {
      /*
       * No key to check against. Refused rather than written, because a model stored without ever
       * being validated is the state this whole check exists to prevent.
       */
      return fail(res, "Assign an API key to this bot before choosing a model");
    }

    /*
     * An owner may only pause and resume. The other statuses are the system's to set —
     * letting an owner write `active` over `paused_key_invalid` would restart a bot whose
     * key still doesn't work, and it would loop until the key was fixed.
     */
    if (body.status !== undefined) {
      if (!["active", "paused_by_owner"].includes(body.status)) {
        return fail(res, "status must be 'active' or 'paused_by_owner'");
      }
      /*
       * Which pauses an owner may lift themselves.
       *
       * `paused_key_invalid` is not one: the credential has to be replaced or re-checked first, and
       * resuming would pause the bot again on its next cycle. `paused_model_invalid` is, because the
       * owner fixes that one by changing a field on this very screen — and this list has to match
       * `canResume` in the frontend, or the dashboard offers a button that always fails.
       *
       * Note what this does *not* do: check that they actually changed the model. A patch can set
       * the model and the status together, the model is validated against the key's provider a few
       * lines above, and refusing a resume because we couldn't prove intent would be second-guessing
       * an owner who may have fixed it on the previous request.
       */
      const RESUMABLE = ["paused_by_owner", "paused_model_invalid"];
      const current = await BotPersona.findOne({ bot: bot._id }).select("status").lean();
      if (body.status === "active" && current?.status && !RESUMABLE.includes(current.status)) {
        return fail(
          res,
          `This bot is ${current.status.replace(/_/g, " ")} and can't simply be resumed`,
          409
        );
      }
      personaUpdates.status = body.status;
      personaUpdates.statusReason = "";
      if (body.status === "active") personaUpdates.nextRunAt = new Date();
    }

    if (Object.keys(userUpdates).length) {
      await User.updateOne({ _id: bot._id }, { $set: userUpdates });
    }
    if (Object.keys(personaUpdates).length) {
      await BotPersona.updateOne({ bot: bot._id }, { $set: personaUpdates });
    }

    const fresh = await User.findById(bot._id)
      .select("username name profilePic bio isPrivate apiKey createdAt")
      .lean();
    const persona = await BotPersona.findOne({ bot: bot._id }).lean();

    return ok(res, { bot: botSummary(fresh, persona) });
  } catch (error) {
    return serverError(res, error, "Couldn't update that bot");
  }
};

/**
 * Delete a bot.
 *
 * The persona, its memories and its action log go. The bot's *content* — posts, comments,
 * messages other people have in their threads — is left to the account-deletion path that
 * humans use, and this route deliberately does not reimplement it: `userController` already
 * knows how to unwind a user's content, and a second implementation would be the one that
 * forgets the notifications, or the group memberships, or the read receipts.
 *
 * So this marks the account deleted through the same status field a human deletion uses and
 * removes the bot machinery. What it must never do is leave a live `User` row with
 * `isBot: true` and no persona: the runner would find it, fail to load a persona, and log a
 * failure every tick forever.
 */
export const deleteBot = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, "Bot not found", 404);

    const bot = await User.findOne({ _id: req.params.id, owner: req.user.id, isBot: true });
    if (!bot) return fail(res, "Bot not found", 404);

    /*
     * Persona first.
     *
     * The runner selects on `BotPersona`, so removing it is what actually stops the bot
     * acting. Doing it before anything else means an interruption at any later line leaves
     * a dormant account rather than one still running with half its state deleted.
     */
    await BotPersona.deleteOne({ bot: bot._id });
    await BotMemory.deleteMany({ bot: bot._id });

    /*
     * The action log is kept.
     *
     * Section 10 requires bot activity to be auditable, and "the owner deleted the bot"
     * is exactly when that record matters most — a log that can be erased by the person it
     * documents is not an audit trail. It is already keyed by `owner` as well as `bot`, so
     * it remains attributable after the account is gone.
     */

    await User.updateOne(
      { _id: bot._id },
      {
        $set: {
          accountStatus: "deleted",
          // Freed for reuse, and no longer resolvable to this account.
          isPrivate: true,
        },
      }
    );

    return ok(res, { deleted: true, botId: bot._id });
  } catch (error) {
    return serverError(res, error, "Couldn't delete that bot");
  }
};

/** Recent activity for one of the owner's bots. Read-only, paginated by time. */
export const getBotActivity = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, "Bot not found", 404);

    const bot = await User.findOne({ _id: req.params.id, owner: req.user.id, isBot: true })
      .select("_id")
      .lean();
    if (!bot) return fail(res, "Bot not found", 404);

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const entries = await BotActionLog.find({ bot: bot._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      /*
       * `targetKey` alongside `targetId`, and this was a real gap rather than a nicety. A DM
       * conversation is a derived key, not a document, so Phase 6 gave it its own string field —
       * and without it here every `reply_dm` row reaches the dashboard with no target at all. The
       * bot's replies to strangers are precisely the rows an owner is most likely to be asked
       * about.
       *
       * `cycleId` too, so the UI can group a decision back into the one model call that produced
       * it. Without it, six actions from one cycle read as six unrelated events.
       */
      .select("action outcome targetType targetId targetKey reason usage cycleId createdAt")
      .lean();

    return ok(res, { activity: entries });
  } catch (error) {
    return serverError(res, error, "Couldn't load that bot's activity");
  }
};

export const getBotChats = async (req, res, next) => {
  try {
    const bot = await User.findOne({ _id: req.params.id, owner: req.user.id, isBot: true });
    if (!bot) return res.status(404).json({ error: "Bot not found" });

    // Stash original user and patch for getChats
    req.originalUser = req.user;
    req.user = bot;
    return getChats(req, res);
  } catch (error) {
    next(error);
  }
};

export const getBotConversation = async (req, res, next) => {
  try {
    const bot = await User.findOne({ _id: req.params.id, owner: req.user.id, isBot: true });
    if (!bot) return res.status(404).json({ error: "Bot not found" });

    // Stash original user and patch for getMessages
    req.originalUser = req.user;
    req.user = bot;
    return getMessages(req, res);
  } catch (error) {
    next(error);
  }
};

export { BOT_STATUSES };
