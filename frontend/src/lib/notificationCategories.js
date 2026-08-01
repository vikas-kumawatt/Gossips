/**
 * The Activity tabs, in order.
 *
 * Labels and ordering only — which notification types belong to a category is
 * the server's business, in server/utils/notificationCategories.js. The `id`s
 * are the contract between the two.
 */

export const NOTIFICATION_TABS = [
  { id: "all", label: "All" },
  // Only an account that can *receive* requests has anything to put here.
  { id: "follow_requests", label: "Follow requests", privateOnly: true },
  { id: "follows", label: "Follows" },
  { id: "replies", label: "Replies" },
  { id: "mentions", label: "Mentions" },
  { id: "quotes", label: "Quotes" },
  { id: "reposts", label: "Reposts" },
  // Everything a verified account did, whatever kind of action it was.
  { id: "verified", label: "Verified" },
];

/** The tabs this account should actually see. */
export const visibleNotificationTabs = (isPrivate) =>
  NOTIFICATION_TABS.filter((tab) => !tab.privateOnly || isPrivate);

/**
 * What an empty tab should say. A generic "nothing here" on eight different
 * tabs tells you nothing about which one you're looking at.
 */
export const emptyNotificationMessage = (categoryId) =>
  ({
    all: "No notifications yet.",
    follow_requests: "No pending follow requests.",
    follows: "Nobody new has followed you yet.",
    replies: "No replies yet.",
    mentions: "No mentions yet.",
    quotes: "Nobody has quoted you yet.",
    reposts: "No reposts yet.",
    verified: "No activity from verified accounts yet.",
  })[categoryId] || "Nothing here yet.";
