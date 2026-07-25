import { uploadToCloudinary } from "../config/cloudinary.js";
import { sendNotification } from "../utils/notifications.js";
import { getOrSet, del, delByPrefix, CacheKeys } from "../utils/cache.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import Repost from "../models/Repost.js";
import User from "../models/User.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import { io, getUserSocket } from "../server.js";
import {
  buildCursorPageInfo,
  buildCursorQuery,
  decodeCursor,
  parseCursorLimit,
} from "../utils/cursorPagination.js";

const ACTIVE_ACCOUNT_FILTER = {
  accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] },
};

const invalidateFollowRelatedCaches = async (...usernames) => {
  const unique = [...new Set(usernames.filter(Boolean))];
  await Promise.all(
    unique.flatMap((username) => [
      del(CacheKeys.profile(username)),
      delByPrefix(`followers:${username}:`),
      delByPrefix(`following:${username}:`),
    ])
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

export const setupProfile = async (req, res) => {
  try {
    const { bio, link, isPrivate } = req.body;

    if (bio && bio.length > 150) {
      return res.status(403).json({ error: "Bio should be less than 150 characters" });
    }
    if (link) {
      try { new URL(link); } catch {
        return res.status(400).json({ error: "Invalid URL format" });
      }
    }

    const updateObj = {};
    if (bio !== undefined) updateObj.bio = bio;
    if (link !== undefined) updateObj.link = link;
    if (isPrivate !== undefined)
      updateObj.isPrivate = isPrivate === "true" || isPrivate === true;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.path);
      updateObj.profilePic = result.secure_url;
    }

    if (Object.keys(updateObj).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // When switching from private → public, auto-accept all pending follow requests
    const parsedIsPrivate = isPrivate === "true" || isPrivate === true;
    if (isPrivate !== undefined && !parsedIsPrivate) {
      const user = await User.findById(req.user).select("isPrivate username").lean();
      if (user?.isPrivate) {
        const pending = await Follow.find({
          following: req.user,
          status: "pending",
        }).select("follower").lean();

        if (pending.length > 0) {
          const followerIds = pending.map((f) => f.follower);

          // Accept all pending requests atomically
          await Follow.updateMany(
            { following: req.user, status: "pending" },
            { $set: { status: "accepted" } }
          );

          // Bump follower count on the now-public user; bump following counts on each requester
          await User.updateOne(
            { _id: req.user },
            { $inc: { "counts.followers": pending.length } }
          );
          await User.updateMany(
            { _id: { $in: followerIds } },
            { $inc: { "counts.following": 1 } }
          );

          // Notify each requester that their request was auto-accepted
          followerIds.forEach((followerId) => {
            const sockets = getUserSocket(followerId.toString());
            if (sockets) {
              sockets.forEach((id) => {
                io.to(id).emit("followStatusUpdate", {
                  username: user.username,
                  action: "follow",
                  isPending: false,
                  isPrivate: false,
                  autoAccepted: true,
                });
              });
            }
          });
        }
      }
    }

    const updatedUser = await User.findByIdAndUpdate(req.user, updateObj, {
      runValidators: true,
      new: true,
    });

    await del(CacheKeys.profile(updatedUser.username));
    return res.status(200).json({
      message: "Profile updated successfully",
      profilePic: updatedUser.profilePic,
    });
  } catch (error) {
    console.error("setupProfile error:", error);
    return res.status(500).json({ error: "Failed to update profile" });
  }
};

export const getUserProfile = async (req, res) => {
  try {
    const { username } = req.params;

    const profileData = await getOrSet(CacheKeys.profile(username), 60, async () => {
      const profile = await User.findOne({ username })
        .select("username name profilePic bio link isVerified verificationBadge isPrivate counts createdAt")
        .lean();

      if (!profile) return null;

      // Top-3 follower preview (recent followers)
      const recentFollowers = await Follow.find({ following: profile._id, status: "accepted" })
        .sort({ createdAt: -1 })
        .limit(3)
        .populate({
          path: "follower",
          select: "username name profilePic isVerified verificationBadge",
          match: ACTIVE_ACCOUNT_FILTER,
        })
        .lean();

      const followersPreview = recentFollowers
        .map((f) => f.follower)
        .filter(Boolean)
        .map((u) => ({
          _id: u._id,
          username: u.username,
          name: u.name || "",
          profilePic: u.profilePic,
          isVerified: Boolean(u.isVerified || (u.verificationBadge && u.verificationBadge !== "none")),
        }));

      return {
        _id: profile._id,
        username: profile.username,
        name: profile.name || "",
        profilePic: profile.profilePic,
        bio: profile.bio || "",
        link: profile.link || "",
        isVerified: Boolean(
          profile.isVerified || (profile.verificationBadge && profile.verificationBadge !== "none")
        ),
        isPrivate: Boolean(profile.isPrivate),
        followerCount: profile.counts?.followers ?? 0,
        followingCount: profile.counts?.following ?? 0,
        followersPreview,
      };
    });

    if (!profileData) return res.status(404).json({ error: "User not found" });

    // Block relationship (viewer-specific, not cached)
    const [youBlockedRel, blockedYouRel] = await Promise.all([
      UserRelation.findOne({ from: req.user._id, to: profileData._id, kind: "block" }).lean(),
      UserRelation.findOne({ from: profileData._id, to: req.user._id, kind: "block" }).lean(),
    ]);

    // If the profile owner blocked the viewer → Instagram shows "User not found".
    if (blockedYouRel) {
      return res.status(404).json({ error: "User not found" });
    }

    // Viewer-specific relationship (not cached)
    const followEdge = await Follow.findOne({
      follower: req.user._id,
      following: profileData._id,
    }).lean();

    const youBlocked = Boolean(youBlockedRel);

    return res.status(200).json({
      ...profileData,
      // When you've blocked them, don't leak follow state or counts of substance.
      relationship: {
        isFollowing: youBlocked ? false : followEdge?.status === "accepted",
        isPending: youBlocked ? false : followEdge?.status === "pending",
        youBlocked,
        blockedYou: false,
      },
    });
  } catch (error) {
    console.error("getUserProfile error:", error);
    return res.status(500).json({ error: "Failed to get profile" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Followers / Following lists
// ─────────────────────────────────────────────────────────────────────────────

export const getFollowersList = async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, limit = 20 } = req.query;
    const limitNum = parseCursorLimit(limit, 20);
    const parsedCursor = decodeCursor(cursor);

    const profileUser = await User.findOne({ username }).select("_id").lean();
    if (!profileUser) return res.status(404).json({ error: "User not found" });

    const cacheKey = `followers:${username}:${cursor || "start"}:${limitNum}`;
    const followersPage = await getOrSet(cacheKey, 60, async () => {
      const cursorFilter = parsedCursor
        ? { createdAt: { $lt: new Date(parsedCursor.createdAt) } }
        : {};

      const edges = await Follow.find({
        following: profileUser._id,
        status: "accepted",
        ...cursorFilter,
      })
        .sort({ createdAt: -1 })
        .limit(limitNum + 1)
        .populate({
          path: "follower",
          select: "username name profilePic isVerified verificationBadge isPrivate counts createdAt",
          match: ACTIVE_ACCOUNT_FILTER,
        })
        .lean();

      const validEdges = edges.filter((e) => e.follower);
      return buildCursorPageInfo(
        validEdges.map((e) => ({ ...e.follower, _edgeCreatedAt: e.createdAt })),
        limitNum,
        "_edgeCreatedAt"
      );
    });

    // Current viewer's follow state for items in this page
    const pageUserIds = followersPage.items.map((u) => u._id);
    const [viewerFollowEdges, pendingEdges] = await Promise.all([
      Follow.find({
        follower: req.user._id,
        following: { $in: pageUserIds },
        status: "accepted",
      }).select("following").lean(),
      Follow.find({
        follower: req.user._id,
        following: { $in: pageUserIds },
        status: "pending",
      }).select("following").lean(),
    ]);

    const followingSet = new Set(viewerFollowEdges.map((e) => e.following.toString()));
    const pendingSet = new Set(pendingEdges.map((e) => e.following.toString()));

    // Does the profile user follow the viewer? (canFollowBack)
    const reverseEdges = await Follow.find({
      follower: { $in: pageUserIds },
      following: req.user._id,
      status: "accepted",
    }).select("follower").lean();
    const reverseSet = new Set(reverseEdges.map((e) => e.follower.toString()));

    const users = followersPage.items.map((user) => {
      const id = user._id.toString();
      return {
        _id: user._id,
        username: user.username,
        name: user.name || "",
        profilePic: user.profilePic,
        isVerified: Boolean(user.isVerified || (user.verificationBadge && user.verificationBadge !== "none")),
        isPrivate: Boolean(user.isPrivate),
        followerCount: user.counts?.followers ?? 0,
        relationship: {
          isFollowing: followingSet.has(id),
          isPending: pendingSet.has(id),
          canFollowBack: reverseSet.has(id),
        },
      };
    });

    return res.status(200).json({
      users,
      pageInfo: followersPage.pageInfo,
      totalCount: await Follow.countDocuments({ following: profileUser._id, status: "accepted" }),
    });
  } catch (error) {
    console.error("getFollowersList error:", error);
    return res.status(500).json({ error: "Failed to get followers" });
  }
};

export const getFollowingList = async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, limit = 20 } = req.query;
    const limitNum = parseCursorLimit(limit, 20);
    const parsedCursor = decodeCursor(cursor);

    const profileUser = await User.findOne({ username }).select("_id").lean();
    if (!profileUser) return res.status(404).json({ error: "User not found" });

    const cacheKey = `following:${username}:${cursor || "start"}:${limitNum}`;
    const followingPage = await getOrSet(cacheKey, 60, async () => {
      const cursorFilter = parsedCursor
        ? { createdAt: { $lt: new Date(parsedCursor.createdAt) } }
        : {};

      const edges = await Follow.find({
        follower: profileUser._id,
        status: "accepted",
        ...cursorFilter,
      })
        .sort({ createdAt: -1 })
        .limit(limitNum + 1)
        .populate({
          path: "following",
          select: "username name profilePic isVerified verificationBadge isPrivate counts createdAt",
          match: ACTIVE_ACCOUNT_FILTER,
        })
        .lean();

      const validEdges = edges.filter((e) => e.following);
      return buildCursorPageInfo(
        validEdges.map((e) => ({ ...e.following, _edgeCreatedAt: e.createdAt })),
        limitNum,
        "_edgeCreatedAt"
      );
    });

    const pageUserIds = followingPage.items.map((u) => u._id);
    const [viewerFollowEdges, pendingEdges] = await Promise.all([
      Follow.find({
        follower: req.user._id,
        following: { $in: pageUserIds },
        status: "accepted",
      }).select("following").lean(),
      Follow.find({
        follower: req.user._id,
        following: { $in: pageUserIds },
        status: "pending",
      }).select("following").lean(),
    ]);

    const followingSet = new Set(viewerFollowEdges.map((e) => e.following.toString()));
    const pendingSet = new Set(pendingEdges.map((e) => e.following.toString()));

    const reverseEdges = await Follow.find({
      follower: { $in: pageUserIds },
      following: req.user._id,
      status: "accepted",
    }).select("follower").lean();
    const reverseSet = new Set(reverseEdges.map((e) => e.follower.toString()));

    const users = followingPage.items.map((user) => {
      const id = user._id.toString();
      return {
        _id: user._id,
        username: user.username,
        name: user.name || "",
        profilePic: user.profilePic,
        isVerified: Boolean(user.isVerified || (user.verificationBadge && user.verificationBadge !== "none")),
        isPrivate: Boolean(user.isPrivate),
        followerCount: user.counts?.followers ?? 0,
        relationship: {
          isFollowing: followingSet.has(id),
          isPending: pendingSet.has(id),
          canFollowBack: reverseSet.has(id),
        },
      };
    });

    return res.status(200).json({
      users,
      pageInfo: followingPage.pageInfo,
      totalCount: await Follow.countDocuments({ follower: profileUser._id, status: "accepted" }),
    });
  } catch (error) {
    console.error("getFollowingList error:", error);
    return res.status(500).json({ error: "Failed to get following users" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// User discovery
// ─────────────────────────────────────────────────────────────────────────────

export const getUsers = async (req, res) => {
  try {
    const { cursor, limit = 20, q = "", mode = "all" } = req.query;
    const limitNum = parseCursorLimit(limit, 20);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    // Viewer's follow state for suggestion scoring
    const viewerFollowing = await Follow.find({
      follower: req.user._id,
      status: "accepted",
    }).select("following").lean();
    const followingIds = viewerFollowing.map((e) => e.following);
    const followingSet = new Set(followingIds.map((id) => id.toString()));

    // Exclude accounts blocked in either direction from search/suggestions.
    const blockRels = await UserRelation.find({
      kind: "block",
      $or: [{ from: req.user._id }, { to: req.user._id }],
    })
      .select("from to")
      .lean();
    const blockedIds = blockRels.map((r) =>
      r.from.toString() === req.user._id.toString() ? r.to : r.from
    );

    const baseQuery = {
      ...cursorQuery,
      _id: { $nin: [req.user._id, ...blockedIds] },
      ...ACTIVE_ACCOUNT_FILTER,
    };

    const trimmed = q.trim();
    if (trimmed) {
      const safe = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      baseQuery.$or = [
        { username: new RegExp(safe, "i") },
        { name: new RegExp(safe, "i") },
      ];
    }

    if (mode === "suggestions") {
      baseQuery._id = { $nin: [req.user._id, ...followingIds, ...blockedIds] };
    }

    const users = await User.find(baseQuery)
      .select("username name profilePic isVerified verificationBadge isPrivate bio counts createdAt")
      .sort({ isVerified: -1, createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const { items: pageUsers, pageInfo } = buildCursorPageInfo(users, limitNum, "createdAt");

    const pageUserIds = pageUsers.map((u) => u._id);
    const [pendingEdges, mutualEdges] = await Promise.all([
      Follow.find({
        follower: req.user._id,
        following: { $in: pageUserIds },
        status: "pending",
      }).select("following").lean(),
      // mutual followers (they follow people the viewer also follows)
      Follow.find({
        follower: { $in: pageUserIds },
        following: { $in: followingIds },
        status: "accepted",
      }).select("follower following").lean(),
    ]);

    const pendingSet = new Set(pendingEdges.map((e) => e.following.toString()));

    // Count mutuals per candidate
    const mutualCountMap = new Map();
    mutualEdges.forEach(({ follower }) => {
      const key = follower.toString();
      mutualCountMap.set(key, (mutualCountMap.get(key) || 0) + 1);
    });

    const usersWithRelationship = pageUsers.map((user) => {
      const id = user._id.toString();
      return {
        _id: user._id,
        username: user.username,
        name: user.name || "",
        profilePic: user.profilePic,
        isVerified: Boolean(
          user.isVerified || (user.verificationBadge && user.verificationBadge !== "none")
        ),
        isPrivate: Boolean(user.isPrivate),
        bio: user.bio || "",
        followerCount: user.counts?.followers ?? 0,
        createdAt: user.createdAt,
        relationship: {
          isFollowing: followingSet.has(id),
          isPending: pendingSet.has(id),
          mutualCount: mutualCountMap.get(id) || 0,
        },
      };
    });

    if (mode === "suggestions") {
      usersWithRelationship.sort((a, b) => {
        const verifiedDiff = Number(b.isVerified) - Number(a.isVerified);
        if (verifiedDiff !== 0) return verifiedDiff;
        const mutualDiff = (b.relationship.mutualCount || 0) - (a.relationship.mutualCount || 0);
        if (mutualDiff !== 0) return mutualDiff;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
    }

    res.json({ users: usersWithRelationship, pageInfo });
  } catch (error) {
    console.error("getUsers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Follow / Unfollow
// ─────────────────────────────────────────────────────────────────────────────

export const followUser = async (req, res) => {
  try {
    const userToFollow = await User.findOne({ username: req.params.username }).select("_id username isPrivate");
    if (!userToFollow) return res.status(404).json({ message: "User not found" });

    if (userToFollow._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: "You cannot follow yourself" });
    }

    // Block gating — can't follow someone you blocked or who blocked you.
    if (await UserRelation.eitherBlocks(req.user._id, userToFollow._id)) {
      return res.status(403).json({ message: "Unable to follow this account" });
    }

    // Check for existing edge
    const existing = await Follow.findOne({
      follower: req.user._id,
      following: userToFollow._id,
    });

    if (existing?.status === "accepted") {
      return res.status(400).json({ message: "You already follow this user" });
    }
    if (existing?.status === "pending") {
      return res.status(400).json({ message: "Follow request already sent" });
    }

    if (userToFollow.isPrivate) {
      await Follow.create({
        follower: req.user._id,
        following: userToFollow._id,
        status: "pending",
      });

      const sockets = getUserSocket(req.user._id.toString());
      sockets?.forEach((id) =>
        io.to(id).emit("followStatusUpdate", {
          username: userToFollow.username,
          action: "follow",
          isPending: true,
          isPrivate: true,
        })
      );

      await invalidateFollowRelatedCaches(req.user.username, req.params.username);
      return res.status(200).json({ message: "Follow request sent successfully" });
    }

    // Public user — accept immediately
    await Follow.create({
      follower: req.user._id,
      following: userToFollow._id,
      status: "accepted",
    });

    await Promise.all([
      User.updateOne({ _id: req.user._id }, { $inc: { "counts.following": 1 } }),
      User.updateOne({ _id: userToFollow._id }, { $inc: { "counts.followers": 1 } }),
    ]);

    await sendNotification(userToFollow._id, req.user._id, "follow");

    const sockets = getUserSocket(req.user._id.toString());
    sockets?.forEach((id) =>
      io.to(id).emit("followStatusUpdate", {
        username: userToFollow.username,
        action: "follow",
        isPending: false,
        isPrivate: false,
      })
    );

    await invalidateFollowRelatedCaches(req.user.username, req.params.username);
    res.status(200).json({ message: "User followed successfully" });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Follow request already exists" });
    }
    console.error("followUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const unfollowUser = async (req, res) => {
  try {
    const userToUnfollow = await User.findOne({ username: req.params.username }).select("_id username");
    if (!userToUnfollow) return res.status(404).json({ message: "User not found" });

    if (userToUnfollow._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: "You cannot unfollow yourself" });
    }

    const edge = await Follow.findOneAndDelete({
      follower: req.user._id,
      following: userToUnfollow._id,
    });

    if (!edge) {
      return res.status(400).json({ message: "You are not following this user" });
    }

    if (edge.status === "accepted") {
      await Promise.all([
        User.updateOne({ _id: req.user._id }, { $inc: { "counts.following": -1 } }),
        User.updateOne({ _id: userToUnfollow._id }, { $inc: { "counts.followers": -1 } }),
      ]);
    }

    const sockets = getUserSocket(req.user._id.toString());
    sockets?.forEach((id) =>
      io.to(id).emit("followStatusUpdate", {
        username: userToUnfollow.username,
        action: edge.status === "pending" ? "cancel-request" : "unfollow",
      })
    );

    await invalidateFollowRelatedCaches(req.user.username, req.params.username);
    res.status(200).json({
      message: edge.status === "pending" ? "Follow request canceled" : "User unfollowed successfully",
    });
  } catch (error) {
    console.error("unfollowUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Follow requests (pending edges where following = current user)
// ─────────────────────────────────────────────────────────────────────────────

export const getFollowRequests = async (req, res) => {
  try {
    const requests = await Follow.find({
      following: req.user._id,
      status: "pending",
    })
      .populate("follower", "username name profilePic")
      .lean();

    res.status(200).json(requests.map((r) => ({ _id: r._id, from: r.follower })));
  } catch (error) {
    console.error("getFollowRequests error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const acceptFollowRequest = async (req, res) => {
  try {
    const edge = await Follow.findById(req.params.requestId);
    if (!edge) return res.status(404).json({ message: "Follow request not found" });

    if (edge.following.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized to accept this request" });
    }
    if (edge.status !== "pending") {
      return res.status(400).json({ message: `Request already ${edge.status}` });
    }

    edge.status = "accepted";
    await edge.save();

    await Promise.all([
      User.updateOne({ _id: req.user._id }, { $inc: { "counts.followers": 1 } }),
      User.updateOne({ _id: edge.follower }, { $inc: { "counts.following": 1 } }),
    ]);

    const requester = await User.findById(edge.follower).select("username").lean();
    await invalidateFollowRelatedCaches(req.user.username, requester?.username);
    res.status(200).json({ message: "Follow request accepted" });
  } catch (error) {
    console.error("acceptFollowRequest error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const rejectFollowRequest = async (req, res) => {
  try {
    const edge = await Follow.findById(req.params.requestId);
    if (!edge) return res.status(404).json({ message: "Follow request not found" });

    if (edge.following.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized to reject this request" });
    }
    if (edge.status !== "pending") {
      return res.status(400).json({ message: `Request already ${edge.status}` });
    }

    await Follow.deleteOne({ _id: edge._id });

    const requester = await User.findById(edge.follower).select("username").lean();
    await invalidateFollowRelatedCaches(req.user.username, requester?.username);
    res.status(200).json({ message: "Follow request rejected" });
  } catch (error) {
    console.error("rejectFollowRequest error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const cancelFollowRequest = async (req, res) => {
  try {
    const userToFollow = await User.findOne({ username: req.params.username }).select("_id username");
    if (!userToFollow) return res.status(404).json({ message: "User not found" });

    const deleted = await Follow.findOneAndDelete({
      follower: req.user._id,
      following: userToFollow._id,
      status: "pending",
    });

    if (!deleted) return res.status(404).json({ message: "No pending follow request found" });

    const sockets = getUserSocket(req.user._id.toString());
    sockets?.forEach((id) =>
      io.to(id).emit("followStatusUpdate", {
        username: userToFollow.username,
        action: "cancel-request",
        isPending: false,
      })
    );

    await invalidateFollowRelatedCaches(req.user.username, req.params.username);
    res.status(200).json({ message: "Follow request canceled" });
  } catch (error) {
    console.error("cancelFollowRequest error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const checkPendingRequestStatus = async (req, res) => {
  try {
    const userToCheck = await User.findOne({ username: req.params.username }).select("_id").lean();
    if (!userToCheck) return res.status(404).json({ message: "User not found" });

    const edge = await Follow.findOne({
      follower: req.user._id,
      following: userToCheck._id,
      status: "pending",
    }).lean();

    return res.status(200).json({ isPending: !!edge });
  } catch (error) {
    console.error("checkPendingRequestStatus error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const isFollowingMe = async (req, res) => {
  try {
    const targetUser = await User.findOne({ username: req.params.username }).select("_id").lean();
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    const edge = await Follow.findOne({
      follower: targetUser._id,
      following: req.user._id,
      status: "accepted",
    }).lean();

    res.status(200).json({ isFollowingMe: !!edge });
  } catch (error) {
    console.error("isFollowingMe error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Block / Restrict
// ─────────────────────────────────────────────────────────────────────────────

export const blockUser = async (req, res) => {
  try {
    const userToBlock = await User.findOne({ username: req.params.username }).select("_id");
    if (!userToBlock) return res.status(404).json({ message: "User not found" });

    const existing = await UserRelation.findOne({
      from: req.user._id,
      to: userToBlock._id,
      kind: "block",
    });
    if (existing) return res.status(400).json({ message: "User already blocked" });

    await UserRelation.create({ from: req.user._id, to: userToBlock._id, kind: "block" });

    // Remove any follow edges between the two users and adjust counts
    const [removedA, removedB] = await Promise.all([
      Follow.findOneAndDelete({ follower: req.user._id, following: userToBlock._id, status: "accepted" }),
      Follow.findOneAndDelete({ follower: userToBlock._id, following: req.user._id, status: "accepted" }),
      // Also clear pending requests in both directions
      Follow.deleteMany({
        $or: [
          { follower: req.user._id, following: userToBlock._id },
          { follower: userToBlock._id, following: req.user._id },
        ],
        status: "pending",
      }),
    ]);

    const countUpdates = [];
    if (removedA) {
      countUpdates.push(
        User.updateOne({ _id: req.user._id }, { $inc: { "counts.following": -1 } }),
        User.updateOne({ _id: userToBlock._id }, { $inc: { "counts.followers": -1 } })
      );
    }
    if (removedB) {
      countUpdates.push(
        User.updateOne({ _id: userToBlock._id }, { $inc: { "counts.following": -1 } }),
        User.updateOne({ _id: req.user._id }, { $inc: { "counts.followers": -1 } })
      );
    }
    await Promise.all(countUpdates);

    res.status(200).json({ message: "User blocked successfully" });
  } catch (error) {
    console.error("blockUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const unblockUser = async (req, res) => {
  try {
    const userToUnblock = await User.findOne({ username: req.params.username }).select("_id");
    if (!userToUnblock) return res.status(404).json({ message: "User not found" });

    await UserRelation.deleteOne({ from: req.user._id, to: userToUnblock._id, kind: "block" });
    res.status(200).json({ message: "User unblocked successfully" });
  } catch (error) {
    console.error("unblockUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const muteUser = async (req, res) => {
  try {
    const userToMute = await User.findOne({ username: req.params.username }).select("_id");
    if (!userToMute) return res.status(404).json({ message: "User not found" });
    if (userToMute._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: "You can't mute yourself" });
    }

    const existing = await UserRelation.findOne({
      from: req.user._id,
      to: userToMute._id,
      kind: "mute",
    });
    if (existing) return res.status(200).json({ message: "User already muted", muted: true });

    await UserRelation.create({ from: req.user._id, to: userToMute._id, kind: "mute" });
    res.status(200).json({ message: "User muted successfully", muted: true });
  } catch (error) {
    console.error("muteUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const unmuteUser = async (req, res) => {
  try {
    const userToUnmute = await User.findOne({ username: req.params.username }).select("_id");
    if (!userToUnmute) return res.status(404).json({ message: "User not found" });

    await UserRelation.deleteOne({ from: req.user._id, to: userToUnmute._id, kind: "mute" });
    res.status(200).json({ message: "User unmuted successfully", muted: false });
  } catch (error) {
    console.error("unmuteUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// List accounts the current user has blocked (Settings list + client block state)
export const getBlockedUsers = async (req, res) => {
  try {
    const rows = await UserRelation.find({ from: req.user._id, kind: "block" })
      .populate("to", "username name profilePic isVerified verificationBadge")
      .sort({ createdAt: -1 })
      .lean();
    const blocked = rows
      .filter((r) => r.to)
      .map((r) => ({
        _id: r.to._id,
        username: r.to.username,
        name: r.to.name || "",
        profilePic: r.to.profilePic || "",
        isVerified: Boolean(
          r.to.isVerified || (r.to.verificationBadge && r.to.verificationBadge !== "none")
        ),
      }));
    res.status(200).json({ blocked });
  } catch (error) {
    console.error("getBlockedUsers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// List usernames the current user has muted (hydrates the client-side mute state)
export const getMutedUsers = async (req, res) => {
  try {
    const rows = await UserRelation.find({ from: req.user._id, kind: "mute" })
      .populate("to", "username")
      .lean();
    const muted = rows.map((r) => r.to?.username).filter(Boolean);
    res.status(200).json({ muted });
  } catch (error) {
    console.error("getMutedUsers error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const restrictUser = async (req, res) => {
  try {
    const userToRestrict = await User.findOne({ username: req.params.username }).select("_id");
    if (!userToRestrict) return res.status(404).json({ message: "User not found" });

    const existing = await UserRelation.findOne({
      from: req.user._id,
      to: userToRestrict._id,
      kind: "restrict",
    });
    if (existing) return res.status(400).json({ message: "User already restricted" });

    await UserRelation.create({ from: req.user._id, to: userToRestrict._id, kind: "restrict" });
    res.status(200).json({ message: "User restricted successfully" });
  } catch (error) {
    console.error("restrictUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Replies & Reposts (user profile tabs)
// ─────────────────────────────────────────────────────────────────────────────

export const getReplies = async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    const user = await User.findOne({ username }).select("_id").lean();
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // A reply waiting for its scheduled time isn't in any thread yet, so it
    // mustn't show on the author's profile either.
    const replies = await Comment.find({
      author: user._id,
      isScheduled: { $ne: true },
      ...cursorQuery,
    })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("author", "username profilePic bio name isVerified isPrivate counts")
      .populate({
        path: "parent",
        select: "content media createdAt",
        populate: { path: "author", select: "username profilePic name bio isVerified isPrivate" },
      })
      .populate({
        path: "post",
        select: "content media createdAt",
        populate: { path: "author", select: "username profilePic name bio isVerified isPrivate" },
      })
      .lean();

    const { items: pagedReplies, pageInfo } = buildCursorPageInfo(replies, limitNum);

    return res.status(200).json({ success: true, replies: pagedReplies, pageInfo });
  } catch (error) {
    console.error("getReplies error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

export const getReposts = async (req, res) => {
  try {
    const { profileId: username } = req.params;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);

    const user = await User.findOne({ username }).select("_id").lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const cursorFilter = parsedCursor
      ? { createdAt: { $lt: new Date(parsedCursor.createdAt) } }
      : {};

    const repostEdges = await Repost.find({
      user: user._id,
      ...cursorFilter,
    })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const { items: pageEdges, pageInfo } = buildCursorPageInfo(repostEdges, limitNum, "createdAt");

    // Hydrate targets
    const postIds = pageEdges.filter((r) => r.targetType === "Post").map((r) => r.target);
    const commentIds = pageEdges.filter((r) => r.targetType === "Comment").map((r) => r.target);

    const [posts, comments] = await Promise.all([
      postIds.length
        ? Post.find({ _id: { $in: postIds }, isDeleted: { $ne: true }, isDraft: { $ne: true } })
            .populate("author", "username name bio profilePic isVerified isPrivate")
            .populate({
              path: "quotedPost",
              populate: { path: "author", select: "username name bio profilePic isVerified isPrivate" },
            })
            .lean()
        : [],
      commentIds.length
        ? Comment.find({
            _id: { $in: commentIds },
            isDeleted: { $ne: true },
            isScheduled: { $ne: true },
          })
            .populate("author", "username name bio profilePic isVerified isPrivate")
            .populate("post", "_id")
            .lean()
        : [],
    ]);

    const postMap = new Map(posts.map((p) => [p._id.toString(), p]));
    const commentMap = new Map(comments.map((c) => [c._id.toString(), c]));

    const reposts = pageEdges.map((edge) => ({
      type: edge.targetType === "Post" ? "post" : "comment",
      content:
        edge.targetType === "Post"
          ? postMap.get(edge.target.toString())
          : commentMap.get(edge.target.toString()),
      repostTimestamp: edge.createdAt,
    })).filter((r) => r.content);

    res.status(200).json({ reposts, pageInfo });
  } catch (error) {
    console.error("getReposts error:", error);
    res.status(500).json({ error: "Server error" });
  }
};
