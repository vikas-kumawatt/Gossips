import mongoose from "mongoose";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import { indexContent } from "../utils/contentIndex.js";
import {
  applyCommentPublishEffects,
  applyPostPublishEffects,
  captureQuotedSnapshot,
} from "../utils/publishing.js";
import {
  canUserReplyToTarget,
  normalizeWhoCanReply,
  replyDeniedMessage,
} from "../utils/replyPermission.js";
import { resolveReplyThread } from "../utils/replyThreading.js";

/**
 * Authoring a post or a comment, as functions.
 *
 * ── Where the line is drawn, and why ────────────────────────────────────────
 *
 * `createPost` and `replyOnPost` are not extracted wholesale, and that is deliberate. Both
 * are genuinely request-shaped in part: they parse multipart uploads out of `req.files`,
 * reuse media from a saved draft, and coerce form-encoded string booleans like `"true"`.
 * A bot has no analogue for any of that — it has no file parts and no drafts — and dragging
 * that machinery into a service to satisfy a symmetry nothing needs would be the wrong
 * abstraction.
 *
 * So the split is: **everything that decides what gets written lives here**, and the
 * controllers keep only the work of turning an HTTP request into arguments. Concretely, the
 * invariants below are the ones that must never differ between a human and a bot, and every
 * one of them is in this file:
 *
 *   · `canUserReplyToTarget` on a quote target and on a reply target
 *   · `captureQuotedSnapshot`, so a quote records what it was quoting at the time
 *   · `resolveReplyThread`, which flattens a thread to two levels
 *   · `indexContent`, which resolves mentions and hashtags
 *   · the "there is actually something here" check
 *   · `applyPostPublishEffects` / `applyCommentPublishEffects`
 *
 * Media, polls and locations arrive already resolved. The caller is responsible for turning
 * uploads into descriptors — a controller by parsing parts, a bot by having none.
 *
 * Same result contract as the other services: `{ ok: true, ... }` or
 * `{ ok: false, status, error }`.
 */

const isId = (value) => mongoose.isValidObjectId(value);

/**
 * Create a post, optionally quoting something.
 *
 * @returns `{ ok, post, scheduled }`
 */
export const createPost = async ({
  actorId,
  content = "",
  media = [],
  poll = null,
  location = null,
  quotedPost = null,
  quotedComment = null,
  whoCanReply,
  isAiGenerated = false,
  /** A Date, already parsed and validated by the caller. Null for "publish now". */
  scheduledFor = null,
  visibility,
}) => {
  /*
   * A quote target has to exist, be visible, and allow this actor to respond.
   *
   * `canUserReplyToTarget` is the same gate a reply goes through, because a quote *is* a
   * response — someone who has restricted replies to people they follow has not consented to
   * being quoted into a stranger's feed either. Checked before anything is written.
   */
  if (quotedPost) {
    if (!isId(quotedPost)) {
      return { ok: false, status: 404, error: "The post being quoted no longer exists" };
    }
    const target = await Post.findOne({ _id: quotedPost, isDeleted: { $ne: true } })
      .select("author whoCanReply mentions")
      .lean();
    if (!target) {
      return { ok: false, status: 404, error: "The post being quoted no longer exists" };
    }
    if (!(await canUserReplyToTarget(actorId, target))) {
      return { ok: false, status: 403, error: replyDeniedMessage(target.whoCanReply) };
    }
  }

  if (quotedComment) {
    if (!isId(quotedComment)) {
      return { ok: false, status: 404, error: "The comment being quoted no longer exists" };
    }
    const target = await Comment.findOne({ _id: quotedComment, isDeleted: { $ne: true } })
      .select("author whoCanReply mentions parent")
      .lean();
    if (!target) {
      return { ok: false, status: 404, error: "The comment being quoted no longer exists" };
    }
    if (!(await canUserReplyToTarget(actorId, target))) {
      return { ok: false, status: 403, error: replyDeniedMessage(target.whoCanReply) };
    }
  }

  const composed = await indexContent(content || "", actorId);

  /*
   * Something has to be here.
   *
   * Checked after attachments are resolved, so a post that is only a poll, only media or only
   * a quote is allowed — an empty one isn't.
   */
  const hasSomething =
    Boolean(content?.trim()) ||
    media.length > 0 ||
    Boolean(poll) ||
    Boolean(quotedPost) ||
    Boolean(quotedComment);
  if (!hasSomething) {
    return { ok: false, status: 400, error: "A post needs text, media or a poll" };
  }

  const post = await Post.create({
    author: actorId,
    content: content || "",
    media,
    poll,
    location,
    mentions: composed.mentionIds,
    hashtags: composed.hashtags,
    quotedPost: quotedPost || null,
    quotedComment: quotedComment || null,
    /*
     * What the quoted thing said at the moment it was quoted.
     *
     * The single most important invariant in this file. A quote renders its target from this
     * snapshot, so an author cannot edit their post afterwards and silently rewrite what a
     * quoter appears to be responding to. A second implementation that forgot it would look
     * correct until someone edited a quoted post.
     */
    quotedSnapshot: await captureQuotedSnapshot(quotedPost, quotedComment),
    whoCanReply: normalizeWhoCanReply(whoCanReply),
    isAiGenerated: Boolean(isAiGenerated),
    ...(visibility ? { visibility } : {}),
    isScheduled: Boolean(scheduledFor),
    scheduledFor: scheduledFor || null,
    scheduleStatus: scheduledFor ? "pending" : null,
  });

  /*
   * Counters, hashtag stats and mention notifications wait until the post is actually
   * visible. A scheduled post applies them when the publisher runs it — see utils/scheduler.js
   * — so applying them here would notify people about something they cannot see yet.
   */
  if (!scheduledFor) {
    await applyPostPublishEffects(post);
  }

  return { ok: true, post, scheduled: Boolean(scheduledFor) };
};

