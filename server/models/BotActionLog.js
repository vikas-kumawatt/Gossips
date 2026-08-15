import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Every action a bot takes, and every one it was stopped from taking.
 *
 * Section 10 of the spec makes this non-negotiable, and the reason is not debugging. When
 * someone asks "why did this AI account comment on my post", there has to be an answer,
 * and when a regulator or an app store asks whether bot activity is auditable, the answer
 * has to be a collection rather than a log file that rotated away.
 *
 * Rejections are recorded as well as successes. A bot that tried to DM someone who had
 * blocked it, and was refused, is the single most useful row in here — it is evidence the
 * guardrail fired, and without it the absence of the DM is indistinguishable from the
 * model never having attempted it. That distinction is exactly what a prompt-injection
 * post-mortem turns on.
 *
 * `AuditLog` was considered and is the wrong home: its `action` enum is admin/moderation
 * vocabulary, it requires `actorRole`, and its rows are read by the admin tools. Mixing
 * tens of thousands of routine bot likes into the moderator audit trail would bury the
 * thing that collection exists to make visible.
 */

/** Every action type the model can choose, plus the outcomes that aren't its idea. */
export const BOT_ACTIONS = [
  "scroll_feed",
  "view_profile",
  "like_post",
  "comment_post",
  "repost_post",
  "quote_post",
  "follow_user",
  "send_follow_request",
  "send_dm",
  "reply_dm",
  "create_post",
  "do_nothing",
  /*
   * ── Added when bots stopped being able only to post and reply ──────────────
   *
   * Three groups, and the split is worth keeping in mind when reading a log.
   *
   * `unfollow_user` ends a relationship the bot itself chose to start.
   *
   * `save_post`, `not_interested_post` and `favourite_author` are private: nobody but the
   * owner can tell they happened, and the worst case of getting one wrong is a slightly worse
   * feed for the bot's own account.
   *
   * `mute_user`, `block_user` and `report_content` land on other people. A block deletes
   * follow edges in both directions and unblocking does not restore them; a report puts a real
   * item in front of a human moderator. Those three carry their own low daily caps — see
   * `SENSITIVE_ACTION_LIMITS` in bots/rateLimits.js — because the general action budget is
   * sized for likes and comments and would allow dozens of either.
   */
  "unfollow_user",
  "save_post",
  "not_interested_post",
  "favourite_author",
  "mute_user",
  "block_user",
  "report_content",
  /*
   * Not actions the model chose — outcomes of a cycle.
   *
   * Logged in the same collection because the question an auditor asks is "what did this
   * bot do at 14:03", and "it was refused" or "its key had expired" are answers to that
   * question. A separate collection would mean reconstructing a timeline from two.
   */
  "cycle_skipped",
  "cycle_failed",
];

export const ACTION_OUTCOMES = ["executed", "rejected", "failed"];

const botActionLogSchema = new Schema(
  {
    // Indexed by the compound indexes below, which start with these fields.
    bot: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /*
     * Denormalised from the bot's `User` row.
     *
     * The owner is the unit of accountability, and an audit query is nearly always "what
     * have this owner's bots been doing" — which would otherwise need a lookup into users
     * on every read of a collection that only ever grows.
     */
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },

    action: { type: String, enum: BOT_ACTIONS, required: true },
    outcome: { type: String, enum: ACTION_OUTCOMES, required: true, default: "executed" },

    /** What it acted on. Polymorphic, like `Like` and `Repost` in this codebase. */
    targetType: {
      type: String,
      enum: ["Post", "Comment", "User", "Message", "Conversation", null],
      default: null,
    },
    targetId: { type: Schema.Types.ObjectId, default: null },

    /*
     * A conversation target, which is the one kind that isn't a document.
     *
     * A DM "conversation" in this app is a derived key — two sorted ids, or `g:<id>` for a group
     * — not a row with an `_id`. Writing `"64ab…:64cd…"` into `targetId` throws a cast error, and
     * because `logAction` swallows log-write failures by design, the effect would be a `reply_dm`
     * that silently never appears in the audit trail. That is the worst possible field to lose:
     * a bot's replies to strangers are precisely what someone asks about later.
     *
     * So ObjectId targets go in `targetId` and conversation keys go here, and `logAction` routes
     * on `targetType` rather than leaving it to each caller to remember.
     */
    targetKey: { type: String, default: "" },

    /*
     * Why a rejection happened, in the guardrail's own words — "target not in perception",
     * "blocked by recipient", "daily action cap reached".
     *
     * Never the model's `reasoning`. That text is derived from untrusted third-party
     * content and is not shown to anyone; storing it next to an audit row invites it being
     * surfaced in a UI later.
     */
    reason: { type: String, default: "" },

    /*
     * Which cycle produced this, so a whole decision can be reconstructed as a unit — the
     * perception it saw, the actions it returned, and which of them survived validation.
     */
    cycleId: { type: String, default: "", index: true },

    /** Token counts and latency, for cost attribution to the owner. */
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      model: { type: String, default: "" },
      latencyMs: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

/** The dashboard's query, and the audit query: one bot's history, newest first. */
botActionLogSchema.index({ bot: 1, createdAt: -1 });

/** Per-owner cost and volume reporting across all their bots. */
botActionLogSchema.index({ owner: 1, createdAt: -1 });

/**
 * The rate limiter's fallback counter: how many of this action has this bot taken today.
 *
 * Redis holds the live counters, but Redis is a cache — it can be cold, flushed, or
 * unreachable. When it is, the daily cap has to be answerable from the durable record or
 * it isn't a cap at all, just a hint.
 */
botActionLogSchema.index({ bot: 1, action: 1, createdAt: -1 });

export default model("BotActionLog", botActionLogSchema);
