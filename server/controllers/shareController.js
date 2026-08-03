import mongoose from "mongoose";
import { normalizeMedia } from "../utils/mediaTypes.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import { escapeRegex } from "../utils/respond.js";
import { getIO, getUserSocket } from "../config/socket.js";
import { loadVisibleContent } from "../utils/contentVisibility.js";
import { attachSharedContent, stripSharedSnapshot } from "../utils/resolveSharedContent.js";
import { seedConversationRead } from "../utils/readState.js";
import { recomputeGroupCounts } from "../utils/groupCounts.js";
import {
  ACTIVE_ACCOUNT,
  MAX_RECIPIENTS,
  blockedIdSet,
  cleanIds,
  messageableIdSet,
  resolveGroupSend,
} from "../utils/chatAccess.js";

const USER_CARD = "_id username name profilePic isVerified isPrivate";

// ─────────────────────────────────────────────────────────────────────────────
// Permission helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Accounts the caller has hidden from their message-suggestion lists. */
const hiddenSuggestionIds = async (userId) => {
  const rows = await UserRelation.find({ from: userId, kind: "hide_suggestion" })
    .select("to")
    .lean();
  return new Set(rows.map((r) => r.to.toString()));
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /chats/share-targets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * People to offer in the share sheet, ranked the way Instagram does it:
 * accounts you actually talk to first (by volume, then recency), then people
 * you follow, then suggestions. Blocked accounts in either direction are
 * dropped at every stage.
 */
export const getShareTargets = async (req, res) => {
  try {
    const userId = req.user._id;
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 50);

    // ── Searching: one flat, ranked list ────────────────────────────────────
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      const candidates = await User.find({
        _id: { $ne: userId },
        ...ACTIVE_ACCOUNT,
        $or: [{ username: rx }, { name: rx }],
      })
        .select(USER_CARD)
        .limit(limit * 2)
        .lean();

      const [blocked, hidden] = await Promise.all([
        blockedIdSet(userId, candidates.map((c) => c._id)),
        hiddenSuggestionIds(userId),
      ]);

      return res.status(200).json({
        targets: candidates
          .filter((c) => !blocked.has(c._id.toString()) && !hidden.has(c._id.toString()))
          .slice(0, limit)
          .map((user) => ({ user, reason: "search" })),
        groups: await searchableGroups(userId, rx),
      });
    }

    // ── Default: most-interacted → following → suggested ────────────────────
    const conversationKeys = await Message.aggregate([
      {
        $match: {
          isGroupMessage: { $ne: true },
          isDeleted: { $ne: true },
          // Bounded window: without it this scans the whole message history
          // every time the share sheet opens.
          createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
          $or: [{ sender: userId }, { receiver: userId }],
        },
      },
      {
        $group: {
          _id: { $cond: [{ $eq: ["$sender", userId] }, "$receiver", "$sender"] },
          messages: { $sum: 1 },
          lastAt: { $max: "$createdAt" },
        },
      },
      { $sort: { messages: -1, lastAt: -1 } },
      { $limit: limit },
    ]);

    const interactedIds = conversationKeys.map((c) => c._id).filter(Boolean);

    const followingRows = await Follow.find({ follower: userId, status: "accepted" })
      .select("following")
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .lean();
    const followingIds = followingRows.map((f) => f.following);

    // Suggestions only need to fill whatever's left.
    const seen = new Set([...interactedIds, ...followingIds].map((id) => id.toString()));
    let suggestedIds = [];
    if (seen.size < limit) {
      const suggestions = await User.find({
        _id: { $ne: userId, $nin: [...seen] },
        ...ACTIVE_ACCOUNT,
      })
        .select("_id")
        .sort({ isVerified: -1, "counts.followers": -1 })
        .limit(limit - seen.size)
        .lean();
      suggestedIds = suggestions.map((s) => s._id);
    }

    const allIds = [...interactedIds, ...followingIds, ...suggestedIds];
    const [blocked, hidden] = await Promise.all([
      blockedIdSet(userId, allIds),
      hiddenSuggestionIds(userId),
    ]);

    const users = await User.find({
      _id: { $in: allIds },
      ...ACTIVE_ACCOUNT,
    })
      .select(USER_CARD)
      .lean();
    const byId = new Map(users.map((u) => [u._id.toString(), u]));

    const reasonFor = new Map();
    interactedIds.forEach((id) => reasonFor.set(id.toString(), "frequent"));
    followingIds.forEach((id) => {
      if (!reasonFor.has(id.toString())) reasonFor.set(id.toString(), "following");
    });
    suggestedIds.forEach((id) => {
      if (!reasonFor.has(id.toString())) reasonFor.set(id.toString(), "suggested");
    });

    // Order is the concatenation order, deduplicated — ranking is already baked in.
    const targets = [];
    const emitted = new Set();
    for (const id of allIds) {
      const key = id.toString();
      if (emitted.has(key) || blocked.has(key) || hidden.has(key) || !byId.has(key)) continue;
      emitted.add(key);
      targets.push({ user: byId.get(key), reason: reasonFor.get(key) });
      if (targets.length >= limit) break;
    }

    return res.status(200).json({
      targets,
      groups: await searchableGroups(userId, null),
    });
  } catch (error) {
    console.error("getShareTargets error:", error);
    return res.status(500).json({ error: "Failed to load share targets" });
  }
};