/**
 * Comment on a post, or reply to a comment on it.
 *
 * @returns `{ ok, comment, scheduled }`
 */
export const commentOnPost = async ({
  actorId,
  postId,
  parentId = null,
  content = "",
  media = [],
  poll = null,
  location = null,
  whoCanReply,
  isAiGenerated = false,
  scheduledFor = null,
}) => {
  if (!postId || !isId(postId)) {
    return { ok: false, status: 400, error: "Post ID is required" };
  }

  // Checked after the caller has resolved attachments, so a poll-only or GIF-only reply works.
  if (!content?.trim() && !media.length && !poll && !location) {
    return { ok: false, status: 400, error: "Comment must have content, media or a poll" };
  }

  /*
   * The audience setting of whatever is being replied to: the parent comment for a nested
   * reply, otherwise the post.
   */
  const replyTarget = parentId
    ? await Comment.findById(parentId).select("author whoCanReply mentions parent").lean()
    : await Post.findById(postId).select("author whoCanReply mentions").lean();

  if (parentId && !replyTarget) {
    return { ok: false, status: 404, error: "Comment not found" };
  }
  if (replyTarget && !(await canUserReplyToTarget(actorId, replyTarget))) {
    return { ok: false, status: 403, error: replyDeniedMessage(replyTarget.whoCanReply) };
  }

  /*
   * A thread flattens to two levels: anchor under the top-level comment, and remember which
   * comment was answered. Derived from the *fetched* target rather than the caller's
   * `parentId`, which is what stops anyone anchoring a reply under an arbitrary comment.
   */
  const thread = parentId
    ? resolveReplyThread(replyTarget, parentId)
    : { parent: null, replyTo: null };

  const composed = await indexContent(content || "", actorId);

  const comment = await Comment.create({
    content: content || "",
    post: postId,
    author: actorId,
    parent: thread.parent,
    replyTo: thread.replyTo,
    whoCanReply: normalizeWhoCanReply(whoCanReply),
    mentions: composed.mentionIds,
    hashtags: composed.hashtags,
    isAiGenerated: Boolean(isAiGenerated),
    media,
    location,
    poll,
    isScheduled: Boolean(scheduledFor),
    scheduledFor: scheduledFor || null,
    scheduleStatus: scheduledFor ? "pending" : null,
  });

  // Counters and reply notifications wait until it's actually in the thread.
  if (!scheduledFor) await applyCommentPublishEffects(comment);

  return { ok: true, comment, scheduled: Boolean(scheduledFor) };
};
