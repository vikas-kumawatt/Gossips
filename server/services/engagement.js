import mongoose from "mongoose";
import Post from "../models/Post.js";
import User from "../models/User.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import { sendNotification } from "../utils/notifications.js";
import { del, CacheKeys } from "../utils/cache.js";
import { getIO } from "../config/socket.js";

/**
 * Liking, reposting and following — as functions rather than as request handlers.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Every one of these lived inside an Express handler, reading `req.params` and writing
 * `res.json`. That is fine until something other than an HTTP request needs to do it, and
 * a bot agent is exactly that: it decides to like a post and has no `req` to offer.
 *
 * The alternative was to have the bot make loopback HTTP calls to its own API. Rejected
 * because it would need a session, a token, a socket identity and a rate-limit exemption
 * for a bot that is already inside the process — and every one of those is a hole that has
 * to be defended. A function call has no such surface.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * Each function returns a result rather than throwing, and never touches a response:
 *
 *   { ok: true,  ...outcome }
 *   { ok: false, status, error }
 *
 * `status` is the HTTP status the controller should use, so the delegation is a one-liner
 * and existing API responses keep their exact status codes. The bot runner ignores it and
 * records `error` as the rejection reason on the action log — which is why these strings are
 * written to be read by a person auditing why a bot didn't do something.
 *
 * A result rather than an exception because refusal is the *common* case here, not an
 * exceptional one: half of what these functions do is decline. Exceptions are reserved for
 * genuine faults, which stay unhandled so they reach the caller's error path.
 *
 * ── What has deliberately NOT changed ───────────────────────────────────────
 *
 * The bodies below are the controllers' logic moved, not rewritten. Same order of writes,
 * same notifications, same emits, same counter arithmetic, same E11000 handling. Where the
 * original had a quirk, the quirk is preserved and noted — because this phase's only job is
 * to make the logic callable, and a behaviour change smuggled in alongside a refactor is
 * indistinguishable from a bug for as long as it takes someone to notice.
 */

const idOf = (value) => (value?._id ? value._id : value)?.toString?.() ?? String(value);

const invalidateProfileCaches = async (...usernames) => {
  const unique = [...new Set(usernames.filter(Boolean))];
  await Promise.all(unique.map((username) => del(CacheKeys.profile(username))));
};

/**
 * Toggle a like on a post.
 *
 * @returns `{ ok, liked, counts }`
 *
 * A toggle, not an idempotent "like" — which matters for a bot. The model decides to
 * `like_post` and, if the bot has already liked it, this *removes* the like. The action
 * validator in the bot layer is responsible for not offering an already-liked post as a
 * candidate; that belongs there, with the perception that knows what the bot has seen, and
 * not here, where changing it would alter what the human API does.
 */
export const likePost = async ({ actorId, postId }) => {
  if (!mongoose.isValidObjectId(postId)) {
    return { ok: false, status: 404, error: "Post not found" };
  }

  const post = await Post.findById(postId)
    .select("author counts hideLikeShareCount isDeleted")
    .lean();
  if (!post || post.isDeleted) {
    return { ok: false, status: 404, error: "Post not found" };
  }

  const existing = await Like.findOne({ user: actorId, targetType: "Post", target: postId });

  let liked;
  if (existing) {
    await Like.deleteOne({ _id: existing._id });
    await Post.updateOne({ _id: postId }, { $inc: { "counts.likes": -1 } });
    liked = false;
  } else {
    await Like.create({ user: actorId, targetType: "Post", target: postId });
    await Post.updateOne({ _id: postId }, { $inc: { "counts.likes": 1 } });
    liked = true;

    // No notification for liking your own post.
    if (post.author.toString() !== idOf(actorId)) {
      await sendNotification(post.author, actorId, "like", {
        entity: postId,
        entityType: "Post",
      });
    }
  }

  const updated = await Post.findById(postId).select("counts hideLikeShareCount").lean();
  return { ok: true, liked, counts: updated?.counts };
};

/**
 * Toggle a repost.
 *
 * Structurally identical to `likePost` — different collection, different counter, different
 * notification type. Kept as two functions rather than one parameterised by target type: the
 * two are only similar today, `Like` carries `hideLikeShareCount` in its response and
 * `Repost` doesn't, and merging them would mean a `type` argument threaded through every
 * branch to save a dozen lines. Duplication is cheaper than that abstraction.
 */
