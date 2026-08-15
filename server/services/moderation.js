import mongoose from "mongoose";
import Comment from "../models/Comment.js";
import Follow from "../models/Follow.js";
import GroupMember from "../models/GroupMember.js";
import Message from "../models/Message.js";
import Post from "../models/Post.js";
import Report from "../models/Report.js";
import User from "../models/User.js";
import UserRelation from "../models/UserRelation.js";
import { contentVersionAt } from "../utils/editHistory.js";
import { normalizeTag } from "../utils/richText.js";
import { del, CacheKeys } from "../utils/cache.js";
import {
  MAX_REPORT_DETAILS,
  categoryRequiresDetails,
  validateReportReason,
} from "../utils/reportCategories.js";

/**
 * Muting, blocking and reporting — as functions rather than as request handlers.
 *
 * Same contract as engagement.js: `{ ok: true, ...outcome }` or `{ ok: false, status, error }`,
 * never thrown for a refusal, never a response object. Read that header first.
 *
 * ── Why these three are together, and apart from curation.js ────────────────
 *
 * Everything in curation.js is invisible to anyone but its owner. These are not. A block
 * silently deletes follow edges in both directions and cannot be undone by unblocking — the
 * edges do not come back. A report puts a real item in front of a human moderator. Those are
 * the two consequences worth keeping in one file with one set of eyes on it, because they are
 * the two an AI bot can now reach.
 *
 * ── The bot dimension ───────────────────────────────────────────────────────
 *
 * Nothing here knows or cares whether the actor is a bot; the rules are the rules. Two things
 * are the exception, and both are recording rather than gating: `Report.reporterIsBot` is
 * stamped so a moderator can weigh an automated report differently from a person's, and the
 * per-day caps live in `bots/rateLimits.js` where every other bot budget is. Gating here would
 * mean the human path paid for a rule it doesn't need.
 */

const idOf = (value) => (value?._id ? value._id : value)?.toString?.() ?? String(value);

const invalidateProfileCaches = async (...usernames) => {
  const unique = [...new Set(usernames.filter(Boolean))];
  await Promise.all(unique.map((username) => del(CacheKeys.profile(username))));
};

/** Both accounts, or a refusal. Shared by mute and block, which ask the same three questions. */
const twoParties = async (actorId, targetId, verb) => {
  if (!mongoose.isValidObjectId(targetId)) {
    return { ok: false, status: 404, error: "User not found" };
  }
  if (idOf(targetId) === idOf(actorId)) {
    return { ok: false, status: 400, error: `You can't ${verb} yourself` };
  }

  const [actor, target] = await Promise.all([
    User.findById(actorId).select("username").lean(),
    User.findById(targetId).select("_id username").lean(),
  ]);
  if (!target) return { ok: false, status: 404, error: "User not found" };

  return { ok: true, actor, target };
};

/**
 * Stop seeing someone's posts, without them knowing.
 *
 * Idempotent by design, not a toggle — muting someone already muted is the state the caller
 * asked for, so it is a success. `unmuteUser` is the separate verb. That asymmetry is
 * deliberate and matches the controller: a toggle here would mean a retry silently unmutes.
 *
 * @returns `{ ok, alreadyMuted }`
 */
export const muteUser = async ({ actorId, targetId }) => {
  const parties = await twoParties(actorId, targetId, "mute");
  if (!parties.ok) return parties;

  const existing = await UserRelation.findOne({
    from: actorId,
    to: parties.target._id,
    kind: "mute",
  })
    .select("_id")
    .lean();
  if (existing) return { ok: true, alreadyMuted: true };

  /*
   * A duplicate-key here is the concurrent case winning the same race — the unique index on
   * `{from, to, kind}` is the arbiter, and the outcome the caller wanted is the outcome either
   * way. Anything else is a genuine fault and is left to throw, per the service contract.
   */
  try {
    await UserRelation.create({ from: actorId, to: parties.target._id, kind: "mute" });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { ok: true, alreadyMuted: true };
  }

  // No notification and no cache invalidation, matching the controller: a mute changes
  // nothing on either profile and the mutee must not be able to detect it.
  return { ok: true, alreadyMuted: false };
};

/** Undo a mute. Idempotent — removing something that isn't there is a success. */
export const unmuteUser = async ({ actorId, targetId }) => {
  if (!mongoose.isValidObjectId(targetId)) {
    return { ok: false, status: 404, error: "User not found" };
  }
  await UserRelation.deleteOne({ from: actorId, to: targetId, kind: "mute" });
  return { ok: true };
};

/**
 * Block someone: cut the relationship in both directions.
 *
 * The heaviest of these, and the only one that destroys state. Blocking deletes accepted
 * follow edges *both ways* plus any pending requests, and adjusts four counters. Unblocking
 * does not restore any of it — that is existing behaviour and worth knowing before handing
 * this to anything that decides on its own.
 *
 * Idempotent, like mute, and for a documented reason: it used to answer 400, the client read
 * a rejected block as a failed one and rolled back its optimistic update, so a stale UI got
 * permanently stuck — every click failed and every failure restored the state that caused the
 * next click.
 *
 * @returns `{ ok, alreadyBlocked }`
 */
