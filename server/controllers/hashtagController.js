import mongoose from "mongoose";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Hashtag from "../models/Hashtag.js";
import UserRelation from "../models/UserRelation.js";
import Follow from "../models/Follow.js";
import { authorVisibilityMatch } from "../utils/contentSearch.js";
import { decodeCursor, parseCursorLimit, encodeCursor } from "../utils/cursorPagination.js";
import { encodeOffsetCursor, decodeOffsetCursor } from "../utils/activitySort.js";
import { decorateContent } from "../utils/attachments.js";
import { normalizeTag } from "../utils/richText.js";
import {
  isBlockedTag,
  isBlockedHashtag,
  listBuiltInBlockedHashtags,
} from "../utils/blockedHashtags.js";
import { getSettings } from "../utils/settings.js";
import { escapeRegex } from "../utils/respond.js";
// Cache-aside; falls through to the loader when Redis is unreachable, so
// trending still works on a single-instance deployment with no Redis at all.
import { getOrSet } from "../utils/cache.js";

const AUTHOR_SELECT = "_id username name bio profilePic isVerified verificationBadge isPrivate";

const POST_SELECT =
  "_id author content media poll location counts createdAt isQuoteRepost isQuoteComment " +
  "quotedPost quotedComment quotedSnapshot hideLikeShareCount whoCanReply mentions hashtags " +
  "isEdited editedAt isAiGenerated";

const REPLY_SELECT =
  "_id author content media poll location counts createdAt post parent replyTo " +
  "whoCanReply mentions hashtags isEdited editedAt isAiGenerated";

/**
 * A hashtag's page.
 *
 * One list, posts and replies together. They're the same thing here — content
 * someone tagged — and splitting them made the page ask a question nobody
 * arrives with. `$unionWith` does the merging in the database, so a single sort
 * and a single limit produce the true top N across both collections; merging
 * two independently-paged streams in JavaScript is where off-by-one paging bugs
 * come from.
 *
 * The visibility rules are search's, imported rather than rewritten. A tag page
 * is a discovery surface — it shows you people you have no relationship with —
 * so it has to exclude private accounts you don't follow, anyone muted or
 * blocked either way, suspended and deleted accounts, and for a reply, all of
 * that about the post it sits under too. A public reply beneath a private
 * account's post is still that account's thread. My first version wrote these
 * checks by hand and got three of them wrong.
 */

export const HASHTAG_SORTS = ["top", "latest", "oldest"];

/*
 * "Most engaged". Replies and reposts weigh more than likes because they cost
 * more — a like is a reflex, a reply is a decision. Not tuned, just ordered
 * sensibly; the point is that the default tab isn't a wall of whatever was
 * posted most recently.
 */
const ENGAGEMENT_SCORE = {
  $add: [
    { $ifNull: ["$counts.likes", 0] },
    { $multiply: [{ $ifNull: ["$counts.replies", 0] }, 2] },
    { $multiply: [{ $ifNull: ["$counts.reposts", 0] }, 3] },
    { $multiply: [{ $ifNull: ["$counts.quotes", 0] }, 3] },
  ],
};

const SORT_SPECS = {
  top: { score: -1, createdAt: -1, _id: -1 },
  latest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
};

/** The viewer's relationships, in the shape the visibility helper wants. */
const viewerScope = async (viewerId) => {
  const [followEdges, outgoingHidden, incomingBlocks] = await Promise.all([
    Follow.find({ follower: viewerId, status: "accepted" }).select("following").lean(),
    // Mute as well as block: a muted account is hidden from the feed, and a tag
    // page that resurfaces them makes the mute feel broken.
    UserRelation.find({ from: viewerId, kind: { $in: ["mute", "block"] } })
      .select("to")
      .lean(),
    UserRelation.find({ to: viewerId, kind: "block" }).select("from").lean(),
  ]);

  return {
    followingIds: followEdges.map((edge) => edge.following),
    hiddenAuthorIds: [
      ...outgoingHidden.map((relation) => relation.to),
      ...incomingBlocks.map((relation) => relation.from),
    ],
  };
};

/**
 * Keyset cursor for the chronological sorts.
 *
 * Aggregation does no schema casting, unlike `find` — a raw string `_id`
 * compared against ObjectIds matches nothing at all and silently drops every
 * row sharing the cursor's timestamp.
 */
