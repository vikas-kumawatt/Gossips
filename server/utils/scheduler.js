import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import User from "../models/User.js";
import { sendNotification } from "./notifications.js";
import { getSettings } from "./settings.js";
import { canUserReplyToTarget } from "./replyPermission.js";
import { applyPostPublishEffects, applyCommentPublishEffects } from "./publishing.js";

/**
 * Publishes scheduled posts and replies when their time comes.
 *
 * There's no job queue in this project, so this is an interval poller. Three
 * things make that safe rather than naive:
 *
 *  - Each item is *claimed* with an atomic findOneAndUpdate from "pending" to
 *    "publishing". If the app runs on more than one instance, only one wins the
 *    claim, so nothing publishes twice.
 *  - The transition out of "publishing" is the exactly-once gate. Every write
 *    that ends a publish attempt — success or failure — is conditional on the
 *    item still being in "publishing", so nothing can be published, failed or
 *    requeued twice.
 *  - A stale claim is reaped. If a process dies mid-publish the item would sit
 *    in "publishing" forever, so anything stuck there past a timeout is
 *    requeued — at the cost of an attempt, in case that item is what killed
 *    the process.
 */

const TICK_MS = 30 * 1000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// Linear backoff between attempts: 10 min, then 20.
const RETRY_BACKOFF_MS = 10 * 60 * 1000;
// One tick shouldn't monopolise the process if a backlog has built up.
const BATCH_PER_TICK = 25;

let timer = null;
let running = false;

/** When a poll attached to a just-published item should close. */
const pollClosesAt = (poll) => new Date(Date.now() + poll.durationMinutes * 60 * 1000);

const fail = async (Model, doc, reason) => {
  const attempts = (doc.scheduleAttempts || 0) + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;

  const result = await Model.updateOne(
    // Only an item still holding the claim can be failed. Once the publish
    // flip has gone through, the item is live — sending it back to "pending"
    // here would have the next tick post it a second time.
    { _id: doc._id, scheduleStatus: "publishing" },
    {
      $set: {
        // Transient problems go back in the queue; a permanent one stops here.
        scheduleStatus: giveUp ? "failed" : "pending",
        scheduleError: reason,
        scheduleAttempts: attempts,
        // Without pushing the time out, "pending" is instantly due again and
        // all three attempts burn inside a single minute — which defeats the
        // point of retrying things like a suspension that may yet be lifted.
        ...(giveUp ? {} : { scheduledFor: new Date(Date.now() + attempts * RETRY_BACKOFF_MS) }),
      },
    }
  );
  if (result.modifiedCount !== 1) return;

  if (giveUp) {
    await sendNotification(doc.author, doc.author, "scheduled_failed", {
      entity: doc._id,
      entityType: doc.post ? "Comment" : "Post",
    }).catch(() => {});
  }
};

/**
 * Drops an item out of the queue without telling anyone. Used when the author
 * already knows — they deleted it — so a "couldn't be posted" notification
 * would just be noise about something they threw away on purpose.
 */
const abandon = (Model, doc, reason) =>
  Model.updateOne(
    { _id: doc._id, scheduleStatus: "publishing" },
    { $set: { scheduleStatus: "failed", scheduleError: reason, scheduleAttempts: MAX_ATTEMPTS } }
  );

/** Permanent failures — retrying won't help, so don't burn attempts on them. */
const permanentFail = async (Model, doc, reason) => {
  const result = await Model.updateOne(
    // Conditional for the same reason as `fail`: only the holder of the claim
    // gets to decide how this attempt ended.
    { _id: doc._id, scheduleStatus: "publishing" },
    { $set: { scheduleStatus: "failed", scheduleError: reason, scheduleAttempts: MAX_ATTEMPTS } }
  );
  if (result.modifiedCount !== 1) return;

  await sendNotification(doc.author, doc.author, "scheduled_failed", {
    entity: doc._id,
    entityType: doc.post ? "Comment" : "Post",
  }).catch(() => {});
};

// ─────────────────────────────────────────────────────────────────────────────

