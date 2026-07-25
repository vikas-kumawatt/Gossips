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

export const buildCursorQuery = (cursor) => {
  if (!cursor) return {};
  return {
    $or: [
      { createdAt: { $lt: new Date(cursor.createdAt) } },
      {
        createdAt: new Date(cursor.createdAt),
        _id: { $lt: cursor._id },
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