export const blockUser = async ({ actorId, targetId }) => {
  const parties = await twoParties(actorId, targetId, "block");
  if (!parties.ok) return parties;

  const { actor, target } = parties;

  const existing = await UserRelation.findOne({ from: actorId, to: target._id, kind: "block" })
    .select("_id")
    .lean();
  if (existing) return { ok: true, alreadyBlocked: true };

  try {
    await UserRelation.create({ from: actorId, to: target._id, kind: "block" });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { ok: true, alreadyBlocked: true };
  }

  const [removedA, removedB] = await Promise.all([
    Follow.findOneAndDelete({ follower: actorId, following: target._id, status: "accepted" }),
    Follow.findOneAndDelete({ follower: target._id, following: actorId, status: "accepted" }),
    // Pending requests in both directions go too — an unanswered request between two
    // people who have just blocked each other is not something either wants to see again.
    Follow.deleteMany({
      $or: [
        { follower: actorId, following: target._id },
        { follower: target._id, following: actorId },
      ],
      status: "pending",
    }),
  ]);

  // Conditional on which edges actually existed: decrementing for an edge that wasn't there
  // takes a real total below what it should be, and nothing ever puts it back.
  const countUpdates = [];
  if (removedA) {
    countUpdates.push(
      User.updateOne({ _id: actorId }, { $inc: { "counts.following": -1 } }),
      User.updateOne({ _id: target._id }, { $inc: { "counts.followers": -1 } })
    );
  }
  if (removedB) {
    countUpdates.push(
      User.updateOne({ _id: target._id }, { $inc: { "counts.following": -1 } }),
      User.updateOne({ _id: actorId }, { $inc: { "counts.followers": -1 } })
    );
  }
  await Promise.all(countUpdates);

  /*
   * The cached profiles hold exactly the counts the `$inc`s above just changed, for 60s. Every
   * follow path drops them for that reason; block mutated the same fields and for a long time
   * did not, so both profiles showed stale follower counts after a block.
   */
  await invalidateProfileCaches(actor?.username, target.username);

  return { ok: true, alreadyBlocked: false };
};

/** Undo a block. Does not restore the follow edges it destroyed — nothing can. */
export const unblockUser = async ({ actorId, targetId }) => {
  if (!mongoose.isValidObjectId(targetId)) {
    return { ok: false, status: 404, error: "User not found" };
  }
  const [actor, target] = await Promise.all([
    User.findById(actorId).select("username").lean(),
    User.findById(targetId).select("_id username").lean(),
  ]);
  if (!target) return { ok: false, status: 404, error: "User not found" };

  await UserRelation.deleteOne({ from: actorId, to: target._id, kind: "block" });
  await invalidateProfileCaches(actor?.username, target.username);
  return { ok: true };
};

/* ── Reporting ─────────────────────────────────────────────────────────────── */

const ID_TARGETS = new Set(["post", "comment", "message"]);

/**
 * Mongoose drops `undefined` from a filter and casts objects as operators, so an absent or
 * non-string identifier would otherwise match an arbitrary document. Pin the shape down
 * before it reaches a query.
 */
export const validateReportIdentifier = (targetType, targetId, username) => {
  if (ID_TARGETS.has(targetType)) {
    return mongoose.isValidObjectId(targetId) ? null : "Invalid report target";
  }
  // conversation and user use it as a handle; hashtag uses it as the tag.
  return typeof username === "string" && username.trim() ? null : "Invalid report target";
};

/**
 * Resolve what is being reported into `{ targetId, targetKey, targetOwner, versionAt }`, or
 * `{ error }` if it doesn't exist or isn't the reporter's to see.
 *
 * Exported because both the report endpoint and the "have I already reported this" endpoint
 * need it, and now the bot executor does too. One resolver: a second one would eventually
 * disagree about which messages a person is allowed to report.
 */