const publishPost = async (post) => {
  // Deleting rather than cancelling leaves a pending row behind; publishing it
  // would resurrect something the author threw away.
  if (post.isDeleted) {
    return abandon(Post, post, "This was deleted before it could be posted");
  }

  const author = await User.findById(post.author).select("username accountStatus").lean();

  if (!author) {
    return permanentFail(Post, post, "The author's account no longer exists");
  }
  if (author.accountStatus !== "active") {
    // Could come back — a suspension ends. Retry rather than discard.
    return fail(Post, post, "The author's account isn't active");
  }

  // The thing being quoted may have been deleted since scheduling.
  if (post.quotedPost) {
    const exists = await Post.exists({ _id: post.quotedPost, isDeleted: { $ne: true } });
    if (!exists) return permanentFail(Post, post, "The quoted post was deleted");
  }
  if (post.quotedComment) {
    const exists = await Comment.exists({ _id: post.quotedComment, isDeleted: { $ne: true } });
    if (!exists) return permanentFail(Post, post, "The quoted comment was deleted");
  }

  /*
   * This flip is the exactly-once gate for everything below it.
   *
   * Matching on "publishing" means only the process still holding the claim
   * can make the post live, and only once — after this the status is
   * "published", which no claim query matches. So the counters and
   * notifications underneath can't run twice, and a cancel or delete that
   * slipped in during the checks above stops the post going out at all.
   *
   * The cost is that a crash in the narrow window between here and the effects
   * leaves a live post with its counters unbumped. That's the right way round:
   * an off-by-one count is a smaller harm than posting the same thing twice
   * and notifying everyone twice.
   */
  const result = await Post.updateOne(
    { _id: post._id, scheduleStatus: "publishing" },
    {
      $set: {
        isDraft: false,
        scheduleStatus: "published",
        scheduleError: null,
        // Publishing is the moment it enters the feed, so this is its
        // chronological position — not when it was composed.
        createdAt: new Date(),
        // A poll's clock starts now too. Setting it at compose time would mean
        // a poll scheduled for tomorrow had already been running overnight and
        // might close the instant it appeared.
        ...(post.poll?.question ? { "poll.closesAt": pollClosesAt(post.poll) } : {}),
      },
    }
  );
  if (result.modifiedCount !== 1) return;

  await applyPostPublishEffects(post, { authorUsername: author.username });

  await sendNotification(post.author, post.author, "scheduled_published", {
    entity: post._id,
    entityType: "Post",
  }).catch(() => {});
};

