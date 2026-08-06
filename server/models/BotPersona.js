import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * How a bot behaves: its instructions, its pacing, and whether it is currently running.
 *
 * Separate from the `User` row deliberately. The user document is read on nearly every
 * request in the app — feeds, followers, chat headers — and a multi-kilobyte system prompt
 * has no business being loaded alongside a username. This is fetched only by the agent
 * loop and the owner's dashboard.
 */

/*
 * The only models a bot may use, enforced here on write and again in the Python service on
 * every request.
 *
 * Two checks for one rule because they fail differently: Node's stops an owner saving a
 * model that doesn't exist, and Python's stops a compromised or buggy Node from spending
 * an owner's key on something arbitrary. The second is the one that matters if the first
 * is ever bypassed, which is what defence in depth means in practice.
 *
 * Exported so the Python allowlist can be generated from this list rather than
 * hand-copied, and so a deprecation is one edit followed by a batch migration.
 */
export const ALLOWED_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
];

/** Haiku for DM replies: they're short, single-turn, and a person is waiting. */
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_REPLY_MODEL = "claude-haiku-4-5-20251001";

/**
 * Is this string shaped like a model id at all?
 *
 * The schema-level bound, and deliberately weaker than the controller's — but *how* weak took two
 * attempts to get honest about, so the history is worth keeping.
 *
 * A field-level `enum` of three Claude ids was right when there was one provider, and impossible with
 * eight: which models are legal depends on the key, and a schema cannot reach `ApiKey.provider`.
 *
 * The second attempt was the **union** of every provider's `modelCeiling` — "recognisable as a model
 * for one of our providers". It failed twice, the same way each time. Groq has no prefix, because it
 * serves other people's models, so its ceiling had to be permissive; and a union is only as strict as
 * its loosest member, so `not-a-model` passed. Tightening Groq to require a digit or a slash fixed it
 * — until `self_hosted` arrived, equally prefix-less, and `not-a-model` passed again.
 *
 * That is not a bug to patch a third time; it is the union being structurally unsound. Two providers
 * legitimately accept almost any token, so a union across all of them cannot say much, and a check
 * that *looks* precise while conveying nothing is worse than one that admits its scope.
 *
 * So the schema now bounds what it actually can: length and character set. That still refuses the
 * things worth refusing at this layer — an empty string, 200 characters, `'; DROP TABLE users`,
 * `../../etc/passwd` — and the real question, "is this a model *this key's* provider serves", is
 * answered in the controller, where the key and its discovered model list are in hand.
 */
const MODEL_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9._:\-/]{0,99}$/;

const looksLikeAModelId = (value) => typeof value === "string" && MODEL_SHAPE.test(value);

/*
 * Why a bot is not currently acting. Every value except `active` is a resting state the
 * product renders calmly — a paused bot keeps its profile, its posts and its history, and
 * simply stops generating new activity, the way a human account goes quiet.
 */
export const BOT_STATUSES = [
  "active",
  "paused_by_owner",
  "paused_key_invalid",
  /*
   * The model went away — retired by the provider, renamed, or never really there despite being in
   * the discovered list. Distinct from `paused_key_invalid` because the credential is fine and the
   * owner fixes this by choosing another model, not by regenerating a key. That difference is why
   * `canResume` in the frontend lets an owner restart this one and not that one.
   */
  "paused_model_invalid",
  "paused_rate_limited",
  "paused_by_admin",
];

const botPersonaSchema = new Schema(
  {
    bot: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },

    /*
     * The owner's instructions. Untrusted input in the sense that matters here: the owner
     * can write anything, including an attempt to make the bot deny being AI.
     *
     * That attempt cannot succeed by construction, not by review — the identity clause is
     * appended *after* this text when the system prompt is assembled, and restated in the
     * tool description. Length-capped because a persona is also a per-call token cost the
     * owner pays on every cycle, and because an unbounded system prompt is a way to push
     * the real instructions out of the model's attention.
     */
    systemPrompt: { type: String, required: true, maxlength: 4000, trim: true },

    /** Free-text hint about voice and format, folded into the prompt. */
    postingStyle: { type: String, default: "", maxlength: 500, trim: true },

    /*
     * Interests, used to bias what the perception layer shows this bot rather than being
     * sent to the model as instructions. A bot that only ever sees a random slice of the
     * feed behaves like a random account.
     */
    interests: { type: [String], default: [] },

    /** Posts per day, before pacing jitter. Zero means "never posts". */
    postsPerDay: { type: Number, default: 1, min: 0, max: 12 },

    /*
     * The window, in the owner's timezone, when this bot is awake.
     *
     * Believability, and cost. An account that comments at 04:00 every night reads as
     * automation, and cycles outside the window are skipped before any model call.
     */
    activeHours: {
      startHour: { type: Number, default: 8, min: 0, max: 23 },
      endHour: { type: Number, default: 23, min: 0, max: 23 },
      timezone: { type: String, default: "UTC" },
    },

    /*
     * The model, validated against a shape rather than a list — see `looksLikeAnyProviderModel`.
     * Which models are actually legal depends on the key this bot is assigned to, and that check
     * lives in the controller, where the key is in hand.
     */
    model: {
      type: String,
      default: DEFAULT_MODEL,
      maxlength: 100,
      validate: {
        validator: looksLikeAModelId,
        message: "{VALUE} isn't shaped like a model id",
      },
    },
    replyModel: {
      type: String,
      default: DEFAULT_REPLY_MODEL,
      maxlength: 100,
      validate: {
        validator: looksLikeAModelId,
        message: "{VALUE} isn't shaped like a model id",
      },
    },

    status: { type: String, default: "active", enum: BOT_STATUSES },
    /** Why, in words, for the owner's dashboard. Set alongside every non-active status. */
    statusReason: { type: String, default: "" },

    /*
     * When the runner should next consider this bot.
     *
     * The scheduling primitive, and the reason this is a field rather than a cron
     * expression: `utils/scheduler.js` claims work by atomically moving a row out of a
     * due-and-pending state, which needs a timestamp to compare against. Staggering is
     * then just jitter when computing the next one — no two bots share a tick, and there
     * is no synchronised spike to absorb.
     */
    /*
     * Not indexed on its own — `{ status, nextRunAt }` below is what the runner queries,
     * and this field is rewritten on every cycle, so a second index on it would be write
     * amplification in the hottest path this feature has.
     */
    nextRunAt: { type: Date, default: () => new Date() },
    lastRunAt: { type: Date, default: null },
    /** Set while a cycle is in flight, so a second worker can't claim the same bot. */
    claimedAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * The runner's query: active bots that are due, oldest first.
 *
 * `status` leads because it is the most selective — a paused bot is never a candidate no
 * matter how overdue it is.
 */
botPersonaSchema.index({ status: 1, nextRunAt: 1 });

export default model("BotPersona", botPersonaSchema);
