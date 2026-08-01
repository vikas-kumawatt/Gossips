import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Notification from "../models/Notification.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import UserRelation from "../models/UserRelation.js";
import PollVote from "../models/PollVote.js";
import { sendNotification } from "../utils/notifications.js";
import { indexContent, bumpHashtagCounts, hashtagDelta } from "../utils/contentIndex.js";
import { MAX_CONTENT_LENGTH, buildVersionList } from "../utils/editHistory.js";
import { parseBooleanFlag } from "../utils/booleanFlag.js";
import {
  canUserReplyToTarget,
  normalizeWhoCanReply,
  replyDeniedMessage,
} from "../utils/replyPermission.js";
import {
  buildCursorPageInfo,
  buildCursorQuery,
  decodeCursor,
  parseCursorLimit,
} from "../utils/cursorPagination.js";
import { applyCommentPublishEffects, parseScheduledFor } from "../utils/publishing.js";
import { resolveReplyThread } from "../utils/replyThreading.js";
import { uploadMedia } from "../utils/uploadFiles.js";
import { decorateContent, openPollClock, parseAttachments } from "../utils/attachments.js";

const AUTHOR_SELECT = "username name bio profilePic isVerified verificationBadge isPrivate";

/**
 * A comment that's actually in the thread: not deleted, and not a reply still
 * waiting for its scheduled time. Posts get this for free because every feed
 * query filters `isDraft`; comments have no such field, so every read path has
 * to spread this in or a scheduled reply appears early.
 */
const LIVE_COMMENT = { isDeleted: { $ne: true }, isScheduled: { $ne: true } };

// ─────────────────────────────────────────────────────────────────────────────
// Create comments / replies
// ─────────────────────────────────────────────────────────────────────────────