const chronologicalCursor = (cursor, sort) => {
  if (!cursor) return { match: {} };

  const createdAt = new Date(cursor.createdAt);
  if (Number.isNaN(createdAt.getTime()) || !mongoose.isValidObjectId(cursor._id)) {
    return { error: "That page cursor isn't valid" };
  }
  const id = new mongoose.Types.ObjectId(cursor._id);
  const op = sort === "oldest" ? "$gt" : "$lt";

  return {
    match: {
      $or: [{ createdAt: { [op]: createdAt } }, { createdAt, _id: { [op]: id } }],
    },
  };
};

/** Stages shared by both halves of the union, up to the projection. */
const visibilityStages = ({ tag, cursorMatch, viewerId, followingIds, hiddenAuthorIds, isReply }) => [
  {
    $match: {
      hashtags: tag,
      isDeleted: { $ne: true },
      // A scheduled post is stored as a draft, so one exclusion covers both.
      ...(isReply ? { isScheduled: { $ne: true } } : { isDraft: { $ne: true } }),
      ...(hiddenAuthorIds.length ? { author: { $nin: hiddenAuthorIds } } : {}),
      ...cursorMatch,
    },
  },
  { $lookup: { from: "users", localField: "author", foreignField: "_id", as: "authorDoc" } },
  { $unwind: "$authorDoc" },
  {
    $match: authorVisibilityMatch({
      prefix: "authorDoc",
      authorField: "author",
      viewerId,
      followingIds,
    }),
  },

  // A reply also inherits its post's visibility.
  ...(isReply
    ? [
        { $lookup: { from: "posts", localField: "post", foreignField: "_id", as: "postDoc" } },
        { $unwind: "$postDoc" },
        {
          $match: {
            "postDoc.isDeleted": { $ne: true },
            "postDoc.isDraft": { $ne: true },
            ...(hiddenAuthorIds.length ? { "postDoc.author": { $nin: hiddenAuthorIds } } : {}),
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "postDoc.author",
            foreignField: "_id",
            as: "postAuthorDoc",
          },
        },
        { $unwind: "$postAuthorDoc" },
        {
          $match: authorVisibilityMatch({
            prefix: "postAuthorDoc",
            authorField: "postDoc.author",
            viewerId,
            followingIds,
          }),
        },
      ]
    : []),

  // Shed the joined documents before the sort — it only needs the keys.
  { $project: { _id: 1, createdAt: 1, kind: { $literal: isReply ? "reply" : "post" }, score: ENGAGEMENT_SCORE } },
];

/**
 * GET /tags/:tag — everything carrying the tag, posts and replies together.
 *
 * `sort=top|latest|oldest`. The chronological sorts page on a keyset cursor;
 * "top" pages on an offset, because a score has no unique key to seek from and
 * ties are the common case.
 */