export const resolveReportTarget = async (targetType, { targetId, username }, reporterId) => {
  switch (targetType) {
    case "post": {
      const post = await Post.findOne({ _id: targetId, isDeleted: { $ne: true } })
        .select("author editedAt createdAt")
        .lean();
      if (!post) return { error: "Post not found" };
      return {
        targetId: post._id,
        targetKey: null,
        targetOwner: post.author,
        versionAt: contentVersionAt(post),
      };
    }
    case "comment": {
      const comment = await Comment.findOne({ _id: targetId, isDeleted: { $ne: true } })
        .select("author editedAt createdAt")
        .lean();
      if (!comment) return { error: "Comment not found" };
      return {
        targetId: comment._id,
        targetKey: null,
        targetOwner: comment.author,
        versionAt: contentVersionAt(comment),
      };
    }
    case "message": {
      const message = await Message.findById(targetId)
        .select("sender receiver group isGroupMessage conversation editedAt createdAt")
        .lean();
      if (!message) return { error: "Message not found" };

      // You can only report a message you can actually see. Same 404 either way, so probing
      // for message ids tells an attacker nothing.
      const isParticipant = message.isGroupMessage
        ? !!(await GroupMember.exists({ group: message.group, user: reporterId }))
        : [message.sender, message.receiver].some((id) => idOf(id) === idOf(reporterId));
      if (!isParticipant) return { error: "Message not found" };

      return {
        targetId: message._id,
        targetKey: message.conversation,
        targetOwner: message.sender,
        versionAt: contentVersionAt(message),
      };
    }
    case "conversation": {
      const peer = await User.findOne({ username }).select("_id").lean();
      if (!peer) return { error: "User not found" };

      const targetKey = Message.dmConversationKey(reporterId, peer._id);
      if (!(await Message.exists({ conversation: targetKey }))) {
        return { error: "Conversation not found" };
      }
      return { targetId: null, targetKey, targetOwner: peer._id };
    }
    case "user": {
      const user = await User.findOne({ username }).select("_id").lean();
      if (!user) return { error: "User not found" };
      return { targetId: user._id, targetKey: null, targetOwner: user._id };
    }
    /*
     * A hashtag has no document and no owner — it isn't anybody's, which is rather the point
     * of reporting one. Keyed by the tag so repeat reports group together in the queue.
     */
    case "hashtag": {
      const tag = normalizeTag(username);
      if (!tag) return { error: "Invalid hashtag" };
      return { targetId: null, targetKey: `tag:${tag}`, targetOwner: null };
    }
    default:
      return { error: "Unknown report target" };
  }
};

/** A report still in the queue blocks a repeat outright. */
const OPEN_STATUSES = ["pending", "reviewing"];

/**
 * May this reporter report this target again?
 *
 * No previous report → yes. One still open → no. Otherwise the decision stands unless the
 * content has actually been edited since — that is a different thing to what was reviewed.
 * Targets with no editable content (accounts, whole conversations, hashtags) have no
 * `versionAt`, so a decision there is final for that reporter.
 */
export const canReportAgain = (report, target) => {
  if (!report) return true;
  if (OPEN_STATUSES.includes(report.status)) return false;
  if (!target.versionAt) return false;
  return new Date(target.versionAt) > new Date(report.createdAt);
};

const reportFilter = (reporterId, targetType, target) => ({
  reporter: reporterId,
  targetType,
  targetId: target.targetId,
  targetKey: target.targetKey,
});

/** Most recent report whatever its status — what the status screen shows. */
export const findLatestReport = (reporterId, targetType, target) =>
  Report.findOne(reportFilter(reporterId, targetType, target))
    .select("status category subcategory createdAt")
    .sort({ createdAt: -1 })
    .lean();

/**
 * File a report.
 *
 * @param {boolean} [reporterIsBot] recorded on the row, not used to decide anything here.
 * @returns `{ ok, alreadyReported, report }` — `alreadyReported` means an existing report
 *          covers this and nothing new was written, which is a success, not a refusal.
 */
export const reportContent = async ({
  actorId,
  targetType,
  targetId = null,
  username = null,
  category,
  subcategory = null,
  details = null,
  url = null,
  userAgent = null,
  reporterIsBot = false,
}) => {
  const reasonError = validateReportReason(targetType, category, subcategory || null);
  if (reasonError) return { ok: false, status: 400, error: reasonError };

  const idError = validateReportIdentifier(targetType, targetId, username);
  if (idError) return { ok: false, status: 400, error: idError };

  const trimmedDetails = typeof details === "string" ? details.trim() || null : null;
  if (trimmedDetails && trimmedDetails.length > MAX_REPORT_DETAILS) {
    return {
      ok: false,
      status: 400,
      error: `Details must be under ${MAX_REPORT_DETAILS} characters`,
    };
  }
  if (categoryRequiresDetails(category) && !trimmedDetails) {
    return { ok: false, status: 400, error: "Please tell us what's wrong" };
  }

  const target = await resolveReportTarget(targetType, { targetId, username }, actorId);
  if (target.error) return { ok: false, status: 404, error: target.error };

  if (target.targetOwner && idOf(target.targetOwner) === idOf(actorId)) {
    return { ok: false, status: 400, error: "You can't report your own content" };
  }

  /*
   * The de-duplication rule, enforced here rather than by an index. `Report` deliberately has
   * no unique key — "one *open* report per target" cannot be expressed as one, since a
   * resolved report must allow a re-report while a moderator's status change must not be
   * rejected. Worst case under concurrency is a duplicate row in the queue.
   */
  const latest = await findLatestReport(actorId, targetType, target);
  if (!canReportAgain(latest, target)) {
    return { ok: true, alreadyReported: true, report: latest };
  }

  const report = await Report.create({
    reporter: actorId,
    targetType,
    targetId: target.targetId,
    targetKey: target.targetKey,
    targetOwner: target.targetOwner,
    category,
    subcategory: subcategory || null,
    details: trimmedDetails,
    /*
     * Stamped, not gated. A moderator seeing a queue item wants to know whether a person read
     * this and decided it was wrong, or whether a language model did — those warrant different
     * weight, and a report that hides which it was is worse than one that admits it.
     */
    reporterIsBot: Boolean(reporterIsBot),
    metadata: { url: url || null, userAgent: userAgent || null },
  });

  return { ok: true, alreadyReported: false, report };
};
