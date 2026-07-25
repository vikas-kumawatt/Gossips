import Follow from "../models/Follow.js";

const ALLOWED_VALUES = ["anyone", "followers", "following", "mentioned"];

/**
 * Normalize/validate a whoCanReply value. Falls back to "anyone".
 */
export const normalizeWhoCanReply = (value) =>
  ALLOWED_VALUES.includes(value) ? value : "anyone";

/**
 * Determine whether `viewerId` may reply to / quote `target`.
 *
 * @param {string|ObjectId} viewerId        The acting user.
 * @param {object} target                   A Post or Comment doc/lean with
 *                                           { author, whoCanReply, mentions }.
 *                                           `author` may be an ObjectId or a
 *                                           populated object with _id.
 * @returns {Promise<boolean>}
 */
export const canUserReplyToTarget = async (viewerId, target) => {
  if (!target) return false;

  const viewer = String(viewerId);
  const authorId = String(target.author?._id ?? target.author);

  // Author can always reply to / quote their own content.
  if (viewer === authorId) return true;

  const setting = normalizeWhoCanReply(target.whoCanReply);

  switch (setting) {
    case "anyone":
      return true;

    // Only accounts that follow the author may reply.
    case "followers":
      return Follow.isFollowing(viewer, authorId);

    // Only accounts the author follows may reply.
    case "following":
      return Follow.isFollowing(authorId, viewer);

    // Only accounts @mentioned in the content may reply.
    case "mentioned":
      return (target.mentions || []).some((id) => String(id) === viewer);

    default:
      return true;
  }
};

/**
 * Synchronous permission check for batched/list contexts (e.g. feeds), where the
 * follow relationships have already been loaded into sets. Avoids per-item DB
 * lookups.
 *
 * @param {object} target  Post/Comment with { author, whoCanReply, mentions }.
 * @param {string|ObjectId} viewerId
 * @param {object} sets
 * @param {Set<string>} sets.followingSet  Author ids the viewer follows (viewer → author).
 * @param {Set<string>} sets.followerSet   Author ids that follow the viewer (author → viewer).
 * @returns {boolean}
 */
export const viewerCanReplyFromSets = (
  target,
  viewerId,
  { followingSet, followerSet } = {}
) => {
  if (!target) return false;

  const viewer = String(viewerId);
  const authorId = String(target.author?._id ?? target.author);

  if (viewer === authorId) return true;

  switch (normalizeWhoCanReply(target.whoCanReply)) {
    case "anyone":
      return true;
    case "followers":
      return followingSet ? followingSet.has(authorId) : false;
    case "following":
      return followerSet ? followerSet.has(authorId) : false;
    case "mentioned":
      return (target.mentions || []).some((id) => String(id) === viewer);
    default:
      return true;
  }
};

/**
 * Human-readable message for a denied reply/quote, by setting.
 */
export const replyDeniedMessage = (whoCanReply, action = "reply to") => {
  switch (normalizeWhoCanReply(whoCanReply)) {
    case "followers":
      return `Only the author's followers can ${action} this post`;
    case "following":
      return `Only profiles the author follows can ${action} this post`;
    case "mentioned":
      return `Only mentioned profiles can ${action} this post`;
    default:
      return `You can't ${action} this post`;
  }
};