const publishComment = async (comment) => {
  if (comment.isDeleted) {
    return abandon(Comment, comment, "This was deleted before it could be posted");
  }

  const author = await User.findById(comment.author).select("accountStatus").lean();

  if (!author) {
    return permanentFail(Comment, comment, "The author's account no longer exists");
  }
  if (author.accountStatus !== "active") {
    return fail(Comment, comment, "The author's account isn't active");
  }

  const post = await Post.findOne({ _id: comment.post, isDeleted: { $ne: true } })
    .select("author whoCanReply mentions")
    .lean();
  if (!post) {
    return permanentFail(Comment, comment, "The post was deleted");
  }

  let replyTarget = post;
  if (comment.parent) {
    const parent = await Comment.findOne({ _id: comment.parent, isDeleted: { $ne: true } })
      .select("author whoCanReply mentions")
      .lean();
    if (!parent) {
      return permanentFail(Comment, comment, "The comment you replied to was deleted");
    }
    replyTarget = parent;
  }

  // The audience setting can change between scheduling and publishing, so the
  // permission is re-checked rather than trusted from compose time.
  if (!(await canUserReplyToTarget(comment.author, replyTarget))) {
    return permanentFail(Comment, comment, "You can no longer reply to this");
  }

  // The conditional flip is the exactly-once gate — see publishPost.
  const result = await Comment.updateOne(
    { _id: comment._id, scheduleStatus: "publishing" },
    {
      $set: {
        isScheduled: false,
        scheduleStatus: "published",
        scheduleError: null,
        createdAt: new Date(),
        ...(comment.poll?.question ? { "poll.closesAt": pollClosesAt(comment.poll) } : {}),
      },
    }
  );
  if (result.modifiedCount !== 1) return;

  await applyCommentPublishEffects(comment);

  await sendNotification(comment.author, comment.author, "scheduled_published", {
    entity: comment._id,
    entityType: "Comment",
  }).catch(() => {});
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claims one due item and publishes it. Returns false when nothing is due, so
 * the caller can stop early instead of scanning the batch limit every tick.
 */
const claimAndPublish = async (Model, publish) => {
  const claimed = await Model.findOneAndUpdate(
    { scheduleStatus: "pending", scheduledFor: { $lte: new Date() } },
    { $set: { scheduleStatus: "publishing" } },
    { sort: { scheduledFor: 1 }, new: true }
  ).lean();

  if (!claimed) return false;

  try {
    await publish(claimed);
  } catch (error) {
    console.error("scheduler publish error:", claimed._id, error);
    await fail(Model, claimed, "Something went wrong publishing this").catch(() => {});
  }
  return true;
};

/**
 * "Post now" from the scheduled list.
 *
 * Deliberately goes through the same claim as the poller rather than
 * publishing directly: if the scheduled time arrives in the same instant the
 * user taps the button, exactly one of the two wins the transition out of
 * "pending" and the post goes out once.
 */
export const publishNow = async (type, id, authorId) => {
  const Model = type === "comment" ? Comment : Post;
  const publish = type === "comment" ? publishComment : publishPost;

  const claimed = await Model.findOneAndUpdate(
    {
      _id: id,
      author: authorId,
      scheduleStatus: { $in: ["pending", "failed"] },
      isDeleted: { $ne: true },
      // A "failed" item is normally still unpublished, but belt and braces:
      // never re-run publish on something that already reached the feed.
      ...(type === "comment" ? { isScheduled: true } : { isDraft: true }),
    },
    { $set: { scheduleStatus: "publishing", scheduledFor: new Date() } },
    { new: true }
  ).lean();

  if (!claimed) {
    return { ok: false, status: 409, error: "This is already being posted" };
  }

  try {
    await publish(claimed);
  } catch (error) {
    console.error("publishNow error:", id, error);
    await fail(Model, claimed, "Something went wrong publishing this").catch(() => {});
    return { ok: false, status: 500, error: "Something went wrong posting this" };
  }

  // publishPost/publishComment mark their own failures rather than throwing,
  // so the stored status is the real outcome.
  const after = await Model.findById(id).select("scheduleStatus scheduleError").lean();
  if (after?.scheduleStatus !== "published") {
    return { ok: false, status: 409, error: after?.scheduleError || "Couldn't post this" };
  }

  return { ok: true };
};

/**
 * Returns claims abandoned by a crashed process to the queue.
 *
 * Each reap costs an attempt. If a particular item is what's killing the
 * process — an unhandled rejection, an image too big to fetch — retrying it
 * forever would take the app down every five minutes, so it gets the same
 * three chances as any other failure and is then left alone.
 */
const reapStaleClaims = async () => {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const stale = { scheduleStatus: "publishing", updatedAt: { $lt: cutoff } };

  const requeue = {
    $set: { scheduleStatus: "pending", scheduleError: "Interrupted, retrying" },
    $inc: { scheduleAttempts: 1 },
  };
  const abandonStale = {
    $set: {
      scheduleStatus: "failed",
      scheduleError: "Couldn't be posted after several attempts",
    },
  };

  for (const Model of [Post, Comment]) {
    await Model.updateMany(
      { ...stale, scheduleAttempts: { $lt: MAX_ATTEMPTS - 1 } },
      requeue
    );
    await Model.updateMany(
      { ...stale, scheduleAttempts: { $gte: MAX_ATTEMPTS - 1 } },
      abandonStale
    );
  }
};

const tick = async () => {
  if (running) return; // a slow tick must not overlap the next one
  running = true;

  try {
    // Maintenance mode freezes writes across the app; releasing a backlog of
    // scheduled posts into it would defeat that. Defer, don't fail — they'll
    // go out once maintenance ends.
    const settings = await getSettings();
    if (settings.maintenanceMode) return;

    await reapStaleClaims();

    for (let i = 0; i < BATCH_PER_TICK; i += 1) {
      const didPost = await claimAndPublish(Post, publishPost);
      const didComment = await claimAndPublish(Comment, publishComment);
      if (!didPost && !didComment) break;
    }
  } catch (error) {
    console.error("scheduler tick error:", error);
  } finally {
    running = false;
  }
};

/**
 * Starts the poller. Runs one tick immediately so anything that came due while
 * the server was down goes out at boot rather than waiting for the interval.
 */
export const startScheduler = () => {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
  // Don't hold the process open on shutdown.
  if (typeof timer.unref === "function") timer.unref();
  console.log("Scheduled-post publisher started");
};

export const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
