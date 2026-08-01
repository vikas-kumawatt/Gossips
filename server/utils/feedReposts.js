import Repost from "../models/Repost.js";
import User from "../models/User.js";

/**
 * Reposts, as entries in the home feed.
 *
 * The feed has two chronologies: an original post is placed by its own
 * `createdAt`, a repost by when it was reposted. A cursor is one
 * `{createdAt,_id}` pair, so rather than inventing a two-watermark cursor the
 * feed fetches each stream separately — both already sorted and both filtered
 * by the same cursor predicate — and merge-sorts them in memory.
 *
 * That is exact, not approximate: each source returns at least `limit + 1`
 * entries (or is exhausted), so the top `limit` of the merged head is the true
 * global top `limit`. The cursor that comes out is just the last entry's own
 * date and id, whichever collection it came from — the tiebreak compares ids
 * across two id spaces, which is arbitrary but stable, and stable is all a
 * tiebreak has to be.
 */

/**
 * One page of repost entries, newest first.
 *
 * @param {object}   opts
 * @param {ObjectId[]} opts.reposterIds  whose reposts to surface
 * @param {object}   opts.cursorQuery    from buildCursorQuery, applied to the edge
 * @param {number}   opts.limit
 * @param {object}   opts.visibility     the same author/privacy filter the feed
 *                                       applies to originals, re-checked here
 *                                       against the *reposted* post's author
 * @returns {Promise<{entries: Array, floor: Date|null}>} `floor` is set when
 *          the candidate window filled up without yielding a full page: every
 *          repost older than it is unexamined, so the caller must not let the
 *          cursor move past it.
 */
export const loadRepostFeedEntries = async ({
  reposterIds,
  cursorQuery,
  limit,
  visibility,
}) => {
  if (!reposterIds?.length) return { entries: [], floor: null };

  const CANDIDATE_WINDOW = (limit + 1) * 3;

  const rows = await Repost.aggregate([
    {
      $match: {
        user: { $in: reposterIds },
        targetType: "Post",
        ...cursorQuery,
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    // A window wider than a page, because the visibility stages below will
    // drop some of it — a page shouldn't come back short just because one
    // reposted post turned out to be private or deleted.
    { $limit: CANDIDATE_WINDOW },
    {
      /*
       * Both branches see the same window. `meta` records how far back it
       * reached, `visible` is what survived. They have to be measured on the
       * same input or the floor below is a guess.
       */
      $facet: {
        meta: [
          { $group: { _id: null, candidates: { $sum: 1 }, oldest: { $min: "$createdAt" } } },
        ],
        visible: [
          {
            $lookup: {
              from: "posts",
              localField: "target",
              foreignField: "_id",
              as: "post",
              pipeline: [{ $project: { author: 1, isDeleted: 1, isDraft: 1 } }],
            },
          },
          { $unwind: "$post" },
          /*
           * The reposted post has to clear the same bar as any other feed
           * entry. Checking only the reposter would let a followee surface a
           * private account's post, or one whose author the viewer muted.
           */
          {
            $match: {
              "post.isDeleted": { $ne: true },
              "post.isDraft": { $ne: true },
              ...(visibility.excludedAuthorIds.length
                ? { "post.author": { $nin: visibility.excludedAuthorIds } }
                : {}),
              ...(visibility.dismissedPostIds.length
                ? { "post._id": { $nin: visibility.dismissedPostIds } }
                : {}),
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "post.author",
              foreignField: "_id",
              as: "postAuthor",
              pipeline: [{ $project: { isPrivate: 1 } }],
            },
          },
          { $unwind: "$postAuthor" },
          {
            $match: {
              $or: [
                { "postAuthor.isPrivate": { $ne: true } },
                { "post.author": visibility.viewerId },
                { "post.author": { $in: visibility.followingIds } },
              ],
            },
          },
          // $facet preserves input order, so the window's sort still holds.
          { $limit: limit + 1 },
          { $project: { _id: 1, createdAt: 1, user: 1, target: 1 } },
        ],
      },
    },
  ]);

  const meta = rows[0]?.meta?.[0];
  const edges = rows[0]?.visible || [];

  /*
   * The window filled and still didn't produce a full page, so everything
   * older than the oldest candidate is unexamined. The caller clamps the
   * cursor to this, otherwise those reposts are skipped for good.
   */
  const saturated = (meta?.candidates || 0) >= CANDIDATE_WINDOW;
  const floor = saturated && edges.length <= limit ? meta?.oldest || null : null;

  if (!edges.length) return { entries: [], floor };

  // One lookup for every reposter on the page; the card only shows a name.
  const reposters = await User.find({ _id: { $in: edges.map((e) => e.user) } })
    .select("_id username name profilePic")
    .lean();
  const reposterById = new Map(reposters.map((u) => [u._id.toString(), u]));

  const entries = edges
    .map((edge) => {
      const reposter = reposterById.get(edge.user.toString());
      if (!reposter) return null;
      return {
        sortAt: edge.createdAt,
        sortId: edge._id,
        postId: edge.target.toString(),
        repostedBy: reposter,
      };
    })
    .filter(Boolean);

  return { entries, floor };
};

/**
 * Merges the two already-sorted streams and keeps the newest `limit + 1`.
 *
 * Entries are `{ sortAt, sortId }`; anything else on them rides along. Sorting
 * descending by date then id mirrors the `$lt` comparison the cursor uses, so
 * paging never skips or repeats.
 */
export const mergeFeedEntries = (postEntries, repostEntries, limit) => {
  const merged = [...postEntries, ...repostEntries].sort((a, b) => {
    const byDate = new Date(b.sortAt) - new Date(a.sortAt);
    if (byDate !== 0) return byDate;
    const left = String(a.sortId);
    const right = String(b.sortId);
    if (left === right) return 0;
    return right > left ? 1 : -1;
  });

  /*
   * One card per post per page. Two people you follow reposting the same
   * thing, or a repost of something already in the feed on its own, would
   * otherwise appear twice in a row. The first occurrence wins, which is the
   * more recent event.
   */
  const seenPosts = new Set();
  const deduped = [];
  for (const entry of merged) {
    if (seenPosts.has(entry.postId)) continue;
    seenPosts.add(entry.postId);
    deduped.push(entry);
    if (deduped.length > limit) break;
  }

  return deduped;
};
