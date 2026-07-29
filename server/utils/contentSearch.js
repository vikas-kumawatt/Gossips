import mongoose from "mongoose";
import { escapeRegex } from "./respond.js";
import { parseBooleanFlag } from "./booleanFlag.js";

/**
 * Query parsing and pipeline building for content search.
 *
 * Search spans two collections — Post and Comment — because in this app a
 * reply is a Comment, and an "Exclude replies" filter that only looked at
 * Post.parentGossip would filter nothing. Both are matched independently and
 * merged by recency; see `mergeByRecency` for why that's a correct global page.
 *
 * Everything a client sends arrives here untrusted. Values are coerced to a
 * single string first (duplicated query params arrive as arrays), then
 * validated by type and range, and anything that doesn't parse is rejected
 * rather than silently dropped — a filter that quietly stops applying makes
 * search results look complete when they aren't.
 */

export const MAX_SEARCH_QUERY_LENGTH = 100;
export const MAX_SEARCH_LIMIT = 25;
const MAX_COUNT_FILTER = 1_000_000;
const MAX_USERNAME_LENGTH = 40;

/** "Date posted" presets, as a window back from now. */
const DATE_WINDOWS_MS = {
  hour:  60 * 60 * 1000,
  day:   24 * 60 * 60 * 1000,
  week:  7  * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year:  365 * 24 * 60 * 60 * 1000,
};

const FROM_PROFILES = new Set(["anyone", "following", "user"]);
const DATE_PRESETS = new Set(["all", ...Object.keys(DATE_WINDOWS_MS)]);

/** Authors whose content is never returned by a discovery surface. */
const ACTIVE_ACCOUNT_STATUSES = { $nin: ["deleted", "deactivated", "suspended", "locked"] };

/**
 * `?q=a&q=b` arrives as an array and `?q[x]=y` as an object; neither has a
 * legitimate reading. Collapse to the first string so validation below sees a
 * scalar instead of throwing on `.trim()`.
 */
const firstString = (value) => {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
};

const parseCount = (raw, label) => {
  const text = firstString(raw).trim();
  if (!text) return { value: 0 };
  /*
   * Digits only, deliberately narrower than Number(): "1e3" and "0x10" both
   * parse to sensible integers and would be accepted, but neither is something
   * the composer can produce, and quietly reinterpreting them is how a filter
   * ends up meaning something the person never typed.
   */
  if (!/^\d+$/.test(text)) {
    return { error: `${label} has to be a whole number, 0 or more` };
  }
  const parsed = Number(text);
  if (parsed > MAX_COUNT_FILTER) {
    return { error: `${label} has to be ${MAX_COUNT_FILTER.toLocaleString("en-US")} or less` };
  }
  return { value: parsed };
};

const parseDate = (raw, label) => {
  const text = firstString(raw).trim();
  if (!text) return { value: null };
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return { error: `${label} isn't a valid date` };
  return { value: parsed };
};

/**
 * Validate the whole filter set. Returns { filters } or { error }.
 *
 * The date boundaries are absolute instants, converted from the picker's local
 * dates by the client — "after 20 July" means from local midnight on the 20th,
 * and "before 29 July" through the end of the 29th. Doing that conversion in
 * the browser is what makes both ends inclusive of the days the user named,
 * whatever timezone they're in.
 */
export const parseSearchFilters = (query = {}) => {
  const rawQuery = firstString(query.q);
  if (rawQuery.length > MAX_SEARCH_QUERY_LENGTH) {
    return { error: `Search terms can be up to ${MAX_SEARCH_QUERY_LENGTH} characters` };
  }
  const q = rawQuery.trim();

  const from = firstString(query.from).trim() || "anyone";
  if (!FROM_PROFILES.has(from)) return { error: "That profile filter isn't valid" };

  let username = "";
  if (from === "user") {
    // People type the handle with the @ still attached.
    username = firstString(query.username).trim().replace(/^@+/, "");
    if (!username) return { error: "Enter a username to search one profile" };
    if (username.length > MAX_USERNAME_LENGTH) return { error: "That username is too long" };
  }

  const datePosted = firstString(query.datePosted).trim() || "all";
  if (!DATE_PRESETS.has(datePosted)) return { error: "That date range isn't valid" };

  const after = parseDate(query.after, "The after date");
  if (after.error) return { error: after.error };
  const before = parseDate(query.before, "The before date");
  if (before.error) return { error: before.error };
  if (after.value && before.value && after.value.getTime() > before.value.getTime()) {
    return { error: "The after date has to come before the before date" };
  }

  const minLikes = parseCount(query.minLikes, "Minimum likes");
  if (minLikes.error) return { error: minLikes.error };
  const minComments = parseCount(query.minComments, "Minimum comments");
  if (minComments.error) return { error: minComments.error };
  const minReposts = parseCount(query.minReposts, "Minimum reposts");
  if (minReposts.error) return { error: minReposts.error };

  return {
    filters: {
      q,
      from,
      username,
      datePosted,
      after: after.value,
      before: before.value,
      minLikes: minLikes.value,
      minComments: minComments.value,
      minReposts: minReposts.value,
      excludeReplies: parseBooleanFlag(firstString(query.excludeReplies), false),
    },
  };
};

