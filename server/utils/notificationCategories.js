/**
 * The tabs on the Activity page, and the notification types behind each.
 *
 * Filtering happens in the query, not on the client. A client-side filter looks
 * simpler right up until you paginate: page one might hold two replies out of
 * twenty rows, so the Replies tab shows two items and an infinite scroll that
 * has nothing left to trigger it. The database has the index; let it filter.
 *
 * Mirrored by frontend/src/lib/notificationCategories.js, which owns only the
 * labels and the order. Types live here because the server decides what a
 * category means.
 */

export const NOTIFICATION_CATEGORIES = {
  all: null, // no type filter
  follow_requests: ["follow_request"],
  follows: ["follow", "follow_request_accepted"],
  replies: ["reply"],
  mentions: ["mention"],
  quotes: ["quote", "quote_comment"],
  reposts: ["repost"],
  /*
   * Not a type — a filter on who sent it. Everything a verified account did,
   * whatever kind of action it was. That's what the tab means on Instagram and
   * X, and it's the only one of these that's about the sender rather than the
   * event.
   */
  verified: "sender:verified",
};

export const isNotificationCategory = (value) =>
  typeof value === "string" && Object.hasOwn(NOTIFICATION_CATEGORIES, value);

/**
 * The Mongo filter for a category, minus the verified case which needs a
 * sender lookup the caller has to do.
 *
 * @returns {{filter: object, needsVerifiedSenders: boolean}}
 */
export const categoryFilter = (category) => {
  const spec = NOTIFICATION_CATEGORIES[category];

  if (!spec) return { filter: {}, needsVerifiedSenders: false };
  if (spec === "sender:verified") return { filter: {}, needsVerifiedSenders: true };

  return { filter: { type: { $in: spec } }, needsVerifiedSenders: false };
};