export const getHashtagContent = async (req, res) => {
  try {
    const tag = normalizeTag(req.params.tag);
    if (!tag) return res.status(404).json({ error: "Hashtag not found" });

    /*
     * A blocked tag is answered, not 404'd. The page needs to say *why* it's
     * empty, and a 404 on a link the app itself rendered reads as a bug.
     */
    if (await isBlockedTag(tag)) {
      return res.status(200).json({
        tag,
        restricted: true,
        postCount: 0,
        items: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
    }

    const sort = HASHTAG_SORTS.includes(req.query.sort) ? req.query.sort : "top";
    const limit = parseCursorLimit(req.query.limit, 10);
    const viewerId = req.user._id;

    let cursorMatch = {};
    let offset = 0;
    if (sort === "top") {
      offset = decodeOffsetCursor(req.query.cursor);
    } else {
      const { match, error } = chronologicalCursor(decodeCursor(req.query.cursor), sort);
      if (error) return res.status(400).json({ error });
      cursorMatch = match;
    }

    const { followingIds, hiddenAuthorIds } = await viewerScope(viewerId);
    const shared = { tag, cursorMatch, viewerId, followingIds, hiddenAuthorIds };

    /*
     * One stream. The union happens before the sort, so the top N is the true
     * top N across both collections rather than the better of two separately
     * truncated lists.
     */
    const rows = await Post.aggregate([
      ...visibilityStages({ ...shared, isReply: false }),
      {
        $unionWith: {
          coll: Comment.collection.name,
          pipeline: visibilityStages({ ...shared, isReply: true }),
        },
      },
      { $sort: SORT_SPECS[sort] },
      ...(sort === "top" ? [{ $skip: offset }] : []),
      // The extra row is what says whether another page exists.
      { $limit: limit + 1 },
    ]);

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;

    /*
     * The pipeline returns keys only — hydrating inside an aggregation would
     * mean reimplementing every populate by hand. Fetch both kinds and put them
     * back in the order the sort decided.
     */
    const postIds = page.filter((row) => row.kind === "post").map((row) => row._id);
    const replyIds = page.filter((row) => row.kind === "reply").map((row) => row._id);

    const [postDocs, replyDocs] = await Promise.all([
      postIds.length
        ? Post.find({ _id: { $in: postIds } })
            .select(POST_SELECT)
            .populate("author", AUTHOR_SELECT)
            .populate({
              path: "quotedPost",
              // `mentions` included, or the quoted card links handles whose
              // owners refused the mention — decorateContent can only project
              // what it's given.
              select:
                "_id author content media counts mentions isQuoteRepost isQuoteComment createdAt hideLikeShareCount isEdited editedAt isAiGenerated",
              populate: { path: "author", select: AUTHOR_SELECT },
            })
            .populate({
              path: "quotedComment",
              select:
                "_id content media counts mentions author createdAt post hideLikeShareCount isEdited editedAt isAiGenerated",
              populate: { path: "author", select: AUTHOR_SELECT },
            })
            .lean()
        : [],
      replyIds.length
        ? Comment.find({ _id: { $in: replyIds } })
            .select(REPLY_SELECT)
            .populate("author", AUTHOR_SELECT)
            .lean()
        : [],
    ]);

    const byId = new Map();
    // `kind` rides along so the client knows to render a reply as a reply and
    // where tapping it should go.
    postDocs.forEach((doc) => byId.set(String(doc._id), { ...doc, kind: "post" }));
    replyDocs.forEach((doc) => byId.set(String(doc._id), { ...doc, kind: "reply" }));

    const ordered = page.map((row) => byId.get(String(row._id))).filter(Boolean);
    const decorated = await decorateContent(ordered, viewerId);

    const registry = await Hashtag.findOne({ tag }).select("postCount").lean();
    const last = page[page.length - 1];

    return res.status(200).json({
      tag,
      restricted: false,
      postCount: registry?.postCount ?? 0,
      sort,
      items: decorated,
      pageInfo: {
        hasNextPage,
        nextCursor: !hasNextPage
          ? null
          : sort === "top"
            ? encodeOffsetCursor(offset + limit)
            : encodeCursor({ createdAt: last.createdAt, _id: last._id }),
      },
    });
  } catch (error) {
    console.error("getHashtagContent error:", error);
    return res.status(500).json({ error: "Failed to load hashtag" });
  }
};

/*
 * How far back "trending" looks.
 *
 * `Hashtag.postCount` is a lifetime counter, so ranking by it answered "most
 * used ever" — a tag with ten thousand posts from last year outranked one with
 * two hundred from this morning, permanently, and the list barely moved from one
 * week to the next. That is a registry, not a trend.
 *
 * Seven days rather than twenty-four hours because this is not a high-volume
 * platform: a one-day window on a quiet week returns three tags and an empty
 * suggestion rail. Long enough to always have something to show, short enough
 * that the list turns over.
 */
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /tags/trending — the tags worth suggesting.
 *
 * Counted over a recent window rather than read from the lifetime counter, and
 * counted across posts *and* replies for the same reason the hashtag page unions
 * both: a tag being argued about in replies is trending by any reading of the
 * word.
 *
 * The cost is a real aggregation instead of an indexed `find`, which is why it
 * is cached — the answer is identical for every caller, so it does not need
 * recomputing per request. `postCount` is still returned, now meaning "posts in
 * the window" rather than "posts ever", which is also the number the UI implies.
 *
 * Blocked tags are filtered at read time rather than trusted never to have been
 * written: the blocklist grows after tags are already in the registry.
 */
export const getTrendingHashtags = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 30);

    /*
     * Five minutes. Trending is a suggestion rail, not a live counter, and this
     * is the most expensive read on the hashtag routes — it is also the one
     * every client fires on load. Keyed on the limit because the aggregation is
     * limited server-side. Falls through to the database when Redis is down.
     */
    const rows = await getOrSet(`trending:hashtags:v2:${limit}`, 300, async () => {
      const since = new Date(Date.now() - TRENDING_WINDOW_MS);

      /*
       * Only content that is actually visible: published, not deleted, not a
       * draft or scheduled item. A tag cannot trend on posts nobody can read.
       * Author-level visibility (private accounts, blocks) is deliberately not
       * applied — this list is identical for every viewer, which is what makes
       * it cacheable, and a tag name leaks nothing about who used it.
       */
      const visible = {
        hashtags: { $exists: true, $ne: [] },
        createdAt: { $gte: since },
        isDeleted: { $ne: true },
      };

      const stages = [
        { $match: { ...visible, isDraft: { $ne: true } } },
        { $unwind: "$hashtags" },
        { $group: { _id: "$hashtags", postCount: { $sum: 1 } } },
      ];

      return Post.aggregate([
        ...stages,
        {
          $unionWith: {
            coll: Comment.collection.name,
            pipeline: [
              { $match: { ...visible, isScheduled: { $ne: true } } },
              { $unwind: "$hashtags" },
              { $group: { _id: "$hashtags", postCount: { $sum: 1 } } },
            ],
          },
        },
        // Posts and replies were grouped separately, so the two streams have to
        // be folded together before ranking.
        { $group: { _id: "$_id", postCount: { $sum: "$postCount" } } },
        { $sort: { postCount: -1, _id: 1 } },
        // Over-fetch so blocklist filtering can't return a short list.
        { $limit: limit * 3 },
        { $project: { _id: 0, tag: "$_id", postCount: 1 } },
      ]);
    });

    const allowed = [];
    for (const row of rows) {
      if (allowed.length >= limit) break;
      if (await isBlockedTag(row.tag)) continue;
      allowed.push({ tag: row.tag, postCount: row.postCount });
    }

    return res.status(200).json({ hashtags: allowed });
  } catch (error) {
    console.error("getTrendingHashtags error:", error);
    return res.status(500).json({ error: "Failed to load trending hashtags" });
  }
};

