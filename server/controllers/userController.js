import { uploadToCloudinary } from "../config/cloudinary.js";
import { sendNotification } from "../utils/notifications.js";
import { getOrSet, del, CacheKeys } from "../utils/cache.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import Notification from "../models/Notification.js";
import Repost from "../models/Repost.js";
import User from "../models/User.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import UserSettings from "../models/UserSettings.js";
import { io } from "../server.js";
import {
  buildCursorPageInfo,
  buildCursorQuery,
  decodeCursor,
  parseCursorLimit,
} from "../utils/cursorPagination.js";
import { followListPage, normalizeFollowListSort } from "../utils/followList.js";
import { decorateContent } from "../utils/attachments.js";
import { indexContent, notifyMentions } from "../utils/contentIndex.js";
import {
  CHANGE_WINDOW_MS,
  HOLD_MS,
  changeQuota,
  checkUsernameAvailability,
  normalizeUsername,
} from "../utils/username.js";
import { invalidatePrivacy } from "../utils/chatAccess.js";
import {
  clearPushTokenForRequest,
  registerPushTokenForRequest,
} from "../utils/pushNotifications.js";

const ACTIVE_ACCOUNT_FILTER = {
  accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] },
};

/**
 * Drops the "requested to follow you" row once the request is no longer
 * pending — accepted, rejected, or withdrawn. Without this the recipient's
 * Activity keeps offering a decision that has already been made.
 */
const clearFollowRequestNotification = (recipientId, senderId) =>
  Notification.deleteMany({
    recipient: recipientId,
    sender: senderId,
    type: "follow_request",
  }).catch((error) => console.error("clearFollowRequestNotification error:", error));

import { followUser as followUserService } from "../services/engagement.js";