/**
 * The created-at window.
 *
 * A preset and an explicit after/before can both be present. They're
 * intersected — the tightest lower bound and the given upper bound — rather
 * than one overriding the other, so no combination can widen the result set
 * beyond what every active filter allows. (The UI keeps them mutually
 * exclusive; this is what happens if a request sends both anyway.)
 */
const buildDateMatch = ({ datePosted, after, before }) => {
  const lowerBounds = [];
  if (after) lowerBounds.push(after.getTime());
  if (DATE_WINDOWS_MS[datePosted]) lowerBounds.push(Date.now() - DATE_WINDOWS_MS[datePosted]);

  const range = {};
  if (lowerBounds.length) range.$gte = new Date(Math.max(...lowerBounds));
  if (before) range.$lte = before;
  return Object.keys(range).length ? { createdAt: range } : {};
};

/**
 * Activity thresholds. Post and Comment happen to use the same three cached
 * counters, so one builder serves both — for a reply, "comments" is its own
 * reply count.
 */
const buildCountMatch = ({ minLikes, minComments, minReposts }) => ({
  ...(minLikes ? { "counts.likes": { $gte: minLikes } } : {}),
  ...(minComments ? { "counts.replies": { $gte: minComments } } : {}),
  ...(minReposts ? { "counts.reposts": { $gte: minReposts } } : {}),
});

/**
 * Cursor match for an aggregation.
 *
 * `decodeCursor` returns strings, and aggregation — unlike `find` — does no
 * schema casting: a raw `_id` string compared with `$lt` against ObjectIds
 * matches nothing at all, silently dropping every row that shares a timestamp
 * with the cursor. So the id is validated and converted here.
 */
export const buildAggregateCursorMatch = (cursor) => {
  if (!cursor) return { match: {} };

  const createdAt = new Date(cursor.createdAt);
  if (Number.isNaN(createdAt.getTime()) || !mongoose.isValidObjectId(cursor._id)) {
    return { error: "That page cursor isn't valid" };
  }
  const id = new mongoose.Types.ObjectId(cursor._id);

  return {
    match: {
      $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: id } }],
    },
  };
};

/**
 * Author constraints, as a list so they can be $and-ed.
 *
 * They have to be combined rather than assigned: a single-profile filter, a
 * following filter and the muted/blocked exclusion would otherwise each write
 * `author` and the last one would win — which is how a mute silently stops
 * applying.
 */
const buildAuthorConditions = ({ field, authorId, from, followingIds, hiddenAuthorIds }) => {
  const conditions = [];
  if (authorId) conditions.push({ [field]: authorId });
  if (from === "following") conditions.push({ [field]: { $in: followingIds } });
  if (hiddenAuthorIds.length) conditions.push({ [field]: { $nin: hiddenAuthorIds } });
  return conditions;
};

/**
 * Is this author's content visible to the viewer? Mirrors the home feed: the
 * account is public, or it's the viewer's own, or the viewer follows it.
 * Suspended and deleted accounts drop out of search entirely — search is a
 * discovery surface, and user discovery already excludes them.
 */
const authorVisibilityMatch = ({ prefix, authorField, viewerId, followingIds }) => ({
  [`${prefix}.accountStatus`]: ACTIVE_ACCOUNT_STATUSES,
  $or: [
    { [`${prefix}.isPrivate`]: { $ne: true } },
    { [authorField]: viewerId },
    { [authorField]: { $in: followingIds } },
  ],
});

