import BotActionLog from "../models/BotActionLog.js";
import { commentOnPost, createPost } from "../services/authoring.js";
import { followUser, likePost, repostPost } from "../services/engagement.js";
import { sendDirectMessage } from "../services/directMessage.js";
import { participantsOfConversation } from "../utils/conversationActivity.js";
import { canBotSendDm } from "./actionValidator.js";
import { COUNTED_ACTIONS } from "./rateLimits.js";

/**
 * Carrying out actions that have already been validated.
 *
 * This module does no deciding. By the time an action arrives here it has passed the schema,
 * the target allowlist, output moderation and the per-type rules, so the job is to route it to
 * the service that already knows how to do it and to record what happened.
 *
 * ── Everything goes through the Phase 2 services ────────────────────────────
 *
 * `likePost`, `followUser`, `commentOnPost`, `createPost`, `sendDirectMessage`. Not one query
 * here writes to a collection directly, and that is the point of having extracted them: a bot
 * passes through the *same* blocks, privacy settings, reply audiences, maintenance gates,
 * counters, notifications and socket emissions as a person tapping the button. A second write
 * path for bots would be a second place for every one of those rules to be forgotten.
 *
 * So the interesting content of this file is small: three lookups the services can't do for
 * themselves, and the audit row.
 *
 * ── Rejected, failed, executed ──────────────────────────────────────────────
 *
 * A service returning `{ ok: false }` is a **rejection** — a rule said no. A thrown exception is
 * a **failure** — something broke. Collapsing the two would make the audit log useless for the
 * question it exists to answer: "was this bot stopped, or did it crash?"
 */

/**
 * Every bot-authored post, comment and quote carries the platform's AI disclosure.
 *
 * `Post.isAiGenerated` is described in the model as "author's own disclosure that this was made
 * with AI", and for a bot that is unambiguously true — so it is set here rather than left to an
 * owner's honesty. The account-level `BotBadge` says *who* is an AI; this says *this piece of
 * content* is, which is what someone sees when the post is reposted away from the profile.
 */
const AI_DISCLOSURE = true;

/**
 * Write one audit row.
 *
 * Exported because the runner logs the validator's rejections through it too: a refused action
 * belongs in the same collection as an executed one, in the same shape, or reconstructing a
 * cycle means reading two places.
 *
 * Never throws. A cycle that has already spent an owner's money must not be lost because the log
 * write failed, and the alternative — letting it propagate — would mark a successful cycle as a
 * failure and eventually pause a working bot.
 */
export const logAction = async ({
  bot,
  owner,
  action,
  outcome = "executed",
  targetType = null,
  targetId = null,
  reason = "",
  cycleId = "",
  usage = null,
}) => {
  /*
   * A conversation target is a derived key, not a document id, so it goes in `targetKey`.
   * Routed here rather than at each call site: an ObjectId cast error would be swallowed by the
   * catch below, and the visible symptom would be `reply_dm` rows quietly missing from the audit
   * trail — see the note on the field in models/BotActionLog.js.
   */
  const isKey = targetType === "Conversation";

  try {
    await BotActionLog.create({
      bot,
      owner,
      action,
      outcome,
      targetType,
      targetId: isKey ? null : targetId,
      targetKey: isKey ? String(targetId ?? "") : "",
      reason: String(reason || "").slice(0, 300),
      cycleId,
      ...(usage ? { usage } : {}),
    });
  } catch (error) {
    console.error("botActionLog write failed:", error?.message ?? error);
  }
};

/**
 * The other party in a DM conversation.
 *
 * `sendDirectMessage` takes a recipient, not a conversation key, so a `reply_dm` has to be
 * resolved. `participantsOfConversation` is the app's one reader of that key — it knows a DM key
 * is two ids and a group key is `g:<id>` — so parsing it here would be a second implementation
 * that would eventually treat a group as a DM and pick a nonsense peer.
 */
const peerOf = async (conversationId, botId) => {
  const participants = await participantsOfConversation(conversationId);
  /*
   * Exactly two, as in perception. A group conversation is out of scope until there is a
   * `sendGroupMessage` service that applies the group's own send gates — slow mode, mute,
   * per-member permissions — none of which `sendDirectMessage` knows about.
   */
  if (participants.length !== 2) return null;
  return participants.find((id) => String(id) !== String(botId)) ?? null;
};

const rejected = (reason) => ({ outcome: "rejected", reason });
const executed = () => ({ outcome: "executed", reason: "" });

/**
 * Route one action to the service that performs it.
 *
 * @returns {Promise<{outcome: "executed"|"rejected", reason: string}>}
 */