const invalidateFollowRelatedCaches = async (...usernames) => {
  const unique = [...new Set(usernames.filter(Boolean))];
  await Promise.all(
    unique.flatMap((username) => [
      del(CacheKeys.profile(username)),
    ])
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The display name, as opposed to the handle.
 *
 * Free to change, unlike the username: it isn't in any URL or mention, so
 * changing it breaks no links. It is still an impersonation surface — building
 * a following then renaming yourself to a brand is the standard play, which is
 * why Instagram caps name changes too — so if that shows up, the quota logic in
 * utils/username.js already exists to be reused here.
 *
 * Any script, any emoji, any of the decorative Unicode alphabets. The only
 * things removed are C0/C1 control characters, which are unprintable, can't be
 * typed on purpose, and would break a single-line layout if they were newlines.
 *
 * @returns {string} the value to store
 */
const normalizeDisplayName = (name) =>
  String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    // Runs of whitespace collapse to one: pasted names routinely carry doubles
    // and they render as a gap nobody meant.
    .replace(/\s+/g, " ")
    .trim();

/**
 * Length as a person would count it.
 *
 * `String.length` counts UTF-16 code units, so "🎉" is 2 and a letter from one
 * of the decorative alphabets is also 2 — meaning a 25-emoji name would be
 * rejected as "over 50 characters". Intl.Segmenter counts what you'd count
 * pointing at the screen, including a flag or a family emoji built from several
 * code points.
 */
const NAME_MAX_GRAPHEMES = 50;

const graphemeCount = (value) => {
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0;
    for (const _ of segmenter.segment(value)) count += 1;
    return count;
  } catch {
    // No Segmenter: [...value] at least counts code points rather than code
    // units, which is wrong only for multi-codepoint emoji.
    return [...value].length;
  }
};

/** @returns {string|null} an error message, or null when acceptable */
const validateDisplayName = (value) => {
  // Empty is allowed: the profile then falls back to showing the handle, which
  // is how accounts that never set a name already render.
  if (!value) return null;
  if (graphemeCount(value) > NAME_MAX_GRAPHEMES)
    return `Name must be ${NAME_MAX_GRAPHEMES} characters or fewer`;
  return null;
};

export const setupProfile = async (req, res) => {
  try {
    const { name, bio, link, isPrivate } = req.body;

    if (bio && bio.length > 150) {
      return res.status(403).json({ error: "Bio should be less than 150 characters" });
    }
    if (link) {
      try { new URL(link); } catch {
        return res.status(400).json({ error: "Invalid URL format" });
      }
    }
    // Normalise first, then check the length — otherwise trailing whitespace
    // counts towards the limit.
    const cleanName = name === undefined ? undefined : normalizeDisplayName(name);
    if (cleanName !== undefined) {
      const nameError = validateDisplayName(cleanName);
      if (nameError) return res.status(400).json({ error: nameError });
    }

    const updateObj = {};
    if (cleanName !== undefined) updateObj.name = cleanName;

    /*
     * A bio can @mention people, and the same permission rules apply as
     * anywhere else. Resolved here so the profile renderer has the allowed set
     * without re-deriving it per view. Hashtags in a bio aren't indexed — a bio
     * isn't content, and letting it feed the tag pages is a spam vector.
     */
    let bioMentions = null;
    if (bio !== undefined) {
      updateObj.bio = bio;
      bioMentions = await indexContent(bio, req.user._id);
      updateObj.bioMentions = bioMentions.mentionIds;
    }
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

          // Every request just became a follow, so none of them is still a
          // decision waiting on this account.
          await Notification.deleteMany({
            recipient: req.user,
            sender: { $in: followerIds },
            type: "follow_request",
          });

          // Notify each requester that their request was auto-accepted
          followerIds.forEach((followerId) => {
            /*
             * The follower's room, not this process's socket list.
             *
             * `getUserSocket` is a Map in one instance, so with more than one this update
             * reached the user only when they happened to be served by the node handling
             * the request. Every socket joins a room named after its user id on connect.
             */
            io.to(followerId.toString()).emit("followStatusUpdate", {
              username: user.username,
              action: "follow",
              isPending: false,
              isPrivate: false,
              autoAccepted: true,
            });
          });
        }
      }
    }

    // Read before the write, so "who is newly mentioned" is answerable.
    const existingBioMentions =
      bio === undefined
        ? null
        : (await User.findById(req.user).select("bioMentions").lean())?.bioMentions;

    const updatedUser = await User.findByIdAndUpdate(req.user, updateObj, {
      runValidators: true,
      new: true,
    });

    /*
     * Both keys. The post list caches page 1 with the author document
     * populated, and AUTHOR_SELECT includes `name`, so a rename that only
     * cleared the profile key left your own posts listed under the old name.
     */
    /*
     * Only the newly added ones. Editing a typo elsewhere in the bio must not
     * re-notify everyone it names, which is otherwise a way to ping someone
     * as often as you like.
     */
    if (bioMentions) {
      const before = new Set((existingBioMentions || []).map(String));
      await notifyMentions({
        mentions: bioMentions.mentions.filter((m) => !before.has(String(m._id))),
        authorId: req.user._id,
        entity: null,
        entityType: undefined,
      });
    }

    await del(CacheKeys.profile(updatedUser.username));
    await del(CacheKeys.userPosts(updatedUser.username));

    return res.status(200).json({
      message: "Profile updated successfully",
      // Echo what was actually stored rather than letting the client assume its
      // own input took — the name here is trimmed and whitespace-collapsed.
      name: updatedUser.name,
      bio: updatedUser.bio,
      link: updatedUser.link,
      isPrivate: updatedUser.isPrivate,
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
        .select(
          "username name profilePic bio bioMentions link isVerified verificationBadge isPrivate counts createdAt"
        )
        .populate("bioMentions", "username")
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
        /*
         * The handles in the bio whose owners permitted the mention. The
         * renderer links these and leaves any other @word as plain text.
         */
        bioMentionUsernames: (profile.bioMentions || []).map((u) => u.username).filter(Boolean),
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

    // Block and restrict relationships (viewer-specific, not cached)
    const [youBlockedRel, blockedYouRel, youRestrictedRel] = await Promise.all([
      UserRelation.findOne({ from: req.user._id, to: profileData._id, kind: "block" }).lean(),
      UserRelation.findOne({ from: profileData._id, to: req.user._id, kind: "block" }).lean(),
      UserRelation.findOne({ from: req.user._id, to: profileData._id, kind: "restrict" }).lean(),
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
        youRestricted: Boolean(youRestrictedRel),
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

/**
 * Who may see whose lists. A private account's followers and following are
 * part of the private profile — only the owner and accepted followers get
 * them. The old handlers never checked, so any logged-in stranger could read
 * a private account's entire social graph; the frontend merely hid the
 * button.
 *
 * Returns { profileUser } or { status, error }.
 */
const authorizeListView = async (username, viewerId) => {
  const profileUser = await User.findOne({ username, ...ACTIVE_ACCOUNT_FILTER })
    .select("_id isPrivate")
    .lean();
  if (!profileUser) return { status: 404, error: "User not found" };

  const isOwner = profileUser._id.toString() === viewerId.toString();
  if (isOwner) return { profileUser };

  // Same answer as a missing account — a block shouldn't confirm anything.
  if (await UserRelation.eitherBlocks(viewerId, profileUser._id)) {
    return { status: 404, error: "User not found" };
  }

  if (profileUser.isPrivate) {
    const follows = await Follow.exists({
      follower: viewerId,
      following: profileUser._id,
      status: "accepted",
    });
    if (!follows) return { status: 403, error: "This account is private" };
  }

  return { profileUser };
};

/** The viewer's relationship to each row, batched — three queries per page. */
const attachRelationships = async (viewerId, items) => {
  const ids = items.map((u) => u._id);
  const [followingEdges, pendingEdges, reverseEdges] = await Promise.all([
    Follow.find({ follower: viewerId, following: { $in: ids }, status: "accepted" })
      .select("following")
      .lean(),
    Follow.find({ follower: viewerId, following: { $in: ids }, status: "pending" })
      .select("following")
      .lean(),
    Follow.find({ follower: { $in: ids }, following: viewerId, status: "accepted" })
      .select("follower")
      .lean(),
  ]);

  const followingSet = new Set(followingEdges.map((e) => e.following.toString()));
  const pendingSet = new Set(pendingEdges.map((e) => e.following.toString()));
  const reverseSet = new Set(reverseEdges.map((e) => e.follower.toString()));

  return items.map((user) => {
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
      followerCount: user.counts?.followers ?? 0,
      followedAt: user._edgeCreatedAt || null,
      relationship: {
        isFollowing: followingSet.has(id),
        isPending: pendingSet.has(id),
        // They follow the viewer — drives both "Follow back" and the
        // "Follows you" badge.
        canFollowBack: reverseSet.has(id),
      },
    };
  });
};

/**
 * The two list endpoints differ only in which side of the edge is fixed, so
 * they share one body. Querystring: q (search), sort (default | latest |
 * earliest), cursor, limit.
 *
 * No response cache here any more: the default ranking and the relationship
 * flags are per-viewer, and the old shared 60-second cache was one refactor
 * away from serving viewer A's data to viewer B.
 */
const listHandler = (direction) => async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, q = "", limit = 20 } = req.query;
    const limitNum = parseCursorLimit(limit, 20);
    const sort = normalizeFollowListSort(req.query.sort);

    const { profileUser, status, error } = await authorizeListView(username, req.user._id);
    if (error) return res.status(status).json({ error });

    const page = await followListPage(direction, profileUser._id, req.user._id, {
      q: typeof q === "string" ? q : "",
      sort,
      cursor,
      limit: limitNum,
    });

    const edgeFilter =
      direction === "followers"
        ? { following: profileUser._id, status: "accepted" }
        : { follower: profileUser._id, status: "accepted" };

    return res.status(200).json({
      users: await attachRelationships(req.user._id, page.items),
      pageInfo: page.pageInfo,
      sort,
      // First page only — it's a whole-collection count, and recomputing it
      // for every scroll increment buys nothing.
      totalCount: cursor ? null : await Follow.countDocuments(edgeFilter),
    });
  } catch (error) {
    console.error(`${direction} list error:`, error);
    return res.status(500).json({ error: "Failed to load the list" });
  }
};

