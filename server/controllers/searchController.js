import mongoose from "mongoose";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import User from "../models/User.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import Saved from "../models/Saved.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import SearchHistory, {
  MAX_SEARCH_HISTORY,
  historyKey,
} from "../models/SearchHistory.js";
import {
  decodeCursor,
  encodeCursor,
  parseCursorLimit,
} from "../utils/cursorPagination.js";
import {
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  buildAggregateCursorMatch,
  buildPostSearchPipeline,
  buildReplySearchPipeline,
  mergeByRecency,
  mergeByRelevance,
  looksLikeWholeWords,
  isTextIndexUnavailable,
  parseSearchFilters,
} from "../utils/contentSearch.js";
import { encodeOffsetCursor, decodeOffsetCursor } from "../utils/activitySort.js";
import { decorateContent } from "../utils/attachments.js";
import { viewerCanReplyFromSets } from "../utils/replyPermission.js";
import { escapeRegex } from "../utils/respond.js";

const AUTHOR_SELECT =
  "_id username name bio profilePic isVerified verificationBadge isPrivate";

const POST_SELECT =
  "_id author content icon media poll location counts quotedPost quotedComment quotedSnapshot isQuoteRepost isQuoteComment createdAt hideLikeShareCount whoCanReply mentions isEdited editedAt isAiGenerated parentGossip";

const REPLY_SELECT =
  "_id author content media poll location counts post parent replyTo createdAt whoCanReply mentions isEdited editedAt isAiGenerated";

const EMPTY_PAGE_INFO = { hasNextPage: false, nextCursor: null };

// ─────────────────────────────────────────────────────────────────────────────
// Content search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /search/content — posts and replies matching a text query and filters,
 * newest first.
 *
 * Ordering is chronological rather than relevance-scored, which is what makes
 * one cursor work across two collections and keeps paging stable while new
 * content arrives. There is no "Top" ranking.
 */
