import mongoose from "mongoose";

/**
 * Sorting for a post's activity lists (likes, reposts, quotes).
 *
 * "recent" is plain reverse-chronological — the behaviour these endpoints
 * already had. "default" is a relevance order, the way Instagram ranks a likes
 * list: people you follow first, then verified accounts, then by reach. Without
 * that distinction "Default" and "Most recent" would be the same list.
 */
export const ACTIVITY_SORTS = ["default", "recent"];

export const normalizeActivitySort = (value) =>
  ACTIVITY_SORTS.includes(value) ? value : "default";

const ACTIVE_ACCOUNT = {
  accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] },
};

const USER_PROJECT = {
  username: 1,
  name: 1,
  profilePic: 1,
  isVerified: 1,
  verificationBadge: 1,
  isPrivate: 1,
  "counts.followers": 1,
};

/**
 * A relevance sort can't use a createdAt cursor — the ordering isn't
 * chronological — so those pages are addressed by offset. The offset still
 * travels inside the opaque `cursor` field, so the client's paging code is
 * identical for both modes.
 */
export const encodeOffsetCursor = (offset) =>
  Buffer.from(JSON.stringify({ offset })).toString("base64url");

export const decodeOffsetCursor = (cursor) => {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const offset = Number.parseInt(parsed?.offset, 10);
    return Number.isFinite(offset) && offset > 0 ? offset : 0;
  } catch {
    return 0;
  }
};

/**
 * One ranked page of activity, shared by the likes / reposts / quotes lists.
 *
 * `userField` is the path holding the actor — `user` on Like and Repost,
 * `author` on the Post documents that represent quotes.
 */
export const rankedActivityPage = async ({
  Model,
  match,
  userField,
  viewerId,
  limit,
  cursor,
}) => {
  const offset = decodeOffsetCursor(cursor);
  const viewerObjectId = new mongoose.Types.ObjectId(viewerId);

  const docs = await Model.aggregate([
    { $match: match },
    {
      $lookup: {
        from: "users",
        localField: userField,
        foreignField: "_id",
        as: "actor",
        pipeline: [{ $match: ACTIVE_ACCOUNT }, { $project: USER_PROJECT }],
      },
    },
    // Drops rows whose account is gone or suspended, rather than rendering blanks.
    { $unwind: "$actor" },
    {
      $lookup: {
        from: "follows",
        let: { actorId: "$actor._id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$follower", viewerObjectId] },
                  { $eq: ["$following", "$$actorId"] },
                  { $eq: ["$status", "accepted"] },
                ],
              },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "followEdge",
      },
    },
    { $addFields: { isFollowing: { $gt: [{ $size: "$followEdge" }, 0] } } },
    { $project: { followEdge: 0 } },
    {
      $sort: {
        isFollowing: -1,
        "actor.isVerified": -1,
        "actor.counts.followers": -1,
        createdAt: -1,
        _id: -1,
      },
    },
    { $skip: offset },
    // One extra row tells us whether another page exists.
    { $limit: limit + 1 },
  ]);

  const hasNextPage = docs.length > limit;
  const items = hasNextPage ? docs.slice(0, limit) : docs;

  return {
    items,
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage ? encodeOffsetCursor(offset + limit) : null,
    },
  };
};

/**
 * Relevance ordering for an already-loaded list, used by the merged activity
 * feed which isn't paginated. Mirrors the aggregation's comparator.
 */
export const rankActivityInMemory = (entries, followingIds) => {
  const follows = new Set([...followingIds].map((id) => id.toString()));

  return [...entries].sort((a, b) => {
    const aFollowed = follows.has(a.user?._id?.toString()) ? 1 : 0;
    const bFollowed = follows.has(b.user?._id?.toString()) ? 1 : 0;
    if (aFollowed !== bFollowed) return bFollowed - aFollowed;

    const aVerified = a.user?.isVerified ? 1 : 0;
    const bVerified = b.user?.isVerified ? 1 : 0;
    if (aVerified !== bVerified) return bVerified - aVerified;

    const aReach = a.user?.counts?.followers || 0;
    const bReach = b.user?.counts?.followers || 0;
    if (aReach !== bReach) return bReach - aReach;

    return new Date(b.timestamp) - new Date(a.timestamp);
  });
};
