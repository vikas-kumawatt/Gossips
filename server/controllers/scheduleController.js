import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import PollVote from "../models/PollVote.js";
import { ok, fail, serverError } from "../utils/respond.js";
import { parseScheduledFor } from "../utils/publishing.js";
import { publishNow } from "../utils/scheduler.js";

/**
 * The author's own view of what they've scheduled: list, reschedule, publish
 * early, cancel.
 *
 * Posts and comments are two collections but one list to the user, so every
 * handler takes a `type` in the path and dispatches on it rather than
 * duplicating four endpoints.
 */

const AUTHOR_SELECT = "_id username name profilePic isVerified verificationBadge";

const MODELS = { post: Post, comment: Comment };

/**
 * Loads a scheduled item the caller is allowed to act on. Returns
 * { error, status } instead of the doc when it isn't actionable, so each
 * handler reports the same reasons the same way.
 */
const loadOwned = async (type, id, userId) => {
  const Model = MODELS[type];
  if (!Model) return { status: 400, error: "Unknown item type" };

  // A scheduled post deleted through the normal delete endpoint keeps its
  // pending row; it shouldn't be actionable here.
  const doc = await Model.findOne({ _id: id, author: userId, isDeleted: { $ne: true } });
  if (!doc) return { status: 404, error: "Scheduled item not found" };

  if (doc.scheduleStatus === "published") {
    return { status: 409, error: "This has already been posted" };
  }
  // The publisher holds this claim while it works. Editing underneath it would
  // race, and the window is seconds, so ask the caller to retry.
  if (doc.scheduleStatus === "publishing") {
    return { status: 409, error: "This is being posted right now" };
  }
  if (!doc.scheduleStatus) {
    return { status: 400, error: "This isn't a scheduled item" };
  }

  return { doc, Model };
};

// ─────────────────────────────────────────────────────────────────────────────

export const getScheduled = async (req, res) => {
  try {
    const userId = req.user._id;
    const filter = {
      author: userId,
      scheduleStatus: { $in: ["pending", "publishing", "failed"] },
      isDeleted: { $ne: true },
    };

    const [posts, comments] = await Promise.all([
      Post.find(filter)
        .select(
          "content media poll location icon scheduledFor scheduleStatus scheduleError isAiGenerated " +
            "whoCanReply quotedPost quotedComment quotedSnapshot isQuoteRepost isQuoteComment createdAt"
        )
        .populate("author", AUTHOR_SELECT)
        // `mentions` so decorateContent can decide which handles link.
        .populate({ path: "quotedPost", select: "content media mentions author createdAt", populate: { path: "author", select: AUTHOR_SELECT } })
        .populate({ path: "quotedComment", select: "content media mentions author createdAt", populate: { path: "author", select: AUTHOR_SELECT } })
        .sort({ scheduledFor: 1 })
        .lean(),
      Comment.find(filter)
        .select("content media poll location scheduledFor scheduleStatus scheduleError isAiGenerated whoCanReply post parent createdAt")
        .populate("author", AUTHOR_SELECT)
        .populate({ path: "post", select: "content author", populate: { path: "author", select: AUTHOR_SELECT } })
        .sort({ scheduledFor: 1 })
        .lean(),
    ]);

    // One chronological list — the user scheduled things, not "posts" and
    // "comments" separately.
    const items = [
      ...posts.map((p) => ({ ...p, type: "post" })),
      ...comments.map((c) => ({ ...c, type: "comment" })),
    ].sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));

    return ok(res, { items });
  } catch (error) {
    return serverError(res, error, "Failed to load scheduled posts");
  }
};

export const rescheduleItem = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { doc, error, status } = await loadOwned(type, id, req.user._id);
    if (error) return fail(res, error, status);

    const { at, error: timeError } = parseScheduledFor(req.body.scheduledFor);
    if (timeError) return fail(res, timeError);
    if (!at) return fail(res, "Pick a new time");

    doc.scheduledFor = at;
    // A failed item that's given a new time goes back in the queue with a
    // clean slate, otherwise its old attempts would exhaust the retries.
    doc.scheduleStatus = "pending";
    doc.scheduleError = null;
    doc.scheduleAttempts = 0;
    await doc.save();

    return ok(res, { id: doc._id, type, scheduledFor: doc.scheduledFor, scheduleStatus: doc.scheduleStatus });
  } catch (error) {
    return serverError(res, error, "Failed to reschedule");
  }
};

export const publishScheduledNow = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { error, status } = await loadOwned(type, id, req.user._id);
    if (error) return fail(res, error, status);

    // Runs through the same publisher as the timed path — claim included — so
    // pressing "Post now" a hair before the scheduled tick can't double-post.
    const result = await publishNow(type, id, req.user._id);
    if (!result.ok) return fail(res, result.error, result.status || 409);

    return ok(res, { id, type, published: true });
  } catch (error) {
    return serverError(res, error, "Failed to post now");
  }
};

export const cancelScheduled = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { doc, Model, error, status } = await loadOwned(type, id, req.user._id);
    if (error) return fail(res, error, status);

    // Nothing was ever public and no counters moved, so there's nothing to
    // soft-delete for thread integrity — it can just go. The status is
    // re-checked in the delete filter because the publisher may have claimed
    // it in the moment since loadOwned looked.
    const result = await Model.deleteOne({ _id: doc._id, scheduleStatus: { $ne: "publishing" } });
    if (result.deletedCount === 1) await PollVote.deleteMany({ target: doc._id });
    if (result.deletedCount !== 1) {
      return fail(res, "This is being posted right now", 409);
    }
    return ok(res, { id, type, cancelled: true });
  } catch (error) {
    return serverError(res, error, "Failed to cancel");
  }
};