/**
 * Posts matching the search, newest first, as { _id, createdAt } only.
 *
 * The author join happens before the sort and limit, not after: limiting first
 * would cut the page down before invisible rows were removed, so a page could
 * come back short — or skip visible posts entirely on the next cursor.
 */
export const buildPostSearchPipeline = ({
  viewerId,
  filters,
  contentRegex,
  cursorMatch,
  authorId,
  followingIds,
  hiddenAuthorIds,
  limit,
}) => {
  const authorConditions = buildAuthorConditions({
    field: "author",
    authorId,
    from: filters.from,
    followingIds,
    hiddenAuthorIds,
  });

  return [
    {
      $match: {
        isDeleted: { $ne: true },
        // A scheduled post is stored as a draft until it goes out, so this one
        // exclusion covers both.
        isDraft: { $ne: true },
        ...(contentRegex ? { content: contentRegex } : {}),
        // Posts carrying a parent are replies in the legacy sense; excluded
        // alongside Comments when the viewer asked for no replies.
        ...(filters.excludeReplies ? { parentGossip: null } : {}),
        ...buildDateMatch(filters),
        ...buildCountMatch(filters),
        ...cursorMatch,
        ...(authorConditions.length ? { $and: authorConditions } : {}),
      },
    },
    { $lookup: { from: "users", localField: "author", foreignField: "_id", as: "authorDoc" } },
    { $unwind: "$authorDoc" },
    { $match: authorVisibilityMatch({ prefix: "authorDoc", authorField: "author", viewerId, followingIds }) },
    // Shed the joined account before sorting — the sort only needs the key.
    { $project: { _id: 1, createdAt: 1 } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit },
  ];
};

/**
 * Replies matching the search, newest first, as { _id, createdAt } only.
 *
 * A reply's own author being visible isn't sufficient: a public reply written
 * under a private account's post is only visible to that account's followers,
 * and a reply under a blocked account's post shouldn't surface either. So the
 * parent post and its author are joined and checked by the same rule, and a
 * reply whose post has since been deleted or unpublished drops out with it.
 */
export const buildReplySearchPipeline = ({
  viewerId,
  filters,
  contentRegex,
  cursorMatch,
  authorId,
  followingIds,
  hiddenAuthorIds,
  limit,
}) => {
  const authorConditions = buildAuthorConditions({
    field: "author",
    authorId,
    from: filters.from,
    followingIds,
    hiddenAuthorIds,
  });

  return [
    {
      $match: {
        isDeleted: { $ne: true },
        isScheduled: { $ne: true },
        ...(contentRegex ? { content: contentRegex } : {}),
        ...buildDateMatch(filters),
        ...buildCountMatch(filters),
        ...cursorMatch,
        ...(authorConditions.length ? { $and: authorConditions } : {}),
      },
    },
    { $lookup: { from: "users", localField: "author", foreignField: "_id", as: "authorDoc" } },
    { $unwind: "$authorDoc" },
    { $match: authorVisibilityMatch({ prefix: "authorDoc", authorField: "author", viewerId, followingIds }) },

    // Parent post: still live, and its author visible to this viewer.
    { $lookup: { from: "posts", localField: "post", foreignField: "_id", as: "postDoc" } },
    { $unwind: "$postDoc" },
    {
      $match: {
        "postDoc.isDeleted": { $ne: true },
        "postDoc.isDraft": { $ne: true },
        ...(hiddenAuthorIds.length ? { "postDoc.author": { $nin: hiddenAuthorIds } } : {}),
      },
    },
    { $lookup: { from: "users", localField: "postDoc.author", foreignField: "_id", as: "postAuthorDoc" } },
    { $unwind: "$postAuthorDoc" },
    {
      $match: authorVisibilityMatch({
        prefix: "postAuthorDoc",
        authorField: "postDoc.author",
        viewerId,
        followingIds,
      }),
    },

    { $project: { _id: 1, createdAt: 1 } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit },
  ];
};

/**
 * Merge the per-collection pages into one globally-ordered page.
 *
 * Correct because each side returned its own newest `limit` rows before the
 * same cursor: anything a side left out is older than everything it returned,
 * so it cannot belong in the merged newest `limit`. The `_id` tiebreaker
 * compares hex strings, which orders the same way the ObjectIds do.
 */
export const mergeByRecency = (items, limit) =>
  [...items]
    .sort((a, b) => {
      const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (diff !== 0) return diff;
      return String(b._id).localeCompare(String(a._id));
    })
    .slice(0, limit);
