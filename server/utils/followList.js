import mongoose from "mongoose";
import Follow from "../models/Follow.js";
import Message from "../models/Message.js";
import UserRelation from "../models/UserRelation.js";
import { escapeRegex } from "./respond.js";
import { encodeCursor, decodeCursor } from "./cursorPagination.js";
import { encodeOffsetCursor, decodeOffsetCursor } from "./activitySort.js";

/**
 * The engine behind the followers and following lists.
 *
 * One implementation for both directions — the old controllers were verbatim
 * copies of each other, which is how the followers copy and the following copy
 * would eventually drift.
 *
 * Search and sort happen in a single aggregation rather than
 * `.populate({ match })`, because populate-with-match filters *after* the page
 * is fetched: searching "an" over a page of 20 edges might match 2, and the
 * next cursor would still advance past all 20. The aggregation filters first,
 * so a page is a page.
 *
 * Sorts:
 *  - "latest" / "earliest"  — by when the follow happened (edge createdAt),
 *    cursor-paginated on the edge's own createdAt + _id (stable keyset pagination).
 *    Anchoring both sides to the edge guarantees zero drift, skipping, or repetition
 *    across pages even under concurrent writes.
 *  - "default" — the people who matter to the viewer first: accounts they
 *    message, then mutuals, then verified accounts, then follower count.
 *    Because the multi-dimensional rank is computed dynamically (and changes as
 *    interaction counts and follower counts shift), it intentionally uses an
 *    offset cursor (`encodeOffsetCursor`). Under high concurrent inserts/unfollows,
 *    an offset window can experience slight drift across page boundaries, which
 *    is an acceptable design trade-off for rich contextual relevance scoring.
 */

export const FOLLOW_LIST_SORTS = ["default", "latest", "earliest"];

export const normalizeFollowListSort = (value) =>
  FOLLOW_LIST_SORTS.includes(value) ? value : "default";

const ACTIVE_ACCOUNT = {
  "user.accountStatus": { $nin: ["deleted", "deactivated", "suspended", "locked"] },
};

const USER_PROJECTION = {
  _id: "$user._id",
  username: "$user.username",
  name: "$user.name",
  profilePic: "$user.profilePic",
  isVerified: "$user.isVerified",
  verificationBadge: "$user.verificationBadge",
  isPrivate: "$user.isPrivate",
  counts: "$user.counts",
};

/**
 * Who the viewer actually talks to, most-messaged first. The same bounded
 * 90-day aggregation the share sheet uses — one query, small result, and it
 * only runs for the default sort.
 */
const interactionOrder = async (viewerId) => {
  const rows = await Message.aggregate([
    {
      $match: {
        isGroupMessage: { $ne: true },
        isDeleted: { $ne: true },
        createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
        $or: [{ sender: viewerId }, { receiver: viewerId }],
      },
    },
    {
      $group: {
        _id: { $cond: [{ $eq: ["$sender", viewerId] }, "$receiver", "$sender"] },
        messages: { $sum: 1 },
      },
    },
    { $sort: { messages: -1 } },
    { $limit: 50 },
  ]);
  return rows.map((r) => r._id).filter(Boolean);
};

/**
 * One page of a follow list.
 *
 * @param {"followers"|"following"} direction  whose side of the edge is fixed
 * @param {ObjectId} profileId   the account whose list this is
 * @param {ObjectId} viewerId    who is looking (drives the default ranking)
 * @param {object}   opts        { q, sort, cursor, limit }
 * @returns {{ items, pageInfo }}  items carry the projected user + _edge date
 */