export const replyOnPost = async (req, res) => {
  try {
    const { content, postId, parentId, whoCanReply, isAiGenerated, scheduledFor } = req.body;
    const userId = req.user._id;

    if (!postId) return res.status(400).json({ error: "Post ID is required" });

    const { at: scheduleAt, error: scheduleError } = parseScheduledFor(scheduledFor);
    if (scheduleError) return res.status(400).json({ error: scheduleError, message: scheduleError });

    const attached = await parseAttachments({
      files: req.files || [],
      body: req.body,
      uploader: uploadMedia,
    });
    if (attached.error) {
      return res.status(400).json({ error: attached.error, message: attached.error });
    }

    // Checked after parsing so a poll-only or GIF-only reply is allowed.
    if (!content?.trim() && !attached.media.length && !attached.poll && !attached.location) {
      return res.status(400).json({ error: "Comment must have content, media or a poll" });
    }

    // Enforce the audience setting of whatever is being replied to:
    // the parent comment if this is a nested reply, otherwise the post.
    const replyTarget = parentId
      ? await Comment.findById(parentId).select("author whoCanReply mentions parent").lean()
      : await Post.findById(postId).select("author whoCanReply mentions").lean();
    if (parentId && !replyTarget) {
      return res.status(404).json({ error: "Comment not found" });
    }
    if (replyTarget && !(await canUserReplyToTarget(userId, replyTarget))) {
      return res.status(403).json({
        success: false,
        error: replyDeniedMessage(replyTarget.whoCanReply),
        message: replyDeniedMessage(replyTarget.whoCanReply),
      });
    }

    // A reply flattens to two levels just like the nested-comment path: anchor
    // under the top-level comment, remember the comment answered. Deriving this
    // from the fetched target (not the raw body) keeps the thread two-deep and
    // stops a client anchoring under an arbitrary comment.
    const thread = parentId ? resolveReplyThread(replyTarget, parentId) : { parent: null, replyTo: null };

    const composed = await indexContent(content || "", userId);

    const newComment = {
      content: content || "",
      post: postId,
      author: userId,
      parent: thread.parent,
      replyTo: thread.replyTo,
      whoCanReply: normalizeWhoCanReply(whoCanReply),
      mentions: composed.mentionIds,
      hashtags: composed.hashtags,
      isAiGenerated: parseBooleanFlag(isAiGenerated),
      media: attached.media,
      location: attached.location,
      // The clock starts when the reply appears, not when it was written.
      poll: attached.poll && !scheduleAt ? openPollClock(attached.poll) : attached.poll,
      isScheduled: Boolean(scheduleAt),
      scheduledFor: scheduleAt,
      scheduleStatus: scheduleAt ? "pending" : null,
    };

    const comment = await Comment.create(newComment);

    // Counters and reply notifications wait until it's actually in the thread.
    if (!scheduleAt) await applyCommentPublishEffects(comment);

    const populated = await Comment.findById(comment._id)
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "replyTo",
        select: "_id content author",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .lean();

    res.status(201).json({
      comment: await decorateContent(populated, userId),
      scheduled: Boolean(scheduleAt),
    });
  } catch (error) {
    console.error("replyOnPost error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const createNestedComment = async (req, res) => {
  try {
    // `parentId` is intentionally not read from the body: the structural parent
    // is derived server-side (see resolveReplyThread) so a client can't anchor a
    // reply under an arbitrary comment.
    const { content, commentId, whoCanReply, isAiGenerated, scheduledFor } = req.body;
    const userId = req.user._id;

    if (!commentId) return res.status(400).json({ error: "Comment ID is required" });

    const { at: scheduleAt, error: scheduleError } = parseScheduledFor(scheduledFor);
    if (scheduleError) return res.status(400).json({ error: scheduleError, message: scheduleError });

    const attached = await parseAttachments({
      files: req.files || [],
      body: req.body,
      uploader: uploadMedia,
    });
    if (attached.error) {
      return res.status(400).json({ error: attached.error, message: attached.error });
    }

    if (!content?.trim() && !attached.media.length && !attached.poll && !attached.location) {
      return res.status(400).json({ error: "Comment must have content, media or a poll" });
    }

    const originalComment = await Comment.findById(commentId)
      .select("post author parent whoCanReply mentions")
      .lean();
    if (!originalComment) return res.status(404).json({ error: "Comment not found" });

    // Enforce the comment author's reply audience setting.
    if (!(await canUserReplyToTarget(userId, originalComment))) {
      return res.status(403).json({
        success: false,
        error: replyDeniedMessage(originalComment.whoCanReply),
        message: replyDeniedMessage(originalComment.whoCanReply),
      });
    }

    const postId = originalComment.post;
    // Flatten to two levels: anchor under the top-level comment, remember the
    // comment actually answered.
    const { parent: effectiveParent, replyTo } = resolveReplyThread(originalComment, commentId);

    const replyComposed = await indexContent(content || "", userId);

    const newComment = {
      content: content || "",
      post: postId,
      author: userId,
      parent: effectiveParent,
      replyTo,
      whoCanReply: normalizeWhoCanReply(whoCanReply),
      mentions: replyComposed.mentionIds,
      hashtags: replyComposed.hashtags,
      isAiGenerated: parseBooleanFlag(isAiGenerated),
      media: attached.media,
      location: attached.location,
      poll: attached.poll && !scheduleAt ? openPollClock(attached.poll) : attached.poll,
      isScheduled: Boolean(scheduleAt),
      scheduledFor: scheduleAt,
      scheduleStatus: scheduleAt ? "pending" : null,
    };

    const comment = await Comment.create(newComment);

    if (!scheduleAt) await applyCommentPublishEffects(comment);

    const populated = await Comment.findById(comment._id)
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "replyTo",
        select: "_id content author",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .lean();

    res.status(201).json({
      comment: await decorateContent(populated, userId),
      scheduled: Boolean(scheduleAt),
    });
  } catch (error) {
    console.error("createNestedComment error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch comments
// ─────────────────────────────────────────────────────────────────────────────

export const getCommentsWithReplies = async (req, res) => {
  try {
    const { postId } = req.params;
    const { limit = 10, cursor } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    if (!postId) return res.status(400).json({ error: "Post ID is required" });

    const topLevel = await Comment.find({ post: postId, parent: null, ...LIVE_COMMENT, ...cursorQuery })
      // `_id` tiebreaker keeps cursor pagination stable across equal timestamps.
      .sort({ createdAt: -1, _id: -1 })
      .limit(limitNum + 1)
      .populate("author", AUTHOR_SELECT)
      .lean();

    // Replies are loaded lazily and paginated by the client (getRepliesForComment),
    // so top-level comments carry only their cached `counts.replies` here — no
    // per-comment reply sub-query. `counts.replies` counts the whole flat thread.
    const viewerId = req.user?._id;
    const commentsWithReplies = await Promise.all(
      topLevel.map(async (comment) => ({
        ...comment,
        viewerCanReply: await canUserReplyToTarget(viewerId, comment),
      }))
    );

    const { items: pagedComments, pageInfo } = buildCursorPageInfo(commentsWithReplies, limitNum);
    res.status(200).json({
      comments: await decorateContent(pagedComments, viewerId),
      pageInfo,
    });
  } catch (error) {
    console.error("getCommentsWithReplies error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getRepliesForComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);
    // Replies read oldest-first (conversational order), so the cursor pages
    // forward with `$gt` — the sort direction and cursor must agree.
    const cursorQuery = buildCursorQuery(parsedCursor, "asc");

    if (!commentId) return res.status(400).json({ error: "Comment ID is required" });

    const comments = await Comment.find({
      parent: commentId,
      ...LIVE_COMMENT,
      ...cursorQuery,
    })
      // `_id` is the tiebreaker the cursor uses, so the sort must include it or
      // replies sharing a `createdAt` paginate inconsistently (rows repeat or
      // vanish across pages).
      .sort({ createdAt: 1, _id: 1 })
      .limit(limitNum + 1)
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "replyTo",
        select: "_id author",
        populate: { path: "author", select: "username" },
      })
      .lean();

    const viewerId = req.user?._id;
    const withViewer = await Promise.all(
      comments.map(async (c) => ({
        ...c,
        viewerCanReply: await canUserReplyToTarget(viewerId, c),
      }))
    );

    const { items: pagedComments, pageInfo } = buildCursorPageInfo(withViewer, limitNum);
    res.status(200).json({
      comments: await decorateContent(pagedComments, viewerId),
      pageInfo,
    });
  } catch (error) {
    console.error("getRepliesForComment error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const { cursor, limit = 10, parentId, parentOnly = false } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    const query = {
      post: postId,
      parent: parentOnly ? null : parentId || null,
      ...LIVE_COMMENT,
    };

    const comments = await Comment.find({ ...query, ...cursorQuery })
      .populate("author", AUTHOR_SELECT)
      // `_id` tiebreaker keeps cursor pagination stable across equal timestamps.
      .sort({ createdAt: -1, _id: -1 })
      .limit(limitNum + 1)
      .lean();

    const viewerId = req.user?._id;
    const withViewer = await Promise.all(
      comments.map(async (c) => ({
        ...c,
        viewerCanReply: await canUserReplyToTarget(viewerId, c),
      }))
    );

    const { items: pagedComments, pageInfo } = buildCursorPageInfo(withViewer, limitNum);
    res.status(200).json({
      comments: await decorateContent(pagedComments, viewerId),
      pageInfo,
    });
  } catch (error) {
    console.error("getComments error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getComment = async (req, res) => {
  try {
    const { commentId } = req.params;

    const comment = await Comment.findOne({ _id: commentId, ...LIVE_COMMENT })
      .populate({
        path: "post",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .populate("author", AUTHOR_SELECT)
      .lean();

    if (!comment) return res.status(404).json({ error: "Comment not found" });
    const viewerId = req.user?._id;
    const viewerCanReply = viewerId ? await canUserReplyToTarget(viewerId, comment) : true;
    const decorated = await decorateContent(comment, viewerId);
    // The populated parent post carries its own media/poll; decorateContent
    // recurses into quotes, not into `post`, so it's handled explicitly.
    if (decorated.post) await decorateContent(decorated.post, viewerId);
    res.status(200).json({ ...decorated, viewerCanReply });
  } catch (error) {
    console.error("getComment error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Like
// ─────────────────────────────────────────────────────────────────────────────

export const likeComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user._id;

    const comment = await Comment.findOne({ _id: commentId, ...LIVE_COMMENT })
      .select("author post counts")
      .lean();
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const existing = await Like.findOne({ user: userId, targetType: "Comment", target: commentId });

    let liked;
    if (existing) {
      await Like.deleteOne({ _id: existing._id });
      await Comment.updateOne({ _id: commentId }, { $inc: { "counts.likes": -1 } });
      liked = false;
    } else {
      await Like.create({ user: userId, targetType: "Comment", target: commentId });
      await Comment.updateOne({ _id: commentId }, { $inc: { "counts.likes": 1 } });
      liked = true;

      if (comment.author.toString() !== userId.toString()) {
        await sendNotification(comment.author, userId, "comment_like", {
          entity: commentId,
          entityType: "Comment",
        });
      }
    }

    const updated = await Comment.findById(commentId).select("counts").lean();
    res.status(200).json({
      message: liked ? "Comment liked successfully" : "Comment unliked successfully",
      liked,
      counts: updated.counts,
    });
  } catch (error) {
    console.error("likeComment error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Repost
// ─────────────────────────────────────────────────────────────────────────────

export const repostComment = async (req, res) => {
  try {
    const commentId = req.params.id;
    const userId = req.user.id;

    const comment = await Comment.findOne({ _id: commentId, ...LIVE_COMMENT })
      .select("author counts")
      .populate("author", AUTHOR_SELECT)
      .lean();
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    const existing = await Repost.findOne({ user: userId, targetType: "Comment", target: commentId });

    if (existing) {
      await Repost.deleteOne({ _id: existing._id });
      await Comment.updateOne({ _id: commentId }, { $inc: { "counts.reposts": -1 } });
      const updated = await Comment.findById(commentId).select("counts").lean();
      return res.status(200).json({ message: "Repost removed", reposted: false, counts: updated?.counts });
    }

    await Repost.create({ user: userId, targetType: "Comment", target: commentId });
    await Comment.updateOne({ _id: commentId }, { $inc: { "counts.reposts": 1 } });
    const updated = await Comment.findById(commentId).select("counts").lean();
    return res.status(200).json({ message: "Comment reposted", reposted: true, counts: updated?.counts });
  } catch (error) {
    console.error("repostComment error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────────────────────────────────────

// Update who can reply to / quote a comment (author only)
export const updateCommentWhoCanReply = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { whoCanReply } = req.body;
    const userId = req.user._id;

    const comment = await Comment.findById(commentId).select("author isDeleted").lean();
    if (!comment || comment.isDeleted) {
      return res.status(404).json({ error: "Comment not found" });
    }
    if (comment.author.toString() !== userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const value = normalizeWhoCanReply(whoCanReply);
    await Comment.updateOne({ _id: commentId }, { $set: { whoCanReply: value } });

    return res.status(200).json({
      success: true,
      whoCanReply: value,
      message: "Reply audience updated",
    });
  } catch (error) {
    console.error("updateCommentWhoCanReply error:", error);
    return res.status(500).json({ error: "Failed to update reply audience" });
  }
};

/**
 * PATCH /reply/:commentId/edit — change a comment's text.
 *
 * Text only, no time limit, author only. Mirrors editPost: no counts, no
 * notifications, mentions re-resolved for whoCanReply === "mentioned".
 */
export const editComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content, isAiGenerated } = req.body;
    const userId = req.user._id;

    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "Comment can't be empty" });
    }
    const trimmed = content.trim();
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      return res
        .status(400)
        .json({ error: `Comment must be under ${MAX_CONTENT_LENGTH} characters` });
    }

    // editHistory is select:false, so ask for it explicitly.
    const comment = await Comment.findById(commentId).select("+editHistory");
    if (!comment || comment.isDeleted) {
      return res.status(404).json({ error: "Comment not found" });
    }
    if (comment.author.toString() !== userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }
    // Mirrors the isDraft guard in editPost. Editing something nobody has seen
    // isn't an edit — it would stamp "Edited" on a reply at the moment it first
    // appears. Cancel and re-post instead.
    if (comment.isScheduled) {
      return res.status(400).json({ error: "Cancel the schedule to change this reply" });
    }

    // Only a genuine change counts — see the note in editPost about why this
    // compares trimmed-to-trimmed.
    if ((comment.content || "").trim() !== trimmed) {
      const before = comment.hashtags || [];
      const edited = await indexContent(trimmed, comment.author?._id || comment.author);
      await comment.editContent(trimmed, edited.mentionIds, edited.hashtags);

      // Difference only, and no fresh mention notifications — see editPost.
      const { added, removed } = hashtagDelta(before, edited.hashtags);
      bumpHashtagCounts(added, 1);
      bumpHashtagCounts(removed, -1);
    }

    // Toggling the AI disclosure isn't a change to what the comment says, so
    // it doesn't record a history entry or mark the comment edited.
    if (typeof isAiGenerated === "boolean" && isAiGenerated !== comment.isAiGenerated) {
      comment.isAiGenerated = isAiGenerated;
      await comment.save();
    }

    // `post` is populated because some read paths (profile reposts) return it
    // that way, and the client merges this response over the existing item.
    const populated = await Comment.findById(commentId)
      .populate("author", AUTHOR_SELECT)
      .populate("post", "_id")
      .lean();

    return res.status(200).json({
      success: true,
      message: "Comment updated",
      /*
       * Decorated, like editPost's response. EditContentSheet merges this over
       * the card's existing data, so an undecorated doc overwrites the
       * projected poll with live vote counts, the normalised media with the raw
       * array, and leaves `mentionUsernames` absent — which, because a missing
       * key doesn't overwrite, silently kept the pre-edit mention links.
       */
      comment: await decorateContent(populated, req.user._id),
    });
  } catch (error) {
    console.error("editComment error:", error);
    return res.status(500).json({ error: "Failed to update comment" });
  }
};

/**
 * GET /reply/:commentId/edit-history — every version oldest first, current last.
 */
export const getCommentEditHistory = async (req, res) => {
  try {
    const comment = await Comment.findOne({ _id: req.params.commentId, ...LIVE_COMMENT })
      .select("+editHistory author content createdAt editedAt isEdited isDeleted")
      .lean();
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    // "Public" means public to whoever can see the comment, not to anyone
    // holding its id.
    const userId = req.user._id;
    if (
      comment.author.toString() !== userId.toString() &&
      (await UserRelation.eitherBlocks(userId, comment.author))
    ) {
      return res.status(404).json({ error: "Comment not found" });
    }

    return res.status(200).json({
      success: true,
      ...buildVersionList(comment),
    });
  } catch (error) {
    console.error("getCommentEditHistory error:", error);
    return res.status(500).json({ error: "Failed to load edit history" });
  }
};

export const deleteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user._id;

    const comment = await Comment.findById(commentId)
      .select("author post parent isDeleted isScheduled")
      .lean();
    if (!comment || comment.isDeleted) {
      return res.status(404).json({ error: "Comment not found" });
    }
    if (comment.author.toString() !== userId.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Collect all nested comment IDs recursively
    const collectNested = async (parentId) => {
      const children = await Comment.find({ parent: parentId }).select("_id").lean();
      let ids = children.map((c) => c._id.toString());
      for (const child of children) {
        ids = ids.concat(await collectNested(child._id));
      }
      return ids;
    };

    const nestedIds = await collectNested(commentId);
    const allIds = [commentId, ...nestedIds];

    // Scheduled replies never incremented the counters, so they mustn't
    // decrement them either — only the ones that actually reached the thread.
    const scheduledCount = await Comment.countDocuments({
      _id: { $in: allIds },
      isScheduled: true,
    });
    const totalDeleted = allIds.length - scheduledCount;

    /*
     * Read the tags before the rows go. A deleted reply's hashtags have to
     * give their counts back or trending slowly fills with tags nothing
     * carries any more.
     */
    const goneTags = (
      await Comment.find({ _id: { $in: allIds }, isScheduled: { $ne: true } })
        .select("hashtags")
        .lean()
    ).flatMap((c) => c.hashtags || []);

    await Comment.deleteMany({ _id: { $in: allIds } });
    await Notification.deleteMany({ entity: { $in: allIds }, entityType: "Comment" });
    bumpHashtagCounts(goneTags, -1);
    await PollVote.deleteMany({ target: { $in: allIds } });

    // Decrement reply counts on post and parent comment
    if (totalDeleted > 0) {
      await Post.updateOne({ _id: comment.post }, { $inc: { "counts.replies": -totalDeleted } });
      if (comment.parent && !comment.isScheduled) {
        await Comment.updateOne(
          { _id: comment.parent },
          { $inc: { "counts.replies": -totalDeleted } }
        );
      }
    }

    res.json({ message: "Comment and its replies deleted successfully" });
  } catch (error) {
    console.error("deleteComment error:", error);
    res.status(500).json({ error: "Server error" });
  }
};