/**
 * GET /tags/search?q=… — hashtags whose name starts with the query.
 *
 * Prefix, not substring. Typing "cof" should offer #coffee, not every tag with
 * "cof" buried in it — and an anchored regex is the only shape Mongo can serve
 * from the index on `tag`, so the alternative is a collection scan per
 * keystroke for results nobody asked for.
 *
 * Blocked tags are excluded in the query rather than filtered afterwards, which
 * keeps the page size exact: filtering after `skip` makes both the page length
 * and hasNextPage a guess.
 */
export const searchHashtags = async (req, res) => {
  try {
    const raw = String(req.query.q || "").trim().replace(/^#/, "").toLowerCase();

    // Anything that couldn't be a tag has no matches by definition — answered
    // as an empty page rather than an error, since it's just what half-typed
    // input looks like.
    if (!raw || !/^[a-z0-9_]{1,100}$/.test(raw)) {
      return res
        .status(200)
        .json({ hashtags: [], pageInfo: { hasNextPage: false, nextCursor: null } });
    }

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 30);
    const offset = decodeOffsetCursor(req.query.cursor);

    const settings = await getSettings();
    const blocked = [
      ...listBuiltInBlockedHashtags(),
      ...(settings?.blockedHashtags || []),
    ];

    /*
     * Both conditions on `tag` have to live in one operator object. Written as
     * two `tag:` keys the second silently wins, and the prefix match — or the
     * blocklist — quietly stops applying.
     */
    const prefix = `^${escapeRegex(raw)}`;

    const rows = await Hashtag.find({
      // A tag whose every post has since been deleted is a dead end.
      postCount: { $gt: 0 },
      tag: blocked.length ? { $regex: prefix, $nin: blocked } : { $regex: prefix },
    })
      // Most used first, then alphabetically so the order is stable between
      // pages when counts tie.
      .sort({ postCount: -1, tag: 1 })
      .skip(offset)
      .limit(limit + 1)
      .select("tag postCount")
      .lean();

    const hasNextPage = rows.length > limit;
    const page = (hasNextPage ? rows.slice(0, limit) : rows)
      // Belt and braces: a tag blocked by a pattern rather than by name
      // wouldn't be caught by the $nin above.
      .filter((row) => !isBlockedHashtag(row.tag, settings?.blockedHashtags || []))
      .map((row) => ({ tag: row.tag, postCount: row.postCount }));

    return res.status(200).json({
      hashtags: page,
      pageInfo: {
        hasNextPage,
        nextCursor: hasNextPage ? encodeOffsetCursor(offset + limit) : null,
      },
    });
  } catch (error) {
    console.error("searchHashtags error:", error);
    return res.status(500).json({ error: "Failed to search hashtags" });
  }
};
