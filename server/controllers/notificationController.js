import Notification from "../models/Notification.js";
import User from "../models/User.js";
import Follow from "../models/Follow.js";
import { sendNotification } from "../utils/notifications.js";
import {
  buildCursorPageInfo,
  buildCursorQuery,
  decodeCursor,
  parseCursorLimit,
} from "../utils/cursorPagination.js";
import { categoryFilter, isNotificationCategory } from "../utils/notificationCategories.js";

export const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const { cursor, limit = 20, category = "all" } = req.query;
    const limitNum = parseCursorLimit(limit, 20);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    // An unknown category falls back to everything rather than erroring: a tab
    // this build doesn't know about shouldn't be a broken page.
    const active = isNotificationCategory(category) ? category : "all";
    const { filter, needsVerifiedSenders } = categoryFilter(active);

    /*
     * The Verified tab filters by *who sent it*, which isn't on the
     * notification. Resolving the verified accounts first and matching
     * `sender: { $in }` beats a $lookup: the set is small, it's cached by
     * Mongo, and it keeps the query on the {recipient, createdAt} index that
     * the cursor needs.
     */
    let senderFilter = {};
    if (needsVerifiedSenders) {
      const verified = await User.find({
        // Equality on both branches, never $ne: `{$ne: "none"}` matches
        // documents that simply don't have the field, and this one was
        // retrofitted — so every legacy account counted as verified.
        $or: [{ isVerified: true }, { verificationBadge: "blue" }],
      })
        .select("_id")
        .lean();

      // Nobody is verified — say so with a filter that matches nothing rather
      // than dropping the condition and returning the whole inbox.
      senderFilter = { sender: { $in: verified.map((u) => u._id) } };
    }

    const notifications = await Notification.find({
      recipient: userId,
      ...filter,
      ...senderFilter,
      ...cursorQuery,
    })
      .populate("sender", "username name profilePic isVerified")
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();
    const { items: pagedNotifications, pageInfo } = buildCursorPageInfo(
      notifications,
      limitNum
    );

    const groupedNotifications = [];
    const groupedLikeIndexByKey = new Map();

    for (const notification of pagedNotifications) {
      const isLike = notification.type === "like";
      const targetId = notification.entity;
      const dayKey = new Date(notification.createdAt).toISOString().slice(0, 10);
      const groupingKey =
        isLike && targetId
          ? `like:${targetId.toString()}:${dayKey}`
          : null;

      if (!groupingKey) {
        groupedNotifications.push(notification);
        continue;
      }

      const existingIndex = groupedLikeIndexByKey.get(groupingKey);
      if (existingIndex === undefined) {
        groupedLikeIndexByKey.set(groupingKey, groupedNotifications.length);
        groupedNotifications.push({
          ...notification,
          groupedLikeCount: 1,
          groupedLikeSenderIds: [notification.sender?._id?.toString()].filter(Boolean),
        });
        continue;
      }

      const existing = groupedNotifications[existingIndex];
      const senderId = notification.sender?._id?.toString();
      const senderIds = existing.groupedLikeSenderIds || [];

      if (senderId && !senderIds.includes(senderId)) {
        existing.groupedLikeSenderIds = [...senderIds, senderId];
        existing.groupedLikeCount = (existing.groupedLikeCount || 1) + 1;
      }
    }

    const senderIds = [
      ...new Set(
        groupedNotifications
          .map((notification) => notification?.sender?._id?.toString())
          .filter(Boolean)
      ),
    ];

    const [followingEdges, followerEdges, pendingRequests] = await Promise.all([
      Follow.find({ follower: userId, status: "accepted" }).select("following").lean(),
      Follow.find({ following: userId, status: "accepted" }).select("follower").lean(),
      Follow.find({ follower: userId, following: { $in: senderIds }, status: "pending" })
        .select("following")
        .lean(),
    ]);

    const followingSet = new Set(followingEdges.map((e) => e.following.toString()));
    const followersSet = new Set(followerEdges.map((e) => e.follower.toString()));
    const pendingSet = new Set(pendingRequests.map((r) => r.following.toString()));

    const enrichedNotifications = groupedNotifications.map((notification) => {
      const senderId = notification?.sender?._id?.toString();
      if (!senderId) return notification;

      return {
        ...notification,
        groupedLikeCount: notification.groupedLikeCount || 1,
        sender: {
          ...notification.sender,
          relationship: {
            isFollowing: followingSet.has(senderId),
            isPending: pendingSet.has(senderId),
            canFollowBack: followersSet.has(senderId),
          },
        },
      };
    });

    res.status(200).json({
      notifications: enrichedNotifications,
      category: active,
      pageInfo,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * GET /notification/unread-count — what the tab badge is drawn from.
 *
 * The badge used to start at zero on every page load and only ever count up
 * from live socket events, so anything that arrived while you were logged out,
 * on another device, or simply on a different tab never showed. Seeding from
 * here on mount, on socket reconnect and on tab focus makes the badge correct
 * regardless of which events the connection happened to catch.
 */
export const getUnreadNotificationCount = async (req, res) => {
  try {
    // countDocuments on {recipient, isRead}, which is already indexed.
    const count = await Notification.countDocuments({
      recipient: req.user._id,
      isRead: false,
    });
    return res.status(200).json({ count });
  } catch (error) {
    console.error("getUnreadNotificationCount error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

export const markAllNotificationsAsRead = async (req, res) => {
  try {
    const userId = req.user._id;

    const result = await Notification.updateMany(
      { recipient: userId, isRead: false },
      { isRead: true }
    );

    if (result.modifiedCount === 0) {
      return res.status(200).json({ message: "No unread notifications to mark" });
    }

    res.status(200).json({ message: "All notifications marked as read" });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const sendWelcomeNotification = async (newUserId) => {
  try {
    const gossipsUser = await User.findOne({ username: "gossips" });
    if (!gossipsUser) {
      console.error("Gossips account not found");
      return;
    }

    const newUser = await User.findById(newUserId);
    if (!newUser) {
      console.error("New user not found");
      return;
    }

    await sendNotification(newUserId, gossipsUser._id, "welcome");
  } catch (error) {
    console.error("Error sending welcome notification:", error);
  }
};