export const searchContent = async (req, res) => {
  try {
    const viewerId = req.user._id;

    const { filters, error } = parseSearchFilters(req.query);
    if (error) return res.status(400).json({ error });

    const limit = Math.min(parseCursorLimit(req.query.limit, 15), MAX_SEARCH_LIMIT);

    /*
     * Which of the two orderings to run.
     *
     * Decided before the cursor is read, because the two modes issue different
     * *kinds* of cursor and each is nonsense to the other's decoder. `relevance`
     * is only meaningful with text to rank, and only answerable by the text index
     * if the query is whole words — the index finds nothing at all for a
     * half-typed "coff" — so both conditions are checked here rather than letting
     * an unanswerable request return an empty page.
     */
    const wantsRelevance =
      filters.sort === "relevance" && Boolean(filters.q) && looksLikeWholeWords(filters.q);

    const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : "";

    /*
     * Ranked pages carry an offset cursor; chronological ones carry a keyset
     * cursor over {createdAt, _id}. Validating every cursor as a keyset cursor —
     * which is what this did — rejected a perfectly good relevance cursor with
     * "that page cursor isn't valid", so relevance search worked for exactly one
     * page and then 400'd.
     */
    let skip = 0;
    let cursorMatch = {};
    if (wantsRelevance) {
      skip = decodeOffsetCursor(rawCursor);
    } else {
      const parsedCursor = decodeCursor(rawCursor);
      if (rawCursor && !parsedCursor) {
        return res.status(400).json({ error: "That page cursor isn't valid" });
      }
      const built = buildAggregateCursorMatch(parsedCursor);
      if (built.error) return res.status(400).json({ error: built.error });
      cursorMatch = built.match;
    }

    // ── Single-profile filter ────────────────────────────────────────────────
    // Resolved from the username rather than trusting an id from the client, and
    // matched case-insensitively so a handle typed in any case still lands.
    let authorId = null;
    if (filters.from === "user") {
      const target = await User.findOne({
        username: new RegExp(`^${escapeRegex(filters.username)}$`, "i"),
      })
        .select("_id")
        .lean();

      if (!target) {
        return res.status(200).json({
          results: [],
          pageInfo: EMPTY_PAGE_INFO,
          meta: { unknownUsername: filters.username },
        });
      }
      authorId = target._id;
    }

    /*
     * Search needs an anchor: a text query, or one profile to read. Without
     * either, "no query + no filters" would page the entire post collection
     * newest-first, which is a bulk export rather than a search.
     */
    if (!filters.q && !authorId) {
      return res.status(200).json({
        results: [],
        pageInfo: EMPTY_PAGE_INFO,
        meta: { needsQuery: true },
      });
    }

    // ── Viewer relationships ─────────────────────────────────────────────────
    const [followEdges, outgoingHidden, incomingBlocks] = await Promise.all([
      Follow.find({ follower: viewerId, status: "accepted" }).select("following").lean(),
      // Muted and blocked accounts are hidden from search for the same reason
      // they're hidden from the feed.
      UserRelation.find({ from: viewerId, kind: { $in: ["mute", "block"] } }).select("to").lean(),
      UserRelation.find({ to: viewerId, kind: "block" }).select("from").lean(),
    ]);

    const followingIds = followEdges.map((edge) => edge.following);
    const followingSet = new Set(followingIds.map((id) => id.toString()));
    const hiddenAuthorIds = [
      ...outgoingHidden.map((relation) => relation.to),
      ...incomingBlocks.map((relation) => relation.from),
    ];

    if (filters.from === "following" && !followingIds.length) {
      return res.status(200).json({
        results: [],
        pageInfo: EMPTY_PAGE_INFO,
        meta: { emptyFollowing: true },
      });
    }

    // Escaped, so a query full of regex metacharacters is matched literally
    // instead of compiling into a pattern of the searcher's choosing.
    const contentRegex = filters.q ? new RegExp(escapeRegex(filters.q), "i") : null;

    const runSearch = async ({ ranked }) => {
      const pipelineInput = {
        viewerId,
        filters,
        contentRegex: ranked ? null : contentRegex,
        textQuery: ranked ? filters.q : null,
        // A keyset cursor is meaningless once results are ordered by score.
        cursorMatch: ranked ? {} : cursorMatch,
        authorId,
        followingIds,
        hiddenAuthorIds,
        /*
         * The ranked path over-fetches by the offset and slices after merging.
         * Applying `$skip` inside each pipeline would skip that many *posts* and
         * that many *replies* independently, which is not the same rows as
         * skipping that many results — the two lists are ranked separately and
         * only become one ordering after the merge below.
         *
         * Bounded: `limit` is capped at MAX_SEARCH_LIMIT, and the offset only
         * grows while someone keeps paging.
         */
        limit: ranked ? skip + limit + 1 : limit + 1,
      };

      const [postRows, replyRows] = await Promise.all([
        Post.aggregate(buildPostSearchPipeline(pipelineInput)),
        filters.excludeReplies
          ? Promise.resolve([])
          : Comment.aggregate(buildReplySearchPipeline(pipelineInput)),
      ]);

      const tagged = [
        ...postRows.map((row) => ({ ...row, kind: "post" })),
        ...replyRows.map((row) => ({ ...row, kind: "reply" })),
      ];

      return ranked
        ? mergeByRelevance(tagged, skip + limit + 1).slice(skip)
        : mergeByRecency(tagged, limit + 1);
    };

    let ranked = wantsRelevance;
    let merged;

    /*
     * The fallback, for the two ways ranking can fail to answer.
     *
     * Empty: a text index matches whole words, so a query that is a partial
     * word, spelled differently, or tokenised differently by language comes back
     * with nothing while the regex would have found it. Retried on the first page
     * only — a later page coming back empty means the end of the results, not a
     * failed match.
     *
     * Thrown: the indexes are declared `background: true`, so on an existing
     * collection they are unusable until the build finishes, and `$text` throws
     * `IndexNotFound` rather than returning nothing. That window is the first
     * minutes after a deploy. Without this the endpoint would 500 for every
     * relevance search until the build completed; with it, relevance quietly
     * degrades to recency and `meta.sort` says so.
     *
     * Only that specific error is swallowed. Anything else propagates to the
     * catch below and is reported as a failure, because a fallback that hides
     * arbitrary errors would turn a broken query into a silently wrong answer.
     */
    try {
      merged = await runSearch({ ranked });
    } catch (error) {
      if (!ranked || !isTextIndexUnavailable(error)) throw error;
      console.warn("searchContent: text index unavailable, falling back to recency");
      ranked = false;
      merged = await runSearch({ ranked: false });
    }

    if (ranked && !merged.length && !skip) {
      ranked = false;
      merged = await runSearch({ ranked: false });
    }

    const hasNextPage = merged.length > limit;
    const page = hasNextPage ? merged.slice(0, limit) : merged;

    if (!page.length) {
      return res.status(200).json({ results: [], pageInfo: EMPTY_PAGE_INFO, meta: {} });
    }

    const results = await hydrateResults({ page, viewerId, followingSet });

    res.status(200).json({
      results,
      pageInfo: {
        hasNextPage,
        // Taken from the ordered id row, not the hydrated list, so the boundary
        // is right even if a document disappeared between the two queries.
        nextCursor: !hasNextPage
          ? null
          : ranked
            ? encodeOffsetCursor(skip + limit)
            : encodeCursor(page[page.length - 1]),
      },
      /*
       * Stated, because the client has to send it back unchanged for the next
       * page to decode its cursor correctly — and because a relevance search
       * that silently fell back to recency should say so rather than presenting
       * chronological results as ranked.
       */
      meta: { sort: ranked ? "relevance" : "recent" },
    });
  } catch (error) {
    console.error("searchContent error:", error);
    res.status(500).json({ error: "Failed to search" });
  }
};