/** Groups the caller can post into, optionally filtered by name. */
const searchableGroups = async (userId, nameRegex) => {
  const memberships = await GroupMember.find({ user: userId, isBanned: { $ne: true } })
    .select("group")
    .lean();
  if (!memberships.length) return [];

  const query = {
    _id: { $in: memberships.map((m) => m.group) },
    isActive: { $ne: false },
    isDeleted: { $ne: true },
  };
  if (nameRegex) query.name = nameRegex;

  return Group.find(query).select("_id name avatar counts.members").limit(20).lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /chats/share
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads the post/comment being shared and freezes a fallback snapshot.
 *
 * Gated on the sharer's own visibility — without that check this endpoint
 * would happily read any private post by id and write its full text into a
 * message document, which is a read-anything primitive.
 */
const loadShareTarget = async (viewerId, targetType, targetId) => {
  if (!["post", "comment", "profile"].includes(targetType)) {
    return { error: "Unknown content type" };
  }
  if (!mongoose.isValidObjectId(targetId)) return { error: "Invalid content id" };

  if (targetType === "profile") return loadProfileShareTarget(viewerId, targetId);

  const { doc, error } = await loadVisibleContent(viewerId, targetType, targetId);
  if (error) return { error };

  return {
    doc,
    sharedContent: {
      kind: targetType,
      post: targetType === "post" ? doc._id : undefined,
      comment: targetType === "comment" ? doc._id : undefined,
      snapshot: {
        authorId: doc.author?._id || null,
        authorUsername: doc.author?.username || "",
        authorName: doc.author?.name || "",
        authorPic: doc.author?.profilePic || "",
        content: doc.content || "",
        // The snapshot stays plain URLs — it's a frozen thumbnail strip for a
        // chat bubble, not a player. Typed items are normalised down to their
        // URLs so a share made today still renders if the original is later
        // deleted and only this copy remains.
        media: normalizeMedia(doc.media)
          .slice(0, 4)
          .map((m) => m.url),
        createdAt: doc.createdAt,
      },
    },
  };
};

/**
 * Same, for an account being shared.
 *
 * A profile header is public even for a private account — only its posts are
 * gated — so there is no "private" case to handle here. A block is the one thing
 * that makes an account unreachable, and it's checked in both directions:
 * sharing must not become a way to hand someone a card for an account that has
 * blocked them, or that they've blocked.
 *
 * Nothing about the account is frozen beyond who it is. The card is rendered
 * from the live account on every read, so a bio edited after sending shows the
 * new text and a deleted account stops resolving.
 */
const PROFILE_UNAVAILABLE = "That account is no longer available";

const loadProfileShareTarget = async (viewerId, targetId) => {
  const user = await User.findOne({ _id: targetId, ...ACTIVE_ACCOUNT })
    .select("_id username name profilePic")
    .lean();
  if (!user) return { error: PROFILE_UNAVAILABLE };

  if (user._id.toString() !== viewerId.toString()) {
    const blocked = await blockedIdSet(viewerId, [user._id]);
    if (blocked.has(user._id.toString())) return { error: PROFILE_UNAVAILABLE };
  }

  return {
    doc: user,
    sharedContent: {
      kind: "profile",
      profile: user._id,
      snapshot: {
        authorId: user._id,
        authorUsername: user.username,
        authorName: user.name || "",
        authorPic: user.profilePic || "",
      },
    },
  };
};

export const shareContent = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      targetType,
      targetId,
      recipientIds = [],
      groupIds = [],
      newGroupMemberIds = [],
      groupName,
      note,
    } = req.body;

    const target = await loadShareTarget(userId, targetType, targetId);
    if (target.error) return res.status(404).json({ error: target.error });

    const recipients = cleanIds(recipientIds, { exclude: userId });
    const groups = cleanIds(groupIds);
    const newGroupMembers = cleanIds(newGroupMemberIds, { exclude: userId });

    if (!recipients.length && !groups.length && !newGroupMembers.length) {
      return res.status(400).json({ error: "Pick someone to send this to" });
    }
    // A "group" of one isn't a group. Without this the request would succeed
    // having done nothing at all, and the client would show no feedback.
    if (newGroupMembers.length === 1 && !recipients.length && !groups.length) {
      return res.status(400).json({ error: "Pick at least two people for a group" });
    }
    if (recipients.length + groups.length + newGroupMembers.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `You can share with up to ${MAX_RECIPIENTS} at once` });
    }

    const text = typeof note === "string" ? note.trim().slice(0, 1000) : "";
    const io = getIO();
    const results = { sent: [], failed: [] };

    // ── Optional: spin up a group from the selected people ──────────────────
    let createdGroup = null;
    if (newGroupMembers.length >= 2) {
      const members = await User.find({
        _id: { $in: newGroupMembers },
        ...ACTIVE_ACCOUNT,
      })
        .select("username name")
        .lean();

      const blocked = await blockedIdSet(userId, members.map((m) => m._id));
      // A group must not become a way around whoCanMessage: someone who won't
      // accept your DM shouldn't be pulled into a thread with you either.
      const messageable = await messageableIdSet(userId, members.map((m) => m._id));
      const usable = members.filter(
        (m) => !blocked.has(m._id.toString()) && messageable.has(m._id.toString())
      );

      if (usable.length < 2) {
        return res.status(400).json({ error: "Not enough people available for a group" });
      }

      // Group.name is required, so build one the way Instagram labels a new
      // thread. The group can be renamed afterwards.
      const names = usable.map((m) => m.name?.split(" ")[0] || m.username);
      const label =
        names.length <= 3
          ? names.join(", ")
          : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;

      // A name typed in the sheet wins; otherwise fall back to member names.
      const chosenName =
        typeof groupName === "string" && groupName.trim()
          ? groupName.trim().slice(0, 100)
          : `${req.user.name?.split(" ")[0] || req.user.username}, ${label}`.slice(0, 100);

      const group = await Group.create({
        name: chosenName,
        type: "private",
        createdBy: userId,
      });

      await seedConversationRead(
        [userId, ...usable.map((m) => m._id)],
        Message.groupConversationKey(group._id)
      );
      await GroupMember.insertMany([
        { group: group._id, user: userId, role: "super_admin", addedBy: userId },
        ...usable.map((m) => ({
          group: group._id,
          user: m._id,
          role: "member",
          addedBy: userId,
        })),
      ]);
      /*
       * Derived, and `counts.admins` along with it.
       *
       * This path `$set` members from an array length and never touched
       * `counts.admins` at all — so a group created by sharing a post reported
       * zero admins forever, while the same group created from the Groups tab
       * reported one. See utils/groupCounts.js.
       */
      await recomputeGroupCounts(group._id);

      createdGroup = { _id: group._id, name: group.name, avatar: group.avatar };
      groups.push(group._id.toString());

      // Pull everyone online into the room, the sender included — otherwise
      // io.to(group) skips them and their own share never appears.
      for (const m of [...usable, { _id: userId }]) {
        const sockets = getUserSocket(m._id.toString());
        if (sockets) {
          for (const socketId of sockets) {
            io.sockets.sockets.get(socketId)?.join(group._id.toString());
            if (!m._id.equals?.(userId)) {
              io.to(socketId).emit("addedToGroup", { group: createdGroup, addedBy: userId });
            }
          }
        }
      }
    }

    // ── Direct messages ─────────────────────────────────────────────────────
    if (recipients.length) {
      const objectIds = recipients.map((id) => new mongoose.Types.ObjectId(id));

      const [existing, blocked, messageable] = await Promise.all([
        User.find({ _id: { $in: objectIds }, ...ACTIVE_ACCOUNT })
          .select("_id username name profilePic isVerified")
          .lean(),
        blockedIdSet(userId, objectIds),
        messageableIdSet(userId, objectIds),
      ]);
      const byId = new Map(existing.map((u) => [u._id.toString(), u]));

      for (const id of recipients) {
        const user = byId.get(id);
        if (!user) {
          results.failed.push({ id, reason: "Account unavailable" });
          continue;
        }
        if (blocked.has(id)) {
          results.failed.push({ id, username: user.username, reason: "Can't message this account" });
          continue;
        }
        if (!messageable.has(id)) {
          results.failed.push({
            id,
            username: user.username,
            reason: "They don't accept messages from you",
          });
          continue;
        }

        const message = await Message.create({
          sender: userId,
          receiver: user._id,
          conversation: Message.dmConversationKey(userId, user._id),
          content: text,
          messageType: "post_share",
          sharedContent: target.sharedContent,
          status: "sent",
        });

        const populated = await Message.findById(message._id)
          .populate("sender", "username name profilePic isVerified")
          .populate("receiver", "username name profilePic isVerified")
          .lean();

        // Resolved for *this* recipient before it leaves the server, so a
        // private post they can't see arrives locked rather than in the clear.
        const forRecipient = JSON.parse(JSON.stringify(populated));
        await attachSharedContent([forRecipient], user._id);

        const sockets = getUserSocket(user._id.toString());
        if (sockets) {
          for (const socketId of sockets) {
            io.to(socketId).emit("receiveMessage", { ...forRecipient, isOwn: false });
            // Deep copy: a shallow spread shares the same `sharedContent`
            // object, so stripping it here would also strip `resolved` off the
            // message emitted above — the card would arrive with no media.
            io.to(socketId).emit("chatUpdated", {
              user: { _id: userId, username: req.user.username },
              latestMessage: stripSharedSnapshot(JSON.parse(JSON.stringify(forRecipient))),
              unreadCount: 1,
            });
          }
        }

        // Echo to the sender's own sockets — otherwise sharing into a thread
        // you already have open shows nothing until you reload.
        const senderSockets = getUserSocket(userId.toString());
        if (senderSockets) {
          const forSender = JSON.parse(JSON.stringify(populated));
          await attachSharedContent([forSender], userId);
          for (const socketId of senderSockets) {
            io.to(socketId).emit("receiveMessage", { ...forSender, isOwn: true });
          }
        }

        results.sent.push({ id, username: user.username });
      }
    }

    // ── Groups ──────────────────────────────────────────────────────────────
    for (const groupId of groups) {
      // The same gate the socket send path uses — membership, group liveness,
      // role permissions, mute and slow mode. This used to check the first
      // three only, so sharing was a way around a mute.
      const access = await resolveGroupSend(groupId, userId);
      if (!access.ok) {
        results.failed.push({ id: groupId, reason: access.reason });
        continue;
      }

      const message = await Message.create({
        sender: userId,
        group: groupId,
        isGroupMessage: true,
        conversation: Message.groupConversationKey(groupId),
        content: text,
        messageType: "post_share",
        sharedContent: target.sharedContent,
        status: "sent",
      });

      const populated = await Message.findById(message._id)
        .populate("sender", "username name profilePic isVerified")
        .lean();

      // One emit reaches every member, so it can't be resolved per reader.
      // Strip it to a marker; each client gets the real card, evaluated
      // against them, on its next thread fetch.
      io.to(groupId.toString()).emit("receiveGroupMessage", stripSharedSnapshot(populated));

      results.sent.push({ id: groupId, isGroup: true });
    }

    return res.status(200).json({
      message: results.sent.length
        ? `Sent to ${results.sent.length}`
        : "Couldn't send to anyone",
      ...results,
      createdGroup,
    });
  } catch (error) {
    console.error("shareContent error:", error);
    return res.status(500).json({ error: "Failed to share" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /chats/share-targets/hide
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Don't suggest this person again." Recorded as a UserRelation so it survives
 * across devices, and deliberately separate from mute/block — it only removes
 * them from suggestion lists, nothing else changes.
 */
export const hideShareSuggestion = async (req, res) => {
  try {
    const { userId: targetId } = req.body;
    if (!mongoose.isValidObjectId(targetId)) {
      return res.status(400).json({ error: "Invalid account" });
    }
    if (targetId.toString() === req.user._id.toString()) {
      return res.status(400).json({ error: "Invalid account" });
    }

    const target = await User.findById(targetId).select("username").lean();
    if (!target) return res.status(404).json({ error: "Account not found" });

    await UserRelation.updateOne(
      { from: req.user._id, to: targetId, kind: "hide_suggestion" },
      { $setOnInsert: { from: req.user._id, to: targetId, kind: "hide_suggestion" } },
      { upsert: true }
    );

    return res.status(200).json({ message: `@${target.username} hidden from suggestions` });
  } catch (error) {
    console.error("hideShareSuggestion error:", error);
    return res.status(500).json({ error: "Failed to hide suggestion" });
  }
};
