import mongoose from "mongoose";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const parseCursorLimit = (limit, fallback = DEFAULT_LIMIT) => {
  const parsed = Number.parseInt(limit, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIMIT);
};

export const encodeCursor = (payload) => {
  if (!payload?.createdAt || !payload?._id) return null;
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(payload.createdAt).toISOString(),
      _id: payload._id.toString(),
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

  return {
    $or: [
      { createdAt: { [op]: new Date(cursor.createdAt) } },
      {
        createdAt: new Date(cursor.createdAt),
        _id: { [op]: id },
      },
    ],
  };
};

export const buildCursorPageInfo = (items, limit) => {
  const hasNextPage = items.length > limit;
  const pagedItems = hasNextPage ? items.slice(0, limit) : items;
  const lastItem = pagedItems[pagedItems.length - 1];
  return {
    items: pagedItems,
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage ? encodeCursor(lastItem) : null,
    },
  };
};