/**
 * Load the full documents for one ordered page of ids and attach the
 * viewer-scoped fields a card needs, in the same shape the feed sends.
 *
 * Likes and reposts are keyed by targetType, so posts and replies are looked up
 * separately; saving only exists for posts.
 */
const hydrateResults = async ({ page, viewerId, followingSet }) => {
  const postIds = page.filter((row) => row.kind === "post").map((row) => row._id);
  const replyIds = page.filter((row) => row.kind === "reply").map((row) => row._id);

  const [postDocs, replyDocs] = await Promise.all([
    postIds.length
      ? Post.find({ _id: { $in: postIds } })
          .select(POST_SELECT)
          .populate("author", AUTHOR_SELECT)
          .populate({
            path: "quotedPost",
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

  /*
   * The parent post is fetched separately rather than populated, so `post` stays
   * a plain id — the card builds its permalink from it, and a populated object
   * would produce "/user/post/[object Object]".
   */
  const parentPostIds = [
    ...new Set(replyDocs.map((reply) => reply.post?.toString()).filter(Boolean)),
  ];
  const parentPosts = parentPostIds.length
    ? await Post.find({ _id: { $in: parentPostIds } })
        .select("_id author")
        .populate("author", "_id username name")
        .lean()
    : [];
  const parentPostMap = new Map(parentPosts.map((post) => [post._id.toString(), post]));

  const [likedEdges, repostedEdges, savedEdges] = await Promise.all([
    Like.find({
      user: viewerId,
      $or: [
        { targetType: "Post", target: { $in: postIds } },
        { targetType: "Comment", target: { $in: replyIds } },
      ],
    })
      .select("target")
      .lean(),
    Repost.find({
      user: viewerId,
      $or: [
        { targetType: "Post", target: { $in: postIds } },
        { targetType: "Comment", target: { $in: replyIds } },
      ],
    })
      .select("target")
      .lean(),
    postIds.length
      ? Saved.find({ user: viewerId, post: { $in: postIds } }).select("post").lean()
      : [],
  ]);

  const likedSet = new Set(likedEdges.map((edge) => edge.target.toString()));
  const repostedSet = new Set(repostedEdges.map((edge) => edge.target.toString()));
  const savedSet = new Set(savedEdges.map((edge) => edge.post.toString()));

  // Follow-back edges for every author on this page, in one query — the
  // "following" reply audience (author → viewer) can't be derived from the
  // viewer's own following list.
  const docs = [...postDocs, ...replyDocs];
  const pageAuthorIds = [
    ...new Set(docs.map((doc) => (doc.author?._id ?? doc.author)?.toString()).filter(Boolean)),
  ];
  const followBackEdges = pageAuthorIds.length
    ? await Follow.find({
        follower: { $in: pageAuthorIds },
        following: viewerId,
        status: "accepted",
      })
        .select("follower")
        .lean()
    : [];
  const followerSet = new Set(followBackEdges.map((edge) => edge.follower.toString()));

  const withViewer = (doc, kind) => {
    const id = doc._id.toString();
    const authorId = (doc.author?._id ?? doc.author)?.toString();
    return {
      ...doc,
      kind,
      viewerHasLiked: likedSet.has(id),
      viewerHasReposted: repostedSet.has(id),
      viewerHasSaved: kind === "post" ? savedSet.has(id) : false,
      viewerIsFollowingAuthor: followingSet.has(authorId),
      viewerCanReply: viewerCanReplyFromSets(doc, viewerId, { followingSet, followerSet }),
      ...(kind === "reply"
        ? { parentPost: parentPostMap.get(doc.post?.toString()) || null }
        : {}),
    };
  };

  const byId = new Map([
    ...postDocs.map((doc) => [doc._id.toString(), withViewer(doc, "post")]),
    ...replyDocs.map((doc) => [doc._id.toString(), withViewer(doc, "reply")]),
  ]);

  // Ordered by the merged page, and filtered: a document deleted between the id
  // query and this one is simply absent.
  const ordered = page.map((row) => byId.get(row._id.toString())).filter(Boolean);

  // Typed media, and poll results reduced to what this reader may see.
  return decorateContent(ordered, viewerId);
};

// ─────────────────────────────────────────────────────────────────────────────
// Recent searches
// ─────────────────────────────────────────────────────────────────────────────

const serializeHistoryEntry = (entry) => ({
  _id: entry._id,
  kind: entry.kind,
  query: entry.query || "",
  lastUsedAt: entry.lastUsedAt,
  user: entry.targetUser
    ? {
        _id: entry.targetUser._id,
        username: entry.targetUser.username,
        name: entry.targetUser.name || "",
        profilePic: entry.targetUser.profilePic,
        isVerified: Boolean(
          entry.targetUser.isVerified ||
            (entry.targetUser.verificationBadge && entry.targetUser.verificationBadge !== "none")
        ),
      }
    : null,
});

export const getSearchHistory = async (req, res) => {
  try {
    const entries = await SearchHistory.find({ user: req.user._id })
      .sort({ lastUsedAt: -1 })
      .limit(MAX_SEARCH_HISTORY)
      .populate("targetUser", "_id username name profilePic isVerified verificationBadge")
      .lean();

    res.status(200).json({
      // A profile entry whose account is gone has nothing to navigate to, so
      // it's dropped from the response rather than rendered as a blank row.
      entries: entries
        .filter((entry) => entry.kind === "query" || entry.targetUser)
        .map(serializeHistoryEntry),
    });
  } catch (error) {
    console.error("getSearchHistory error:", error);
    res.status(500).json({ error: "Failed to load recent searches" });
  }
};

/**
 * POST /search/history — record a search the viewer actually committed to.
 *
 * Called by the client on submit or on opening a result, never per keystroke:
 * recording as-you-type would fill the list with prefixes of one search.
 */
export const addSearchHistory = async (req, res) => {
  try {
    const userId = req.user._id;
    const kind = req.body?.kind === "user" ? "user" : "query";

    let query = "";
    let targetUser = null;

    if (kind === "user") {
      const rawUsername =
        typeof req.body?.username === "string" ? req.body.username.trim().replace(/^@+/, "") : "";
      if (!rawUsername) return res.status(400).json({ error: "A username is required" });

      const target = await User.findOne({
        username: new RegExp(`^${escapeRegex(rawUsername)}$`, "i"),
      })
        .select("_id")
        .lean();
      if (!target) return res.status(404).json({ error: "That account doesn't exist" });

      targetUser = target._id;
    } else {
      query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
      if (!query) return res.status(400).json({ error: "A search term is required" });
      if (query.length > MAX_SEARCH_QUERY_LENGTH) {
        return res
          .status(400)
          .json({ error: `Search terms can be up to ${MAX_SEARCH_QUERY_LENGTH} characters` });
      }
    }

    /*
     * Upsert rather than create-then-handle-duplicate: the unique (user, key)
     * index means two tabs searching the same thing at once would otherwise
     * race into a duplicate-key error.
     */
    const entry = await SearchHistory.findOneAndUpdate(
      { user: userId, key: historyKey({ kind, query, targetUser }) },
      {
        $set: { kind, query, targetUser, lastUsedAt: new Date() },
        $setOnInsert: { user: userId, key: historyKey({ kind, query, targetUser }) },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    )
      .populate("targetUser", "_id username name profilePic isVerified verificationBadge")
      .lean();

    // Trim the tail so one account's history can't grow without bound.
    const stale = await SearchHistory.find({ user: userId })
      .sort({ lastUsedAt: -1 })
      .skip(MAX_SEARCH_HISTORY)
      .select("_id")
      .lean();
    if (stale.length) {
      await SearchHistory.deleteMany({
        user: userId,
        _id: { $in: stale.map((row) => row._id) },
      });
    }

    res.status(200).json({ entry: serializeHistoryEntry(entry) });
  } catch (error) {
    console.error("addSearchHistory error:", error);
    res.status(500).json({ error: "Failed to save that search" });
  }
};

export const deleteSearchHistoryEntry = async (req, res) => {
  try {
    const { entryId } = req.params;
    if (!mongoose.isValidObjectId(entryId)) {
      return res.status(400).json({ error: "That entry isn't valid" });
    }

    // Scoped to the caller — an id alone must not be enough to delete somebody
    // else's history.
    const result = await SearchHistory.deleteOne({ _id: entryId, user: req.user._id });
    if (!result.deletedCount) return res.status(404).json({ error: "That entry no longer exists" });

    res.status(200).json({ removed: entryId });
  } catch (error) {
    console.error("deleteSearchHistoryEntry error:", error);
    res.status(500).json({ error: "Failed to remove that search" });
  }
};

export const clearSearchHistory = async (req, res) => {
  try {
    const result = await SearchHistory.deleteMany({ user: req.user._id });
    res.status(200).json({ cleared: result.deletedCount });
  } catch (error) {
    console.error("clearSearchHistory error:", error);
    res.status(500).json({ error: "Failed to clear recent searches" });
  }
};
