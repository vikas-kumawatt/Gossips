import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import User from "../models/User.js";
import { sendNotification } from "./notifications.js";
import { del, CacheKeys } from "./cache.js";

/**
 * The side effects of a post or comment becoming visible.
 *
 * Shared by immediate posting and the scheduled publisher so the two can't
 * drift — a scheduled post has to bump exactly the same counters and fire
 * exactly the same notifications as one posted by hand, just later.
 */

export const SCHEDULE_MAX_DAYS = 30;
// A minute of slack: the picker's minute column means "now + a few seconds"
// is easy to select by accident, and the poller wouldn't reach it in time.
const MIN_LEAD_MS = 60 * 1000;

/**
 * Validates a requested time. Returns { at } or { error }.
 */
export const parseScheduledFor = (value) => {
  if (value === undefined || value === null || value === "") return { at: null };

  // `new Date()` is happy to coerce arrays and objects into something
  // plausible, so only the shapes a client can legitimately send get through.
  const isDateLike =
    typeof value === "string" || typeof value === "number" || value instanceof Date;
  if (!isDateLike) return { error: "That isn't a valid date and time" };

  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return { error: "That isn't a valid date and time" };

  const now = Date.now();
  if (at.getTime() < now + MIN_LEAD_MS) {
    return { error: "Pick a time at least a minute from now" };
  }
  if (at.getTime() > now + SCHEDULE_MAX_DAYS * 24 * 60 * 60 * 1000) {
    return { error: `You can schedule up to ${SCHEDULE_MAX_DAYS} days ahead` };
  }
  return { at };
};

/** Freeze what the quoted post/comment says at the moment this goes public. */
export const captureQuotedSnapshot = async (quotedPostId, quotedCommentId) => {
  const id = quotedPostId || quotedCommentId;
  if (!id) return null;

  const Model = quotedPostId ? Post : Comment;
  const doc = await Model.findById(id).select("content editedAt createdAt").lean();
  if (!doc) return null;

  return {
    content: doc.content || "",
    versionAt: doc.editedAt || doc.createdAt,
  };
};

/**
 * Everything that happens when a post becomes visible: the author's post count,
 * the quote notification and counter, the snapshot of what was quoted, and the
 * profile cache.
 *
 * The snapshot is taken here rather than at creation because a scheduled post
 * quotes what the original said *when it published*, which is the version
 * readers will actually see next to it.
 */
export const applyPostPublishEffects = async (post, { authorUsername } = {}) => {
  const authorId = post.author?._id || post.author;

  await User.updateOne({ _id: authorId }, { $inc: { "counts.posts": 1 } });

  const snapshot = await captureQuotedSnapshot(post.quotedPost, post.quotedComment);
  if (snapshot) {
    await Post.updateOne({ _id: post._id }, { $set: { quotedSnapshot: snapshot } });
  }

  if (post.isQuoteRepost && post.quotedPost) {
    const original = await Post.findById(post.quotedPost).select("author").lean();
    if (original && original.author.toString() !== authorId.toString()) {
      await sendNotification(original.author, authorId, "quote", {
        entity: post._id,
        entityType: "Post",
      });
      await Post.updateOne({ _id: post.quotedPost }, { $inc: { "counts.quotes": 1 } });
    }
  }

  if (post.isQuoteComment && post.quotedComment) {
    const original = await Comment.findById(post.quotedComment).select("author").lean();
    if (original && original.author.toString() !== authorId.toString()) {
      await sendNotification(original.author, authorId, "quote_comment", {
        entity: post._id,
        entityType: "Post",
      });
    }
  }

  const username = authorUsername || (await User.findById(authorId).select("username").lean())?.username;
  if (username) await del(CacheKeys.userPosts(username)).catch(() => {});
};

/**
 * Everything that happens when a reply becomes visible: the reply counters on
 * the post and the parent comment, and the notifications to whoever is being
 * replied to.
 */
export const applyCommentPublishEffects = async (comment) => {
  const authorId = comment.author?._id || comment.author;
  const parentId = comment.parent;
  // The comment actually answered. Equals `parent` for a direct reply to a
  // top-level comment; differs for a reply made on another reply.
  const replyToId = comment.replyTo || parentId;

  await Post.updateOne({ _id: comment.post }, { $inc: { "counts.replies": 1 } });
  // `parent` is the top-level comment for every reply, so its count is the whole
  // flat thread's size.
  if (parentId) {
    await Comment.updateOne({ _id: parentId }, { $inc: { "counts.replies": 1 } });
  }

  const post = await Post.findById(comment.post).select("author").lean();

  // Never notify yourself, and never the same person twice.
  const notified = new Set([authorId.toString()]);
  const notify = async (userId) => {
    if (!userId) return;
    const key = userId.toString();
    if (notified.has(key)) return;
    notified.add(key);
    await sendNotification(userId, authorId, "reply", {
      entity: comment._id,
      entityType: "Comment",
    });
  };

  // Top-level comment on the post → tell the post author.
  if (!parentId) {
    await notify(post?.author);
    return;
  }

  // A reply → tell whoever was actually replied to.
  const replyTo = await Comment.findById(replyToId).select("author").lean();
  await notify(replyTo?.author);

  // A direct reply to a top-level comment also reaches the post author (matches
  // the pre-flattening behaviour); a reply made on another reply notifies only
  // the person answered.
  if (String(replyToId) === String(parentId)) await notify(post?.author);
};
