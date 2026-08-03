import mongoose from "mongoose";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const parseCursorLimit = (limit, fallback = DEFAULT_LIMIT) => {
  const parsed = Number.parseInt(limit, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIMIT);
};

/**
 * @param {string} field  The document field the query sorts on. Defaults to
 *   `createdAt`, which is what every feed uses. Pass the real sort field for
 *   anything else — a cursor built on one field while the query sorts by
 *   another skips and repeats rows, which is what `getPinnedMessages` did
 *   (sorted by `pinnedAt`, paged by `createdAt`).
 *
 *   The encoded payload keeps the `createdAt` key whatever the field is, so
 *   cursors issued before this parameter existed still decode. `field` is
 *   written only when it isn't the default.
 */
export const encodeCursor = (payload, field = "createdAt") => {
  if (!payload?.[field] || !payload?._id) return null;
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(payload[field]).toISOString(),
      _id: payload._id.toString(),
      ...(field === "createdAt" ? {} : { field }),
    })
  ).toString("base64url");
};

export const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    if (!decoded?.createdAt || !decoded?._id) return null;
    return decoded;
  } catch {
    return null;
  }
};

/**
 * @param {"desc"|"asc"} direction  Match the query's sort. "desc" (default,
 *   newest-first feeds) pages with `$lt`; "asc" (oldest-first, e.g. the flat
 *   reply list under a comment) pages with `$gt`. Using the wrong operator for
 *   the sort silently re-serves or skips rows, so this must track the sort.
 */
export const buildCursorQuery = (cursor, direction = "desc") => {
  if (!cursor) return {};
  const op = direction === "asc" ? "$gt" : "$lt";

  /*
   * The id is cast explicitly. `decodeCursor` returns it as a string, and
   * while Mongoose casts a `find` filter it does not cast an aggregation
   * pipeline — and in BSON ordering a string sorts below every ObjectId, so
   * the tiebreak branch silently matched nothing and rows sharing the
   * boundary millisecond were skipped.
   */
  const id = mongoose.isValidObjectId(cursor._id)
    ? new mongoose.Types.ObjectId(cursor._id)
    : cursor._id;

  const field = cursor.field ?? "createdAt";
  const boundary = new Date(cursor.createdAt);

  return {
    $or: [
      { [field]: { [op]: boundary } },
      {
        [field]: boundary,
        _id: { [op]: id },
      },
    ],
  };
};

/**
 * Combine a filter with its cursor predicate.
 *
 * `buildCursorQuery` returns an object whose only key is `$or`, and every call
 * site merged it by spreading. That is silently destructive when the base
 * filter has an `$or` of its own: last-wins, and the *base* predicate is the
 * one that disappears. `searchMessages` did exactly this — from page two
 * onward the content match vanished and the endpoint returned every message in
 * the conversation older than the cursor, presented as search hits.
 *
 * Two `$or`s can't be siblings in one object, so when both are present they go
 * under `$and`, which is the only way to require both.
 */
export const withCursor = (query, cursor, direction = "desc") => {
  const cursorQuery = buildCursorQuery(cursor, direction);
  if (!cursorQuery.$or) return { ...query };

  const { $or, $and, ...rest } = query;
  if (!$or) return { ...query, ...cursorQuery };
  return { ...rest, $and: [...($and ?? []), { $or }, cursorQuery] };
};

/**
 * Combine filter objects without losing any of them.
 *
 * `withCursor` above solves this for one specific pair. The general problem is the
 * same and bit us a second time in `globalSearch`, which spread a content-match
 * `{$or}` over a caller-scoping `{$or}` — last key wins, and the one that vanished
 * was the predicate restricting results to the caller's own conversations. It
 * returned rows, so nothing looked broken; they were just everybody's rows.
 *
 * Any key present in more than one input goes under `$and`, which is the only way to
 * require both. Keys that appear once are merged flat, so the common case produces
 * exactly the object you'd have written by hand and the query planner sees no
 * difference.
 */
export const mergeFilters = (...filters) => {
  const present = filters.filter((f) => f && typeof f === "object");

  const counts = new Map();
  for (const filter of present) {
    for (const key of Object.keys(filter)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const flat = {};
  const conflicting = [];

  for (const filter of present) {
    const clashes = {};
    let hasClash = false;
    for (const [key, value] of Object.entries(filter)) {
      if (counts.get(key) > 1) {
        clashes[key] = value;
        hasClash = true;
      } else {
        flat[key] = value;
      }
    }
    if (hasClash) conflicting.push(clashes);
  }

  if (!conflicting.length) return flat;
  // An existing $and is extended rather than replaced, or merging a filter that
  // already had one would drop it.
  const existing = Array.isArray(flat.$and) ? flat.$and : [];
  return { ...flat, $and: [...existing, ...conflicting] };
};

export const buildCursorPageInfo = (items, limit, field = "createdAt") => {
  const more = items.length > limit;
  const pagedItems = more ? items.slice(0, limit) : items;
  const lastItem = pagedItems[pagedItems.length - 1];
  const nextCursor = more ? encodeCursor(lastItem, field) : null;

  return {
    items: pagedItems,
    pageInfo: {
      /*
       * `hasNextPage` only when there is a cursor to ask with.
       *
       * `encodeCursor` returns null if the boundary row has no value for the
       * sort field — a message pinned before `pinnedAt` existed, say. Reporting
       * `hasNextPage: true` with `nextCursor: null` tells the client there is
       * more and gives it no way to fetch it, which is an infinite spinner or a
       * dead "load more" button. Stopping one page short is the lesser evil,
       * and it's visible rather than silent.
       */
      hasNextPage: more && nextCursor !== null,
      nextCursor,
    },
  };
};