export const followListPage = async (direction, profileId, viewerId, opts) => {
  const { q = "", sort = "default", cursor, limit = 20 } = opts;

  const edgeField = direction === "followers" ? "following" : "follower";
  const userField = direction === "followers" ? "follower" : "following";

  const search = q.trim();

  /*
   * Blocks hide people from each other everywhere else — profile, search,
   * suggestions — so they must hide them here too, or a blocked account could
   * keep tracking the blocker through any mutual's follower list.
   */
  const blockRows = await UserRelation.find({
    kind: "block",
    $or: [{ from: viewerId }, { to: viewerId }],
  })
    .select("from to")
    .lean();
  const blockedIds = blockRows.map((r) =>
    r.from.toString() === viewerId.toString() ? r.to : r.from
  );

  const searchMatch = search
    ? {
        $or: [
          { "user.username": new RegExp(escapeRegex(search), "i") },
          { "user.name": new RegExp(escapeRegex(search), "i") },
        ],
      }
    : {};

  const base = [
    { $match: { [edgeField]: profileId, status: "accepted" } },
    {
      $lookup: {
        from: "users",
        localField: userField,
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    {
      $match: {
        ...ACTIVE_ACCOUNT,
        ...searchMatch,
        ...(blockedIds.length ? { "user._id": { $nin: blockedIds } } : {}),
      },
    },
  ];

  const project = {
    $project: { _id: 1, createdAt: 1, user: USER_PROJECTION },
  };

  // ── Chronological sorts: cursor on the edge itself ─────────────────────────
  if (sort === "latest" || sort === "earliest") {
    const dir = sort === "latest" ? -1 : 1;
    const parsed = decodeCursor(cursor);

    let cursorMatch = {};
    // The cursor is client-supplied; a crafted _id or date must read as "no
    // cursor", not throw on ObjectId construction and turn into a 500.
    if (parsed && mongoose.isValidObjectId(parsed._id) && !Number.isNaN(Date.parse(parsed.createdAt))) {
      const at = new Date(parsed.createdAt);
      const id = new mongoose.Types.ObjectId(parsed._id);
      const cmp = dir === -1 ? "$lt" : "$gt";
      // Tiebreak on _id so two follows in the same millisecond can't make a
      // row vanish or repeat at a page boundary.
      cursorMatch = {
        $or: [{ createdAt: { [cmp]: at } }, { createdAt: at, _id: { [cmp]: id } }],
      };
    }

    const rows = await Follow.aggregate(
      [
        { $match: { [edgeField]: profileId, status: "accepted", ...cursorMatch } },
        { $sort: { createdAt: dir, _id: dir } },
        // No pre-window before the search match: the trailing $limit stops the
        // stream once the page is full, and a window would make hasNextPage
        // lie whenever the next match sat beyond it.
        ...base.slice(1), // reuse the lookup/unwind/user-match stages
        { $limit: limit + 1 },
        project,
      ],
      { allowDiskUse: true }
    );

    const hasNextPage = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];

    return {
      items: items.map((r) => ({ ...r.user, _edgeCreatedAt: r.createdAt, _edgeId: r._id })),
      pageInfo: {
        hasNextPage,
        // The cursor names the last *edge* — the same field the next page's
        // filter compares against.
        nextCursor: hasNextPage ? encodeCursor({ createdAt: last.createdAt, _id: last._id }) : null,
      },
    };
  }

  // ── Default: ranked, offset-paginated ───────────────────────────────────────
  const offset = decodeOffsetCursor(cursor) ?? 0;
  const interactIds = await interactionOrder(viewerId);

  const rows = await Follow.aggregate(
    [
      ...base,
      // Mutuals: does the viewer follow this account?
    {
      $lookup: {
        from: "follows",
        let: { uid: "$user._id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$follower", viewerId] },
                  { $eq: ["$following", "$$uid"] },
                  { $eq: ["$status", "accepted"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "viewerEdge",
      },
    },
    {
      $addFields: {
        _mutual: { $gt: [{ $size: "$viewerEdge" }, 0] },
        // Position in the viewer's most-messaged list; -1 (absent) sorts last.
        _talk: { $indexOfArray: [interactIds, "$user._id"] },
      },
    },
    { $addFields: { _talkRank: { $cond: [{ $eq: ["$_talk", -1] }, 9999, "$_talk"] } } },
    {
      $sort: {
        _talkRank: 1,
        _mutual: -1,
        "user.isVerified": -1,
        "user.counts.followers": -1,
        createdAt: -1,
        _id: -1,
      },
    },
      { $skip: offset },
      { $limit: limit + 1 },
      project,
    ],
    { allowDiskUse: true }
  );

  const hasNextPage = rows.length > limit;
  const items = rows.slice(0, limit);

  return {
    items: items.map((r) => ({ ...r.user, _edgeCreatedAt: r.createdAt, _edgeId: r._id })),
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage ? encodeOffsetCursor(offset + limit) : null,
    },
  };
};