export const getFollowersList = listHandler("followers");
export const getFollowingList = listHandler("following");

/**
 * The profile owner removing one of their followers — the quiet alternative
 * to blocking. The edge is deleted, both counters step down, and the removed
 * account is told nothing; they'd have to look at the profile to notice, which
 * is exactly how Instagram plays it.
 */
export const removeFollower = async (req, res) => {
  try {
    const { username } = req.params;

    const target = await User.findOne({ username }).select("_id").lean();
    if (!target) return res.status(404).json({ error: "User not found" });

    // findOneAndDelete rather than check-then-delete: two concurrent removals
    // must decrement the counters exactly once.
    const edge = await Follow.findOneAndDelete({
      follower: target._id,
      following: req.user._id,
      status: "accepted",
    });
    if (!edge) return res.status(404).json({ error: "They don't follow you" });

    await Promise.all([
      User.updateOne({ _id: req.user._id }, { $inc: { "counts.followers": -1 } }),
      User.updateOne({ _id: target._id }, { $inc: { "counts.following": -1 } }),
    ]);

    // Same invalidation as follow/unfollow: the cached profile holds both
    // counts and the follower preview strip.
    await invalidateFollowRelatedCaches(req.user.username, username);

    return res.status(200).json({ removed: true, username });
  } catch (error) {
    console.error("removeFollower error:", error);
    return res.status(500).json({ error: "Failed to remove follower" });
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

/**
 * HTTP adapter over services/engagement.js.
 *
 * The logic moved so a bot agent can follow someone without a request object. This resolves
 * the username the route is keyed on, then delegates; the statuses and messages are the
 * originals, so no client sees a change.
 */
export const followUser = async (req, res) => {
  try {
    const userToFollow = await User.findOne({ username: req.params.username })
      .select("_id")
      .lean();
    if (!userToFollow) return res.status(404).json({ message: "User not found" });

    const result = await followUserService({
      actorId: req.user._id,
      targetId: userToFollow._id,
    });

    if (!result.ok) {
      return res.status(result.status).json({ message: result.error });
    }

    res.status(200).json({
      message: result.pending
        ? "Follow request sent successfully"
        : "User followed successfully",
    });
  } catch (error) {
    /*
     * The duplicate-key branch stays here rather than moving into the service.
     *
     * It catches the race where two requests both pass the "already follows" check before
     * either writes, and the unique index on `{follower, following}` refuses the second. The
     * service lets that throw — it is a genuine fault from its point of view — and each
     * caller decides how to phrase it. For HTTP that is a 400.
     */
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

    // This user's own room, so every tab they have open is told — on any instance.
    // `getUserSocket` only ever listed the sockets attached to this one.
    io.to(req.user._id.toString()).emit("followStatusUpdate", {
      username: userToUnfollow.username,
      action: edge.status === "pending" ? "cancel-request" : "unfollow",
    });

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
      // The request is answered; leaving "requested to follow you" in the
      // recipient's Activity implies it still needs a decision.
      clearFollowRequestNotification(req.user._id, edge.follower),
    ]);

    await sendNotification(edge.follower, req.user._id, "follow_request_accepted");

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
    // Silently — a rejection is not something the requester is told about.
    await clearFollowRequestNotification(req.user._id, edge.follower);

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

    // Withdrawn — the recipient shouldn't still be asked to decide.
    await clearFollowRequestNotification(userToFollow._id, req.user._id);

    // This user's own room, so every tab they have open is told — on any instance.
    // `getUserSocket` only ever listed the sockets attached to this one.
    io.to(req.user._id.toString()).emit("followStatusUpdate", {
      username: userToFollow.username,
      action: "cancel-request",
      isPending: false,
    });

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
    const userToBlock = await User.findOne({ username: req.params.username })
      .select("_id username");
    if (!userToBlock) return res.status(404).json({ message: "User not found" });

    /*
     * You cannot block yourself. `muteUser` below has always guarded this and this
     * did not, so the endpoint happily wrote a self edge — which then landed in the
     * client's blocked set and hid your own posts and profile from you.
     */
    if (userToBlock._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ error: "You can't block yourself" });
    }

    const existing = await UserRelation.findOne({
      from: req.user._id,
      to: userToBlock._id,
      kind: "block",
    });
    /*
     * Idempotent, like `muteUser`. This answered 400 "User already blocked", and the
     * client treats a rejected block as a failed one — so it rolled back its
     * optimistic update and the button went straight back to saying "Block". Any UI
     * holding slightly stale state was therefore permanently stuck: every click
     * failed, and every failure restored the state that caused the next click.
     *
     * Already blocked is the state the caller asked for, so it is a success.
     */
    if (existing) {
      return res.status(200).json({ message: "User already blocked", blocked: true });
    }

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

    /*
     * The cached profiles, because this just changed them.
     *
     * `getUserProfile` caches its payload for 60s under `CacheKeys.profile(username)`,
     * and the counter `$inc`s above are exactly the numbers in it. Every follow path
     * calls this helper for the same reason; block mutated the same fields and never
     * did, so follower/following counts stayed wrong on both profiles for up to a
     * minute after a block. `relationship.youBlocked` is per-viewer and not part of
     * the cached payload, but the counts are.
     */
    await invalidateFollowRelatedCaches(req.user.username, userToBlock.username);

    // `blocked: true` so the client can reconcile from the response instead of
    // guessing that no error meant success.
    res.status(200).json({ message: "User blocked successfully", blocked: true });
  } catch (error) {
    console.error("blockUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const unblockUser = async (req, res) => {
  try {
    const userToUnblock = await User.findOne({ username: req.params.username })
      .select("_id username");
    if (!userToUnblock) return res.status(404).json({ message: "User not found" });

    await UserRelation.deleteOne({ from: req.user._id, to: userToUnblock._id, kind: "block" });
    // Blocking removed follow edges and adjusted counts; unblocking doesn't restore
    // them, but the cached profiles are dropped anyway so the viewer's relationship
    // block is rebuilt rather than served from before the change.
    await invalidateFollowRelatedCaches(req.user.username, userToUnblock.username);
    res.status(200).json({ message: "User unblocked successfully", blocked: false });
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

export const unrestrictUser = async (req, res) => {
  try {
    const userToUnrestrict = await User.findOne({ username: req.params.username }).select("_id");
    if (!userToUnrestrict) return res.status(404).json({ message: "User not found" });

    await UserRelation.deleteOne({ from: req.user._id, to: userToUnrestrict._id, kind: "restrict" });
    res.status(200).json({ message: "User unrestricted successfully" });
  } catch (error) {
    console.error("unrestrictUser error:", error);
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

    const { items: pagedRepliesRaw, pageInfo } = buildCursorPageInfo(replies, limitNum);
    // Typed media + per-viewer poll projection; the populated parent post
    // rides along, so it needs the same treatment.
    const pagedReplies = await decorateContent(pagedRepliesRaw, req.user?._id);
    await Promise.all(pagedReplies.map((r) => decorateContent(r.post, req.user?._id)));

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

    // Same projection every other read path applies — a repost of a poll
    // must not ship raw counts to someone who hasn't voted.
    const decoratedPosts = await decorateContent(posts, req.user?._id);
    const decoratedComments = await decorateContent(comments, req.user?._id);
    const postMap = new Map(decoratedPosts.map((p) => [p._id.toString(), p]));
    const commentMap = new Map(decoratedComments.map((c) => [c._id.toString(), c]));

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

// ─────────────────────────────────────────────────────────────────────────────
// About this profile / username
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /user/:username/about — the "About this profile" panel.
 *
 * The signals here exist to help someone judge whether an account is who it
 * claims to be, which is why they're shown for your own profile too: what
 * other people can learn about you shouldn't be a secret from you.
 *
 * Deliberately *not* cached. It's opened rarely, and a stale username-change
 * count on the one screen meant for spotting a freshly renamed impersonator
 * would defeat the point.
 *
 * Earlier usernames are never sent — only how many there have been and when
 * the last one was. Publishing the old handles would let anyone trace an
 * account back through a name someone changed to get away from.
 */
export const getProfileAbout = async (req, res) => {
  try {
    const { username } = req.params;

    // No account-status filter, deliberately: getUserProfile has none either,
    // and a panel that 404s on a profile the page just rendered is worse than
    // showing the join date of a suspended account.
    const profile = await User.findOne({ username })
      .select(
        "username name profilePic isVerified verificationBadge verifiedAt country createdAt usernameChangedAt +usernameHistory"
      )
      .lean();

    if (!profile) return res.status(404).json({ error: "User not found" });

    // Same rule as the profile itself: to someone they've blocked, the account
    // doesn't exist.
    const blockedYou = await UserRelation.findOne({
      from: profile._id,
      to: req.user._id,
      kind: "block",
    }).lean();
    if (blockedYou) return res.status(404).json({ error: "User not found" });

    const history = profile.usernameHistory || [];

    return res.status(200).json({
      username: profile.username,
      name: profile.name || "",
      profilePic: profile.profilePic,
      isVerified: Boolean(
        profile.isVerified || (profile.verificationBadge && profile.verificationBadge !== "none")
      ),
      verificationBadge: profile.verificationBadge || "none",
      // Null for accounts verified before we started recording it; the client
      // then shows the badge without a date rather than a made-up one.
      verifiedAt: profile.verifiedAt || null,
      dateJoined: profile.createdAt,
      // ISO alpha-2, or "" when nothing resolved; the client turns it into a
      // country name. `countrySource` is deliberately not sent — how we worked
      // it out is internal, and the panel explains accuracy in its own words.
      country: profile.country || "",
      usernameChanges: {
        count: history.length,
        lastChangedAt: profile.usernameChangedAt || null,
      },
    });
  } catch (error) {
    console.error("getProfileAbout error:", error);
    return res.status(500).json({ error: "Failed to load profile details" });
  }
};

/*
 * "reserved" and "held" are useful internally and dangerous on the wire: both
 * tell someone probing the namespace that a handle is worth waiting for. They
 * collapse to the same answer a taken name gives.
 */
const PUBLIC_REASON = { reserved: "unavailable", held: "unavailable" };
const publicReason = (reason) => PUBLIC_REASON[reason] || reason;

/**
 * GET /user/username-availability?username=… — what the edit form calls while
 * you type.
 *
 * Advisory only. Every answer it gives can be stale by the time you submit, so
 * changeUsername re-runs the identical checks and the unique index has the
 * final word.
 */
export const getUsernameAvailability = async (req, res) => {
  try {
    const candidate = normalizeUsername(req.query.username);
    const { available, reason, message } = await checkUsernameAvailability(
      candidate,
      req.user._id
    );
    return res
      .status(200)
      .json({ username: candidate, available, reason: publicReason(reason), message });
  } catch (error) {
    console.error("getUsernameAvailability error:", error);
    return res.status(500).json({ error: "Failed to check username" });
  }
};

/**
 * GET /user/username-status — the state the edit form needs before you type:
 * current handle, changes left, and when the next one unlocks.
 */
export const getUsernameStatus = async (req, res) => {
  try {
    const me = await User.findById(req.user._id)
      .select("username usernameChangedAt +usernameHistory")
      .lean();
    if (!me) return res.status(404).json({ error: "User not found" });

    const history = me.usernameHistory || [];
    const quota = changeQuota(history);

    return res.status(200).json({
      username: me.username,
      changeCount: history.length,
      lastChangedAt: me.usernameChangedAt || null,
      ...quota,
      windowDays: Math.round(CHANGE_WINDOW_MS / 86400000),
    });
  } catch (error) {
    console.error("getUsernameStatus error:", error);
    return res.status(500).json({ error: "Failed to load username status" });
  }
};

/**
 * PATCH /user/username — change your handle.
 *
 * The whole operation is one conditional update. Reading the quota and then
 * writing in a second step would let two requests fired together both see one
 * change remaining and both spend it; instead the filter carries the quota
 * check, so the second request matches nothing and is rejected.
 */
export const changeUsername = async (req, res) => {
  try {
    const candidate = normalizeUsername(req.body?.username);

    const me = await User.findById(req.user._id)
      .select("username usernameChangedAt +usernameHistory")
      .lean();
    if (!me) return res.status(404).json({ error: "User not found" });

    if (candidate === me.username) {
      return res.status(400).json({ error: "This is already your username" });
    }

    const availability = await checkUsernameAvailability(candidate, req.user._id);
    if (!availability.available) {
      // "invalid" is the user mistyping; the rest are conflicts.
      const status = availability.reason === "invalid" ? 400 : 409;
      return res
        .status(status)
        .json({ error: availability.message, reason: publicReason(availability.reason) });
    }

    const quota = changeQuota(me.usernameHistory || []);
    if (quota.remaining <= 0) {
      return res.status(429).json({
        error: `You can change your username ${quota.limit} times every ${Math.round(
          CHANGE_WINDOW_MS / 86400000
        )} days`,
        reason: "rate_limited",
        nextAllowedAt: quota.nextAllowedAt,
      });
    }

    const now = new Date();
    const previous = me.username;

    let updated;
    try {
      updated = await User.findOneAndUpdate(
        {
          _id: req.user._id,
          /*
           * The concurrency guard, and it only needs to be this. Two requests
           * fired together would otherwise both see one change remaining and
           * both spend it. Whichever lands first moves the username off
           * `previous`, so the second matches no document and is rejected —
           * which also covers a rename from another device mid-request.
           */
          username: previous,
        },
        {
          $set: { username: candidate, usernameChangedAt: now },
          $push: { usernameHistory: { username: previous, changedAt: now } },
        },
        { new: true, runValidators: true }
      )
        .select("username usernameChangedAt +usernameHistory")
        .lean();
    } catch (error) {
      // The unique index is the real arbiter: someone can register the name in
      // the moment between the availability check and this write.
      if (error?.code === 11000) {
        return res.status(409).json({ error: "This username is taken", reason: "taken" });
      }
      throw error;
    }

    if (!updated) {
      return res
        .status(409)
        .json({ error: "Your username changed elsewhere. Try again.", reason: "conflict" });
    }

    // Both keys, or the old handle keeps serving a profile that has moved and
    // the new one serves nothing.
    await invalidateFollowRelatedCaches(previous, candidate);
    await del(CacheKeys.userPosts(previous));
    await del(CacheKeys.userPosts(candidate));

    const nextQuota = changeQuota(updated.usernameHistory || []);

    return res.status(200).json({
      message: "Username updated",
      username: updated.username,
      previousUsername: previous,
      changeCount: (updated.usernameHistory || []).length,
      lastChangedAt: updated.usernameChangedAt,
      ...nextQuota,
      // So the client can say how long the old handle is theirs to reclaim.
      heldUntil: new Date(now.getTime() + HOLD_MS),
    });
  } catch (error) {
    console.error("changeUsername error:", error);
    return res.status(500).json({ error: "Failed to change username" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Privacy settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The subset of UserSettings.privacy this app currently exposes.
 *
 * An allow-list rather than a pass-through: `privacy` holds two dozen fields,
 * most of them for features that don't exist yet, and a PATCH that accepts
 * whatever it's given would let a crafted request write all of them.
 */
const EDITABLE_PRIVACY = {
  whoCanMention: ["everyone", "following", "none"],
};

/** GET /user/privacy-settings */
export const getPrivacySettings = async (req, res) => {
  try {
    const settings = await UserSettings.findOne({ user: req.user._id })
      .select("privacy")
      .lean();

    const privacy = settings?.privacy || {};
    return res.status(200).json({
      // Defaults, not undefined: an account created before a setting existed
      // has no value for it, and the client shouldn't have to know that.
      whoCanMention: privacy.whoCanMention || "everyone",
    });
  } catch (error) {
    console.error("getPrivacySettings error:", error);
    return res.status(500).json({ error: "Failed to load settings" });
  }
};

/** PATCH /user/privacy-settings */
export const updatePrivacySettings = async (req, res) => {
  try {
    const updates = {};
    for (const [key, allowed] of Object.entries(EDITABLE_PRIVACY)) {
      if (!(key in req.body)) continue;
      const value = req.body[key];
      if (!allowed.includes(value)) {
        return res.status(400).json({ error: `Invalid value for ${key}` });
      }
      updates[`privacy.${key}`] = value;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No valid settings to update" });
    }

    // Upsert: the settings row is created at signup, but an account that
    // predates that shouldn't be unable to change its own settings.
    const settings = await UserSettings.findOneAndUpdate(
      { user: req.user._id },
      { $set: updates, $setOnInsert: { user: req.user._id } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    )
      .select("privacy")
      .lean();

    /*
     * The chat layer caches this block — it's read once per typing burst, per read
     * notification and per contact in a presence fan-out — so a save has to say so.
     * Without this, turning off "show my online status" would keep leaking it for
     * up to the cache's TTL, which is the one thing a privacy toggle must not do.
     */
    invalidatePrivacy(req.user._id);

    return res.status(200).json({
      message: "Settings saved",
      whoCanMention: settings?.privacy?.whoCanMention || "everyone",
    });
  } catch (error) {
    console.error("updatePrivacySettings error:", error);
    return res.status(500).json({ error: "Failed to save settings" });
  }
};

/**
 * PUT /user/push-token — register this device for push notifications.
 *
 * The delivery path has been complete since 8b and had nowhere to deliver *to*:
 * `UserSession.push.token` is what it reads, `registerPushToken` is what writes it,
 * and there was no route, so the function had no callers (CF30b). This is that route.
 *
 * The session is resolved from the `X-Device-Id` header rather than from the body —
 * see registerPushTokenForRequest for why a client-supplied session id would be a way
 * to receive someone else's notifications.
 */
export const setPushToken = async (req, res) => {
  try {
    const { token, platform = "web" } = req.body || {};
    const result = await registerPushTokenForRequest(req, token, platform);

    if (!result.ok) {
      /*
       * A missing session is not the client's fault and not worth an error state.
       *
       * It happens for a token issued before the device-id header existed, and for a
       * session that has since been revoked. Either way the correct response is
       * "noted, not registered" — the client has nothing useful to do about it, and a
       * 4xx would show the user a failure for a feature they never asked about.
       */
      if (result.reason === "session") {
        return res.status(200).json({ registered: false, reason: "no-session" });
      }
      return res.status(400).json({ error: "Invalid push token" });
    }

    return res.status(200).json({ registered: true });
  } catch (error) {
    console.error("setPushToken error:", error);
    return res.status(500).json({ error: "Failed to register for notifications" });
  }
};

/** DELETE /user/push-token — stop delivering to this device. */
export const deletePushToken = async (req, res) => {
  try {
    await clearPushTokenForRequest(req);
    return res.status(200).json({ registered: false });
  } catch (error) {
    console.error("deletePushToken error:", error);
    return res.status(500).json({ error: "Failed to unregister" });
  }
};