export const repostPost = async ({ actorId, postId }) => {
  if (!mongoose.isValidObjectId(postId)) {
    return { ok: false, status: 404, error: "Post not found" };
  }

  const post = await Post.findById(postId).select("author counts isDeleted").lean();
  if (!post || post.isDeleted) {
    return { ok: false, status: 404, error: "Post not found" };
  }

  const existing = await Repost.findOne({ user: actorId, targetType: "Post", target: postId });

  if (existing) {
    await Repost.deleteOne({ _id: existing._id });
    await Post.updateOne({ _id: postId }, { $inc: { "counts.reposts": -1 } });
    const updated = await Post.findById(postId).select("counts").lean();
    return { ok: true, reposted: false, counts: updated?.counts };
  }

  await Repost.create({ user: actorId, targetType: "Post", target: postId });
  await Post.updateOne({ _id: postId }, { $inc: { "counts.reposts": 1 } });

  if (post.author.toString() !== idOf(actorId)) {
    await sendNotification(post.author, actorId, "repost", {
      entity: postId,
      entityType: "Post",
    });
  }

  const updated = await Post.findById(postId).select("counts").lean();
  return { ok: true, reposted: true, counts: updated?.counts };
};

/**
 * Follow someone, or request to.
 *
 * Which of the two happens is decided by the target's `isPrivate`, not by the caller — so
 * the bot action space's `follow_user` and `send_follow_request` both land here and the
 * result says which occurred. That is the same behaviour a human gets from one button, and
 * splitting it into two functions would mean the caller guessing at a privacy setting it
 * would then have to re-read anyway.
 *
 * @returns `{ ok, pending, isPrivate }`
 */
export const followUser = async ({ actorId, targetId }) => {
  if (!mongoose.isValidObjectId(targetId)) {
    return { ok: false, status: 404, error: "User not found" };
  }

  /*
   * By id, where the controller looked up by username.
   *
   * A bot decides to follow a *user*, and it holds ids — its perception carries them. The
   * controller resolves its username parameter to a document and hands the id down, so the
   * one lookup happens in one place either way. Both usernames are still needed at the end,
   * for the profile cache keys, so they are selected here.
   */
  const [actor, target] = await Promise.all([
    User.findById(actorId).select("username").lean(),
    User.findById(targetId).select("_id username isPrivate").lean(),
  ]);

  if (!target) return { ok: false, status: 404, error: "User not found" };
  if (idOf(target._id) === idOf(actorId)) {
    return { ok: false, status: 400, error: "You cannot follow yourself" };
  }

  // Blocks in either direction.
  if (await UserRelation.eitherBlocks(actorId, target._id)) {
    return { ok: false, status: 403, error: "Unable to follow this account" };
  }

  const existing = await Follow.findOne({ follower: actorId, following: target._id });
  if (existing?.status === "accepted") {
    return { ok: false, status: 400, error: "You already follow this user" };
  }
  if (existing?.status === "pending") {
    return { ok: false, status: 400, error: "Follow request already sent" };
  }

  const io = getIO();

  if (target.isPrivate) {
    await Follow.create({ follower: actorId, following: target._id, status: "pending" });

    /*
     * A pending request needs a notification of its own: the Activity tab reads
     * notifications, so without one the recipient learns about the request only if they
     * happen to open the follow-requests page.
     */
    await sendNotification(target._id, actorId, "follow_request");

    io.to(idOf(actorId)).emit("followStatusUpdate", {
      username: target.username,
      action: "follow",
      isPending: true,
      isPrivate: true,
    });

    await invalidateProfileCaches(actor?.username, target.username);
    return { ok: true, pending: true, isPrivate: true };
  }

  await Follow.create({ follower: actorId, following: target._id, status: "accepted" });

  await Promise.all([
    User.updateOne({ _id: actorId }, { $inc: { "counts.following": 1 } }),
    User.updateOne({ _id: target._id }, { $inc: { "counts.followers": 1 } }),
  ]);

  await sendNotification(target._id, actorId, "follow");

  io.to(idOf(actorId)).emit("followStatusUpdate", {
    username: target.username,
    action: "follow",
    isPending: false,
    isPrivate: false,
  });

  await invalidateProfileCaches(actor?.username, target.username);
  return { ok: true, pending: false, isPrivate: false };
};