const perform = async (action, botId) => {
  switch (action.type) {
    /*
     * Reads. Logged because "the bot looked at your profile" is an answer to "what did this
     * account do", and because a cycle of nothing but looking is a real and healthy outcome —
     * but nothing is written, so there is no service to call.
     */
    case "do_nothing":
    case "scroll_feed":
    case "view_profile":
      return executed();

    case "like_post": {
      const result = await likePost({ actorId: botId, postId: action.postId });
      if (!result.ok) return rejected(result.error);
      /*
       * `likePost` is a toggle and reports which way it went. The validator already refuses a
       * like on an `already_liked` post, so `liked: false` here means the state changed between
       * the perception and now — the bot has just *removed* a like. Recorded as a rejection
       * because the intent was not carried out, and silence would leave a mystery un-like in
       * someone's notifications with nothing in the log to explain it.
       */
      if (result.liked === false) return rejected("the like was already there and has been undone");
      return executed();
    }

    case "repost_post": {
      const result = await repostPost({ actorId: botId, postId: action.postId });
      if (!result.ok) return rejected(result.error);
      if (result.reposted === false) return rejected("the repost was already there and has been undone");
      return executed();
    }

    /*
     * One service for both. `followUser` already decides between an immediate follow and a
     * pending request by reading the target's `isPrivate`, so the two action types are the
     * model's *expectation* rather than a branch here — and the model's expectation is not what
     * should determine whether a private account gets its approval step.
     */
    case "follow_user":
    case "send_follow_request": {
      const result = await followUser({ actorId: botId, targetId: action.userId });
      return result.ok ? executed() : rejected(result.error);
    }

    case "comment_post": {
      const result = await commentOnPost({
        actorId: botId,
        postId: action.postId,
        content: action.text,
        isAiGenerated: AI_DISCLOSURE,
      });
      return result.ok ? executed() : rejected(result.error);
    }

    case "quote_post": {
      const result = await createPost({
        actorId: botId,
        content: action.text,
        quotedPost: action.postId,
        isAiGenerated: AI_DISCLOSURE,
      });
      return result.ok ? executed() : rejected(result.error);
    }

    case "create_post": {
      const result = await createPost({
        actorId: botId,
        content: action.text,
        isAiGenerated: AI_DISCLOSURE,
      });
      return result.ok ? executed() : rejected(result.error);
    }

    case "send_dm": {
      /*
       * The follower gate, asked again here rather than trusted from validation. A cycle takes
       * seconds and someone can unfollow inside it — see the note in actionValidator.
       */
      const gate = await canBotSendDm(botId, action.userId);
      if (!gate.ok) return rejected(gate.reason);

      const result = await sendDirectMessage({
        senderId: botId,
        receiverId: action.userId,
        content: action.text,
        // A bot is an ordinary account: maintenance mode and the messaging flag apply to it.
        actorRole: "user",
      });
      return result.ok ? executed() : rejected(result.error);
    }

    case "reply_dm": {
      const peerId = await peerOf(action.conversationId, botId);
      if (!peerId) return rejected("the conversation is no longer a two-person chat");

      const result = await sendDirectMessage({
        senderId: botId,
        receiverId: peerId,
        content: action.text,
        actorRole: "user",
      });
      return result.ok ? executed() : rejected(result.error);
    }

    default:
      /*
       * Unreachable — the validator only emits the twelve types. Kept because the alternative is
       * a silent no-op logged as a success, and a type that reached here would mean the two
       * modules had drifted, which is exactly the thing that must be loud.
       */
      return rejected(`no executor for ${action.type}`);
  }
};

/**
 * Execute a validated decision, in order, until the daily budget runs out.
 *
 * @param {object[]} actions from `validateDecision`
 * @param {object} context
 * @param {object} context.bot the bot's `User` row (needs `_id` and `owner`)
 * @param {string} context.cycleId
 * @param {number} context.remainingActions write actions still allowed today
 * @param {object} [context.usage] token counts for this cycle
 * @returns {Promise<{executed: number, rejected: number, failed: number}>}
 */
export const executeActions = async (actions, context) => {
  const { bot, cycleId = "", remainingActions = Number.POSITIVE_INFINITY, usage = null } = context;
  const botId = bot?._id ?? bot;
  const owner = bot?.owner ?? null;

  const counts = { executed: 0, rejected: 0, failed: 0 };
  let budget = remainingActions;
  /*
   * The cycle's token cost rides on the first row written and no other.
   *
   * Per-owner cost reporting sums `usage.inputTokens` across rows, so repeating it on each of
   * six actions would report six times the spend. Attaching it to the first row keeps the sum
   * correct and keeps the cost attached to a row that definitely exists — `validateDecision`
   * never returns an empty action list.
   */
  let usageAttached = false;

  for (const action of actions) {
    const counted = COUNTED_ACTIONS.includes(action.type);

    /*
     * The daily cap, applied per action rather than per cycle. A bot with two writes left runs
     * and does two, instead of being refused a cycle its owner has already paid for.
     */
    if (counted && budget <= 0) {
      counts.rejected += 1;
      await logAction({
        bot: botId,
        owner,
        action: action.type,
        outcome: "rejected",
        targetType: action.targetType ?? null,
        targetId: action.targetId ?? null,
        reason: "daily action cap reached",
        cycleId,
        usage: usageAttached ? null : usage,
      });
      usageAttached = true;
      continue;
    }

    let result;
    try {
      result = await perform(action, botId);
    } catch (error) {
      /*
       * A thrown error is a failure, not a rejection, and it does not stop the rest of the
       * cycle. One action hitting a database hiccup should not discard the four after it.
       */
      console.error(`bot action ${action.type} failed:`, error?.message ?? error);
      result = { outcome: "failed", reason: "something went wrong performing this action" };
    }

    counts[result.outcome] += 1;
    if (result.outcome === "executed" && counted) budget -= 1;

    await logAction({
      bot: botId,
      owner,
      action: action.type,
      outcome: result.outcome,
      targetType: action.targetType ?? null,
      targetId: action.targetId ?? null,
      reason: result.reason,
      cycleId,
      usage: usageAttached ? null : usage,
    });
    usageAttached = true;
  }

  return counts;
};
