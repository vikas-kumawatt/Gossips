import Message from "../models/Message.js";
import User from "../models/User.js";
import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";
import UserSettings from "../models/UserSettings.js";
import UserRelation from "../models/UserRelation.js";
import MessageReaction from "../models/MessageReaction.js";
import MessageReceipt from "../models/MessageReceipt.js";
import Follow from "../models/Follow.js";
import { uploadToCloudinary } from "../config/cloudinary.js";
import { getIO } from "../config/socket.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import {
  buildCursorPageInfo,
  buildCursorQuery,
  decodeCursor,
  parseCursorLimit,
} from "../utils/cursorPagination.js";
import { escapeRegex } from "../utils/respond.js";
import {
  attachSharedContent,
  stripSharedSnapshot,
  stripSharedSnapshots,
} from "../utils/resolveSharedContent.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns Group ObjectIds the user belongs to (not banned). */
async function getUserGroupIds(userId) {
  const memberships = await GroupMember.find({
    user: userId,
    isBanned: false,
  }).select("group").lean();
  return memberships.map((m) => m.group);
}

/** deletedFor in new schema is plain ObjectId[]. */
const notDeletedForUser = (userId) => ({
  deletedFor: { $not: { $elemMatch: { $eq: userId } } },
});

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

export const getMessages = async (req, res) => {
  try {
    const userId = req.user._id;
    const senderId = userId.toString();

    const receiver = await User.findOne({ username: req.params.username }).select("_id username name profilePic isVerified");
    if (!receiver) return res.status(404).json({ error: "User not found" });

    // Block state — history stays readable (Instagram-style), but sending is
    // disabled (enforced in the socket layer) and the UI reflects the direction.
    const [youBlockedRel, blockedYouRel] = await Promise.all([
      UserRelation.findOne({ from: userId, to: receiver._id, kind: "block" }).lean(),
      UserRelation.findOne({ from: receiver._id, to: userId, kind: "block" }).lean(),
    ]);
    const blockState = {
      youBlocked: Boolean(youBlockedRel),
      blockedByThem: Boolean(blockedYouRel),
    };

    const { limit = 50, cursor, after, messageType } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);

    const conversationKey = Message.dmConversationKey(userId, receiver._id);

    const query = {
      conversation: conversationKey,
      isDeleted: false,
      ...notDeletedForUser(userId),
    };

    if (parsedCursor) Object.assign(query, buildCursorQuery(parsedCursor));
    if (after) query.createdAt = { ...query.createdAt, $gt: new Date(after) };
    if (messageType) query.messageType = messageType;

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic isVerified")
      .populate("receiver", "username name profilePic isVerified")
      .populate("replyTo", "content sender")
      .populate("mentions", "username name profilePic")
      .lean();

    const { items: pagedDesc, pageInfo } = buildCursorPageInfo(messages, limitNum);
    const chronologicalMessages = [...pagedDesc].reverse();

    // Mark unread messages as delivered
    const unreadIds = chronologicalMessages
      .filter((msg) => msg.receiver?._id?.toString() === senderId && msg.status === "sent")
      .map((msg) => msg._id);

    if (unreadIds.length) {
      await Message.updateMany({ _id: { $in: unreadIds } }, { $set: { status: "delivered" } });
      const receiptDocs = unreadIds.map((msgId) =>
        MessageReceipt.updateOne(
          { message: msgId, user: userId, kind: "delivered" },
          { $setOnInsert: { message: msgId, user: userId, kind: "delivered", conversation: conversationKey } },
          { upsert: true }
        )
      );
      await Promise.all(receiptDocs);
    }

    await User.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } });

    // Shared posts resolve against the reader, so a private account or a new
    // block locks the card even on messages sent long ago.
    await attachSharedContent(chronologicalMessages, userId);

    res.status(200).json({ messages: chronologicalMessages, pageInfo, hasMore: pageInfo.hasNextPage, blockState });
  } catch (error) {
    console.error("getMessages error:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
};

export const getGroupMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { groupId } = req.params;
    const { limit = 50, cursor, after } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);

    const group = await Group.findById(groupId).select("name avatar counts").lean();
    if (!group) return res.status(404).json({ error: "Group not found" });

    const membership = await GroupMember.findOne({ group: groupId, user: userId, isBanned: false }).lean();
    if (!membership) return res.status(403).json({ error: "Not a member of this group" });

    const conversationKey = Message.groupConversationKey(groupId);

    const query = {
      conversation: conversationKey,
      isDeleted: false,
      ...notDeletedForUser(userId),
    };

    if (parsedCursor) Object.assign(query, buildCursorQuery(parsedCursor));
    if (after) query.createdAt = { $gt: new Date(after) };

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic isVerified")
      .populate("replyTo", "content sender")
      .populate("mentions", "username name profilePic")
      .lean();

    const { items: pagedDesc, pageInfo } = buildCursorPageInfo(messages, limitNum);
    const chronologicalMessages = [...pagedDesc].reverse();

    await attachSharedContent(chronologicalMessages, userId);

    res.status(200).json({
      messages: chronologicalMessages,
      pageInfo,
      hasMore: pageInfo.hasNextPage,
      groupInfo: { name: group.name, avatar: group.avatar, memberCount: group.counts?.members ?? 0 },
    });
  } catch (error) {
    console.error("getGroupMessages error:", error);
    res.status(500).json({ error: "Failed to fetch group messages" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Chat list
// ─────────────────────────────────────────────────────────────────────────────

export const getChats = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const userId = req.user._id;
    const { search, unreadOnly, archived, view = "all", categoryId } = req.query;

    // Load user's chat settings from UserSettings
    const settings = await UserSettings.findOne({ user: userId }).select("chat").lean();
    const chatPref = settings?.chat || {};

    const archivedSet   = new Set(chatPref.archivedChats?.map((c) => c.chatId) || []);
    const favoriteSet   = new Set(chatPref.favoriteChats || []);
    const pinnedSet     = new Set(chatPref.pinnedChats || []);
    const mutedSet      = new Set(chatPref.mutedChats || []);
    const hiddenSet     = new Set(chatPref.hiddenChats || []);
    const lockedSet     = new Set(chatPref.lockedChats || []);
    const manualUnreadSet = new Set(chatPref.manualUnreadChats || []);
    const forcedReadSet = new Set(chatPref.forcedReadChats || []);
    const assignmentMap = new Map(
      (chatPref.categoryAssignments || []).map((a) => [a.chatId, a.categoryId])
    );

    // Following/followers for relationship metadata
    const [followEdges, reverseEdges, blockedRelations, blockedByRelations] = await Promise.all([
      Follow.find({ follower: userId, status: "accepted" }).select("following").lean(),
      Follow.find({ following: userId, status: "accepted" }).select("follower").lean(),
      UserRelation.find({ from: userId, kind: "block" }).select("to").lean(),
      UserRelation.find({ to: userId, kind: "block" }).select("from").lean(),
    ]);
    const followingSet = new Set(followEdges.map((e) => e.following.toString()));
    const followersSet = new Set(reverseEdges.map((e) => e.follower.toString()));
    const blockedSet   = new Set(blockedRelations.map((r) => r.to.toString()));
    // Accounts that blocked the viewer — their identity is anonymized in the list.
    const blockedBySet = new Set(blockedByRelations.map((r) => r.from.toString()));

    // Default placeholder shown for an account that blocked you ("Gossips User").
    const anonymizePeer = (peer) =>
      peer && {
        _id: peer._id,
        username: peer.username, // kept for navigation; opening it shows "User not found"
        name: "Gossips User",
        profilePic: "",
        isVerified: false,
        blockedByThem: true,
      };

    const userGroupIds = await getUserGroupIds(userId);

    const query = {
      $or: [
        { sender: userId, isGroupMessage: false },
        { receiver: userId, isGroupMessage: false },
        { isGroupMessage: true, group: { $in: userGroupIds } },
      ],
      isDeleted: false,
      ...notDeletedForUser(userId),
    };

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .populate("sender", "username name profilePic isVerified")
      .populate("receiver", "username name profilePic isVerified")
      .populate("group", "name avatar")
      .lean();

    const chats = new Map();
    messages.forEach((message) => {
      let chatId, otherUser, isGroup = false;

      if (message.isGroupMessage && message.group) {
        chatId = `group_${message.group._id}`;
        isGroup = true;
      } else if (message.sender && (message.receiver || !message.isGroupMessage)) {
        const otherUserId =
          message.sender._id.toString() === userId.toString()
            ? message.receiver?._id?.toString()
            : message.sender._id.toString();
        if (!otherUserId) return;
        chatId = `user_${otherUserId}`;
        otherUser =
          message.sender._id.toString() === userId.toString()
            ? message.receiver
            : message.sender;
      } else {
        return;
      }

      if (!chats.has(chatId)) {
        const otherIdStr = otherUser?._id?.toString();
        const blockedByThem = !isGroup && blockedBySet.has(otherIdStr);
        chats.set(chatId, {
          id: chatId,
          isGroup,
          // Chat previews aren't resolved per reader, so a shared post is
          // reduced to a marker here rather than shipping its snapshot.
          latestMessage: stripSharedSnapshot(message),
          unreadCount: 0,
          lastMessageTime: message.createdAt,
          ...(isGroup
            ? { group: message.group }
            : {
                user: blockedByThem ? anonymizePeer(otherUser) : otherUser,
                relationship: {
                  isFollowing: followingSet.has(otherIdStr),
                  isFollower: followersSet.has(otherIdStr),
                },
                isBlocked: blockedSet.has(otherIdStr),
                blockedByThem,
              }),
          isArchived: archivedSet.has(chatId),
          isFavorite: favoriteSet.has(chatId),
          isPinned: pinnedSet.has(chatId),
          isMuted: mutedSet.has(chatId),
          isHidden: hiddenSet.has(chatId),
          isLocked: lockedSet.has(chatId),
          categoryId: assignmentMap.get(chatId) || null,
        });
      }

      const isUnread =
        (message.receiver?._id?.toString() === userId.toString() ||
          (isGroup && message.sender?._id?.toString() !== userId.toString())) &&
        (message.status === "sent" || message.status === "delivered");

      if (isUnread) chats.get(chatId).unreadCount++;
    });

    let chatArray = Array.from(chats.values()).map((chat) => {
      let unreadCount = chat.unreadCount || 0;
      if (manualUnreadSet.has(chat.id)) unreadCount = Math.max(1, unreadCount);
      if (forcedReadSet.has(chat.id)) unreadCount = 0;
      return { ...chat, unreadCount };
    });

    if (search) {
      const q = search.toLowerCase();
      chatArray = chatArray.filter((chat) =>
        chat.isGroup
          ? chat.group?.name?.toLowerCase().includes(q)
          : chat.user?.username?.toLowerCase().includes(q) || chat.user?.name?.toLowerCase().includes(q)
      );
    }

    if (unreadOnly === "true") chatArray = chatArray.filter((c) => c.unreadCount > 0);
    if (archived === "true") chatArray = chatArray.filter((c) => c.isArchived);
    else if (archived === "false") chatArray = chatArray.filter((c) => !c.isArchived);

    if (view === "requests") chatArray = chatArray.filter((c) => !c.isGroup && !followingSet.has(c.user?._id?.toString()));
    else if (view === "groups") chatArray = chatArray.filter((c) => c.isGroup);
    else if (view === "unread") chatArray = chatArray.filter((c) => c.unreadCount > 0);
    else if (view === "favorites") chatArray = chatArray.filter((c) => favoriteSet.has(c.id));
    else if (view === "category" && categoryId) chatArray = chatArray.filter((c) => assignmentMap.get(c.id) === categoryId);

    chatArray.sort((a, b) => {
      const pinDiff = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
      if (pinDiff !== 0) return pinDiff;
      return new Date(b.lastMessageTime) - new Date(a.lastMessageTime);
    });

    res.status(200).json({
      chats: chatArray,
      totalUnread: chatArray.reduce((sum, c) => sum + c.unreadCount, 0),
    });
  } catch (error) {
    console.error("getChats error:", error);
    res.status(500).json({ error: "Failed to fetch chats" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Chat preferences (now in UserSettings)
// ─────────────────────────────────────────────────────────────────────────────

const normalizeCategories = (categories = []) =>
  categories
    .filter((c) => c?.id && c?.name?.trim())
    .map((c, i) => ({ id: c.id, name: c.name.trim(), order: Number.isFinite(c.order) ? c.order : i }))
    .sort((a, b) => a.order - b.order);

const buildChatPreferencesResponse = (chat = {}) => ({
  categories: normalizeCategories(chat.customCategories || []),
  categoryAssignments: (chat.categoryAssignments || []).reduce((acc, a) => {
    if (a?.chatId && a?.categoryId) acc[a.chatId] = a.categoryId;
    return acc;
  }, {}),
  favoriteChats:      chat.favoriteChats      || [],
  pinnedChats:        chat.pinnedChats         || [],
  mutedChats:         chat.mutedChats          || [],
  hiddenChats:        chat.hiddenChats         || [],
  lockedChats:        chat.lockedChats         || [],
  manualUnreadChats:  chat.manualUnreadChats   || [],
  forcedReadChats:    chat.forcedReadChats     || [],
  theme:              chat.theme               || "system",
  disappearingByChat: chat.disappearingByChat  || [],
});

/** Upsert UserSettings for user; returns the settings doc. */
const getOrCreateSettings = async (userId) => {
  let settings = await UserSettings.findOne({ user: userId });
  if (!settings) settings = await UserSettings.create({ user: userId });
  return settings;
};

export const getChatPreferences = async (req, res) => {
  try {
    const settings = await UserSettings.findOne({ user: req.user.id }).select("chat").lean();
    res.status(200).json(buildChatPreferencesResponse(settings?.chat));
  } catch (error) {
    console.error("getChatPreferences error:", error);
    res.status(500).json({ error: "Failed to fetch chat preferences" });
  }
};

const CHAT_THEMES = ["system", "light", "dark"];

export const updateChatTheme = async (req, res) => {
  try {
    const { theme } = req.body;
    if (!CHAT_THEMES.includes(theme)) return res.status(400).json({ error: "theme must be system, light, or dark" });
    const settings = await getOrCreateSettings(req.user.id);
    settings.chat.theme = theme;
    await settings.save();
    res.status(200).json({ theme: settings.chat.theme });
  } catch (error) {
    console.error("updateChatTheme error:", error);
    res.status(500).json({ error: "Failed to update theme" });
  }
};

export const setDisappearingForChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    if (!chatId) return res.status(400).json({ error: "chatId is required" });

    let seconds = req.body?.seconds;
    if (seconds === "" || seconds === undefined) seconds = null;
    else if (seconds !== null) {
      seconds = Number(seconds);
      if (!Number.isFinite(seconds) || seconds < 0) return res.status(400).json({ error: "seconds must be non-negative or null" });
      if (seconds === 0) seconds = null;
    }

    const settings = await getOrCreateSettings(req.user.id);
    const list = [...(settings.chat.disappearingByChat || [])];
    const idx = list.findIndex((x) => x.chatId === chatId);

    if (seconds === null) { if (idx !== -1) list.splice(idx, 1); }
    else if (idx !== -1) list[idx] = { chatId, seconds };
    else list.push({ chatId, seconds });

    settings.chat.disappearingByChat = list;
    await settings.save();

    res.status(200).json({ chatId, seconds, disappearingByChat: list });
  } catch (error) {
    console.error("setDisappearingForChat error:", error);
    res.status(500).json({ error: "Failed to update disappearing messages" });
  }
};

export const createChatCategory = async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Category name is required" });

    const settings = await getOrCreateSettings(req.user.id);
    const categories = normalizeCategories(settings.chat?.customCategories || []);

    if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: "Category already exists" });
    }

    categories.push({ id: uuidv4(), name, order: categories.length });
    settings.chat.customCategories = categories;
    await settings.save();

    res.status(201).json({ categories: normalizeCategories(settings.chat.customCategories) });
  } catch (error) {
    console.error("createChatCategory error:", error);
    res.status(500).json({ error: "Failed to create chat category" });
  }
};

export const reorderChatCategories = async (req, res) => {
  try {
    const orderedIds = Array.isArray(req.body?.orderedCategoryIds) ? req.body.orderedCategoryIds : [];
    if (!orderedIds.length) return res.status(400).json({ error: "orderedCategoryIds is required" });

    const settings = await getOrCreateSettings(req.user.id);
    const existing = normalizeCategories(settings.chat?.customCategories || []);
    const byId = new Map(existing.map((c) => [c.id, c]));
    const reordered = orderedIds.map((id, i) => {
      const c = byId.get(id);
      return c ? { ...c, order: i } : null;
    }).filter(Boolean);

    if (reordered.length !== existing.length) return res.status(400).json({ error: "Invalid category order payload" });

    settings.chat.customCategories = reordered;
    await settings.save();

    res.status(200).json({ categories: normalizeCategories(settings.chat.customCategories) });
  } catch (error) {
    console.error("reorderChatCategories error:", error);
    res.status(500).json({ error: "Failed to reorder chat categories" });
  }
};

export const deleteChatCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const settings = await getOrCreateSettings(req.user.id);

    settings.chat.customCategories = normalizeCategories(settings.chat?.customCategories || [])
      .filter((c) => c.id !== categoryId)
      .map((c, i) => ({ ...c, order: i }));

    settings.chat.categoryAssignments = (settings.chat?.categoryAssignments || []).filter(
      (a) => a.categoryId !== categoryId
    );

    await settings.save();
    res.status(200).json(buildChatPreferencesResponse(settings.chat));
  } catch (error) {
    console.error("deleteChatCategory error:", error);
    res.status(500).json({ error: "Failed to delete chat category" });
  }
};

export const assignChatCategory = async (req, res) => {
  try {
    const { chatId } = req.params;
    const categoryId = req.body?.categoryId || null;

    const settings = await getOrCreateSettings(req.user.id);
    const validIds = new Set(normalizeCategories(settings.chat?.customCategories || []).map((c) => c.id));
    if (categoryId && !validIds.has(categoryId)) return res.status(400).json({ error: "Invalid categoryId" });

    const assignments = (settings.chat?.categoryAssignments || []).filter((a) => a.chatId !== chatId);
    if (categoryId) assignments.push({ chatId, categoryId });
    settings.chat.categoryAssignments = assignments;
    await settings.save();

    res.status(200).json({ chatId, categoryId, categoryAssignments: buildChatPreferencesResponse(settings.chat).categoryAssignments });
  } catch (error) {
    console.error("assignChatCategory error:", error);
    res.status(500).json({ error: "Failed to assign chat category" });
  }
};

export const toggleFavoriteChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const settings = await getOrCreateSettings(req.user.id);

    const favorites = new Set(settings.chat?.favoriteChats || []);
    let isFavorite = false;
    if (favorites.has(chatId)) favorites.delete(chatId);
    else { favorites.add(chatId); isFavorite = true; }

    settings.chat.favoriteChats = Array.from(favorites);
    await settings.save();

    res.status(200).json({ chatId, isFavorite, favoriteChats: settings.chat.favoriteChats });
  } catch (error) {
    console.error("toggleFavoriteChat error:", error);
    res.status(500).json({ error: "Failed to toggle favorite chat" });
  }
};

const CHAT_STATE_FIELDS = {
  favorite: "favoriteChats",
  pin:      "pinnedChats",
  mute:     "mutedChats",
  hide:     "hiddenChats",
  lock:     "lockedChats",
  unread:   "manualUnreadChats",
  read:     "forcedReadChats",
};

export const updateChatState = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { stateKey, nextState, pin = "" } = req.body;

    if (!chatId || !stateKey || !CHAT_STATE_FIELDS[stateKey]) {
      return res.status(400).json({ error: "Invalid chatId/stateKey" });
    }

    const settings = await getOrCreateSettings(req.user.id);

    if (stateKey === "lock") {
      if (!settings.chat.chatLockPinHash) return res.status(400).json({ error: "Lock PIN not set" });
      const valid = await bcrypt.compare(String(pin), settings.chat.chatLockPinHash);
      if (!valid) return res.status(403).json({ error: "Invalid PIN" });
    }

    const field = CHAT_STATE_FIELDS[stateKey];
    const set = new Set(settings.chat[field] || []);
    const shouldEnable = typeof nextState === "boolean" ? nextState : !set.has(chatId);
    if (shouldEnable) set.add(chatId); else set.delete(chatId);
    settings.chat[field] = Array.from(set);

    if (stateKey === "read" && shouldEnable) {
      settings.chat.manualUnreadChats = (settings.chat.manualUnreadChats || []).filter((id) => id !== chatId);
    }
    if (stateKey === "unread" && shouldEnable) {
      settings.chat.forcedReadChats = (settings.chat.forcedReadChats || []).filter((id) => id !== chatId);
    }

    await settings.save();
    res.status(200).json({ chatId, stateKey, enabled: shouldEnable, ...buildChatPreferencesResponse(settings.chat) });
  } catch (error) {
    console.error("updateChatState error:", error);
    res.status(500).json({ error: "Failed to update chat state" });
  }
};

export const setChatLockPin = async (req, res) => {
  try {
    const pin = String(req.body?.pin || "");
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4-8 digits" });
    const settings = await getOrCreateSettings(req.user.id);
    settings.chat.chatLockPinHash = await bcrypt.hash(pin, 10);
    await settings.save();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("setChatLockPin error:", error);
    res.status(500).json({ error: "Failed to set PIN" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────────────

export const getUserGroups = async (req, res) => {
  try {
    const memberships = await GroupMember.find({ user: req.user.id, isBanned: false })
      .populate({
        path: "group",
        select: "name avatar counts description createdAt isActive isDeleted",
        match: { isActive: true, isDeleted: false },
      })
      .sort({ joinedAt: -1 })
      .lean();

    const groups = memberships.map((m) => m.group).filter(Boolean);
    res.status(200).json({ groups });
  } catch (error) {
    console.error("getUserGroups error:", error);
    res.status(500).json({ error: "Failed to fetch user groups" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Archive / Delete chat
// ─────────────────────────────────────────────────────────────────────────────

export const archiveChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { archive = true } = req.body;

    const settings = await getOrCreateSettings(req.user.id);
    const list = settings.chat.archivedChats || [];

    if (archive) {
      if (!list.some((c) => c.chatId === chatId)) {
        list.push({ chatId, archivedAt: new Date() });
      }
    } else {
      settings.chat.archivedChats = list.filter((c) => c.chatId !== chatId);
    }

    if (archive) settings.chat.archivedChats = list;
    await settings.save();

    res.status(200).json({ message: archive ? "Chat archived" : "Chat unarchived", archived: archive });
  } catch (error) {
    console.error("archiveChat error:", error);
    res.status(500).json({ error: "Failed to archive chat" });
  }
};

export const deleteChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const receiver = await User.findOne({ username: req.params.username }).select("_id").lean();
    if (!receiver) return res.status(404).json({ error: "User not found" });

    const conversationKey = Message.dmConversationKey(userId, receiver._id);

    // Soft delete: add viewer to deletedFor (now plain ObjectId[])
    await Message.updateMany(
      { conversation: conversationKey },
      { $addToSet: { deletedFor: userId } }
    );

    // Remove from archived chats in settings
    const settings = await UserSettings.findOne({ user: userId });
    if (settings) {
      const chatId = `user_${receiver._id}`;
      settings.chat.archivedChats = (settings.chat.archivedChats || []).filter(
        (c) => c.chatId !== chatId
      );
      await settings.save();
    }

    res.status(200).json({ message: "Chat deleted successfully" });
  } catch (error) {
    console.error("deleteChat error:", error);
    res.status(500).json({ error: "Failed to delete chat" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Message operations
// ─────────────────────────────────────────────────────────────────────────────

export const unsendMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.sender.toString() !== req.user.id) return res.status(403).json({ error: "You can only unsend your own messages" });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (message.createdAt < oneHourAgo) return res.status(403).json({ error: "Cannot unsend messages older than 1 hour" });

    message.isDeleted = true;
    message.content = "This message was deleted";
    message.media = [];
    await message.save();

    const io = getIO();
    const room = message.isGroupMessage
      ? message.group.toString()
      : [message.receiver.toString(), message.sender.toString()];
    io.to(room).emit("messageUnsent", { messageId: message._id });

    res.status(200).json({ message: "Message unsent successfully" });
  } catch (error) {
    console.error("unsendMessage error:", error);
    res.status(500).json({ error: "Failed to unsend message" });
  }
};

export const deleteMessageForMe = async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    await message.softDeleteForUser(req.user.id);
    res.status(200).json({ message: "Message deleted successfully" });
  } catch (error) {
    console.error("deleteMessageForMe error:", error);
    res.status(500).json({ error: "Failed to delete message" });
  }
};

export const editMessage = async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Content cannot be empty" });

    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.sender.toString() !== req.user.id) return res.status(403).json({ error: "You can only edit your own messages" });

    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    if (message.createdAt < fifteenMinutesAgo) return res.status(403).json({ error: "Cannot edit messages older than 15 minutes" });

    await message.editContent(content.trim());

    const io = getIO();
    const room = message.isGroupMessage
      ? message.group.toString()
      : [message.receiver.toString(), message.sender.toString()];
    io.to(room).emit("messageEdited", { messageId: message._id, content: message.content, editedAt: message.editedAt });

    res.status(200).json({
      message: "Message edited successfully",
      data: { content: message.content, editedAt: message.editedAt, isEdited: message.isEdited },
    });
  } catch (error) {
    console.error("editMessage error:", error);
    res.status(500).json({ error: "Failed to edit message" });
  }
};

export const toggleReaction = async (req, res) => {
  try {
    const { emoji, skinTone = 1 } = req.body;
    const userId = req.user.id;
    if (!emoji) return res.status(400).json({ error: "Emoji is required" });

    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    // Check participation
    const isMember = message.isGroupMessage
      ? !!(await GroupMember.findOne({ group: message.group, user: userId, isBanned: false }))
      : message.sender.toString() === userId || message.receiver?.toString() === userId;
    if (!isMember) return res.status(403).json({ error: "Not authorized" });

    const existing = await MessageReaction.findOne({ message: message._id, user: userId });
    if (existing && existing.emoji === emoji) {
      await message.removeReaction(userId);
    } else {
      await message.addReaction(userId, emoji, skinTone);
    }

    // Reload summary
    const updatedMsg = await Message.findById(message._id).select("reactionSummary").lean();

    const io = getIO();
    const room = message.isGroupMessage
      ? message.group.toString()
      : [message.sender.toString(), message.receiver?.toString()].filter(Boolean);
    io.to(room).emit("messageReaction", { messageId: message._id, userId, emoji: existing?.emoji === emoji ? null : emoji, skinTone, reactionSummary: updatedMsg.reactionSummary });

    res.status(200).json({ message: "Reaction updated", reactionSummary: updatedMsg.reactionSummary });
  } catch (error) {
    console.error("toggleReaction error:", error);
    res.status(500).json({ error: "Failed to update reaction" });
  }
};

export const forwardMessage = async (req, res) => {
  try {
    const { receiverIds, groupIds } = req.body;
    const userId = req.user.id;

    if ((!receiverIds?.length) && (!groupIds?.length)) {
      return res.status(400).json({ error: "Receiver IDs or Group IDs are required" });
    }

    const originalMessage = await Message.findById(req.params.messageId);
    if (!originalMessage) return res.status(404).json({ error: "Message not found" });

    const sender = await User.findById(userId).select("username").lean();
    const io = getIO();
    let forwardedCount = 0;

    // Forward to individual users
    if (receiverIds?.length) {
      // Check blocks for batch
      const blockRelations = await UserRelation.find({
        $or: [
          { from: userId, to: { $in: receiverIds }, kind: "block" },
          { from: { $in: receiverIds }, to: userId, kind: "block" },
        ],
      }).select("from to").lean();
      const blockedSet = new Set(blockRelations.flatMap((r) => [r.from.toString(), r.to.toString()]));

      for (const receiverId of receiverIds) {
        if (blockedSet.has(receiverId.toString())) continue;
        const receiver = await User.findById(receiverId).select("_id username").lean();
        if (!receiver) continue;

        const convKey = Message.dmConversationKey(userId, receiverId);
        const fwd = await Message.create({
          sender: userId,
          receiver: receiverId,
          conversation: convKey,
          content: originalMessage.content,
          media: originalMessage.media,
          messageType: originalMessage.messageType,
          // Carry the payload, or forwarding a shared post produces a message
          // typed post_share with nothing in it — an empty bubble.
          sharedContent: originalMessage.sharedContent,
          isForwarded: true,
          forwardedFrom: { userId: originalMessage.sender, originalMessageId: originalMessage._id, forwardCount: 0 },
        });
        await fwd.populate("sender", "username name profilePic isVerified");

        io.to(receiverId.toString()).emit("receiveMessage", { ...fwd.toObject(), isOwn: false });
        forwardedCount++;
      }
    }

    // Forward to groups
    if (groupIds?.length) {
      for (const groupId of groupIds) {
        const membership = await GroupMember.findOne({ group: groupId, user: userId, isBanned: false });
        if (!membership) continue;

        const group = await Group.findById(groupId).select("name").lean();
        if (!group) continue;

        const convKey = Message.groupConversationKey(groupId);
        const fwd = await Message.create({
          sender: userId,
          group: groupId,
          isGroupMessage: true,
          conversation: convKey,
          content: originalMessage.content,
          media: originalMessage.media,
          messageType: originalMessage.messageType,
          // Carry the payload, or forwarding a shared post produces a message
          // typed post_share with nothing in it — an empty bubble.
          sharedContent: originalMessage.sharedContent,
          isForwarded: true,
          forwardedFrom: { userId: originalMessage.sender, originalMessageId: originalMessage._id, forwardCount: 0 },
        });
        await fwd.populate("sender", "username name profilePic isVerified");

        io.to(groupId.toString()).emit("receiveGroupMessage", { ...fwd.toObject() });
        forwardedCount++;
      }
    }

    // Bump forward count on original
    if (forwardedCount > 0) {
      await Message.updateOne(
        { _id: originalMessage._id },
        { $inc: { "forwardedFrom.forwardCount": forwardedCount } }
      );
    }

    res.status(200).json({ message: "Message forwarded successfully", forwardedCount });
  } catch (error) {
    console.error("forwardMessage error:", error);
    res.status(500).json({ error: "Failed to forward message" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Read receipts / unread counts
// ─────────────────────────────────────────────────────────────────────────────

export const markMessagesAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { senderId, groupId, messageIds } = req.body;

    if (!senderId && !groupId && !messageIds) {
      return res.status(400).json({ error: "senderId, groupId, or messageIds required" });
    }

    let query = { status: { $in: ["sent", "delivered"] } };
    if (messageIds?.length) query._id = { $in: messageIds };
    else if (groupId) { query.group = groupId; query.sender = { $ne: userId }; }
    else if (senderId) { query.sender = senderId; query.receiver = userId; }

    if (groupId) {
      const isMember = !!(await GroupMember.findOne({ group: groupId, user: userId, isBanned: false }));
      if (!isMember) return res.status(403).json({ error: "Not a member of this group" });
    }

    const messages = await Message.find(query).lean();
    if (messages.length) {
      await Message.updateMany({ _id: { $in: messages.map((m) => m._id) } }, { $set: { status: "read" } });
      const receiptOps = messages.map((m) =>
        MessageReceipt.updateOne(
          { message: m._id, user: userId, kind: "read" },
          { $setOnInsert: { message: m._id, user: userId, kind: "read", conversation: m.conversation } },
          { upsert: true }
        )
      );
      await Promise.all(receiptOps);
    }

    const io = getIO();
    if (senderId) io.to(senderId).emit("messagesRead", { readBy: userId, count: messages.length });

    res.status(200).json({ message: "Messages marked as read", count: messages.length });
  } catch (error) {
    console.error("markMessagesAsRead error:", error);
    res.status(500).json({ error: "Failed to mark messages as read" });
  }
};

export const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const userGroupIds = await getUserGroupIds(userId);

    const unreadMessages = await Message.find({
      $or: [
        { receiver: userId, status: { $in: ["sent", "delivered"] }, isGroupMessage: false },
        { isGroupMessage: true, group: { $in: userGroupIds }, sender: { $ne: userId }, status: { $in: ["sent", "delivered"] } },
      ],
      isDeleted: false,
      ...notDeletedForUser(userId),
    })
      .select("sender group isGroupMessage")
      .populate("sender", "_id username name profilePic")
      .populate("group", "_id name avatar")
      .lean();

    const unreadCounts = { users: {}, groups: {}, total: 0 };
    unreadMessages.forEach((msg) => {
      if (msg.isGroupMessage) {
        const gid = msg.group?._id?.toString();
        if (gid) {
          unreadCounts.groups[gid] = (unreadCounts.groups[gid] || 0) + 1;
          unreadCounts.groups[gid + "_info"] = { name: msg.group.name, avatar: msg.group.avatar };
        }
      } else {
        const sid = msg.sender?._id?.toString();
        if (sid) {
          unreadCounts.users[sid] = (unreadCounts.users[sid] || 0) + 1;
          unreadCounts.users[sid + "_info"] = { username: msg.sender.username, name: msg.sender.name, profilePic: msg.sender.profilePic };
        }
      }
      unreadCounts.total++;
    });

    res.status(200).json({ unreadCounts, totalUnread: unreadCounts.total });
  } catch (error) {
    console.error("getUnreadCount error:", error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

export const searchMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { username } = req.params;
    const { query, limit = 50, cursor } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    if (!query) return res.status(400).json({ error: "Search query is required" });

    const receiver = await User.findOne({ username }).select("_id").lean();
    if (!receiver) return res.status(404).json({ error: "User not found" });

    const conversationKey = Message.dmConversationKey(userId, receiver._id);
    const searchRx = new RegExp(escapeRegex(query), "i");

    const messages = await Message.find({
      conversation: conversationKey,
      isDeleted: false,
      ...notDeletedForUser(userId),
      $or: [{ content: searchRx }, { "media.caption": searchRx }, { "poll.question": searchRx }],
      ...cursorQuery,
    })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic")
      .lean();

    const { items: pagedMessages, pageInfo } = buildCursorPageInfo(messages, limitNum);
    res.status(200).json({ messages: stripSharedSnapshots(pagedMessages), count: pagedMessages.length, pageInfo, hasMore: pageInfo.hasNextPage });
  } catch (error) {
    console.error("searchMessages error:", error);
    res.status(500).json({ error: "Failed to search messages" });
  }
};

export const globalSearch = async (req, res) => {
  try {
    const userId = req.user.id;
    const { query, limit = 20 } = req.query;
    if (!query) return res.status(400).json({ error: "Search query is required" });

    const searchRx = new RegExp(escapeRegex(query), "i");
    const contentFilter = { $or: [{ content: searchRx }, { "media.caption": searchRx }] };

    const userGroupIds = await getUserGroupIds(userId);

    const [personalMessages, groupMessages, users, groups] = await Promise.all([
      Message.find({
        $or: [{ sender: userId }, { receiver: userId }],
        isDeleted: false,
        isGroupMessage: false,
        ...notDeletedForUser(userId),
        ...contentFilter,
      }).sort({ createdAt: -1 }).limit(+limit).populate("sender receiver", "username name profilePic").lean(),

      Message.find({
        group: { $in: userGroupIds },
        isGroupMessage: true,
        isDeleted: false,
        ...notDeletedForUser(userId),
        ...contentFilter,
      }).sort({ createdAt: -1 }).limit(+limit).populate("sender", "username name profilePic").populate("group", "name avatar").lean(),

      User.find({ $or: [{ username: searchRx }, { name: searchRx }], _id: { $ne: userId },
        // $nin, not equality: it also matches accounts created before
        // `accountStatus` existed, which equality silently excludes.
        accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] } })
        .select("username name profilePic isVerified").limit(10).lean(),

      Group.find({ name: searchRx, isActive: true, isDeleted: false })
        .select("name avatar counts").limit(10).lean().then(async (gs) => {
          const userGSet = new Set(userGroupIds.map((id) => id.toString()));
          return gs.filter((g) => userGSet.has(g._id.toString()));
        }),
    ]);

    res.status(200).json({
      personalMessages, groupMessages, users, groups,
      totals: { personal: personalMessages.length, group: groupMessages.length, users: users.length, groups: groups.length },
    });
  } catch (error) {
    console.error("globalSearch error:", error);
    res.status(500).json({ error: "Failed to perform search" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Pin / Pinned messages / Media
// ─────────────────────────────────────────────────────────────────────────────

export const pinMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    let hasPermission = false;
    if (message.isGroupMessage) {
      const membership = await GroupMember.findOne({ group: message.group, user: userId, isBanned: false });
      hasPermission = membership?.permissionOverrides?.pinMessages ?? (membership?.role === "admin" || membership?.role === "super_admin");
    } else {
      hasPermission = message.sender.toString() === userId || message.receiver?.toString() === userId;
    }

    if (!hasPermission) return res.status(403).json({ error: "Not authorized to pin messages" });

    message.isPinned = !message.isPinned;
    message.pinnedAt = message.isPinned ? new Date() : null;
    message.pinnedBy = message.isPinned ? userId : null;
    await message.save();

    const io = getIO();
    const room = message.isGroupMessage
      ? message.group.toString()
      : [message.sender.toString(), message.receiver?.toString()].filter(Boolean);
    io.to(room).emit("messagePinned", { messageId: message._id, isPinned: message.isPinned, pinnedBy: userId, pinnedAt: message.pinnedAt });

    res.status(200).json({ message: message.isPinned ? "Message pinned" : "Message unpinned", isPinned: message.isPinned });
  } catch (error) {
    console.error("pinMessage error:", error);
    res.status(500).json({ error: "Failed to pin message" });
  }
};

export const getPinnedMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { limit = 50, cursor } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);

    if (!/^[0-9a-fA-F]{24}$/.test(conversationId)) {
      return res.status(400).json({ error: "Invalid conversation ID" });
    }

    const conversationKey = Message.dmConversationKey(userId, conversationId);
    const query = {
      conversation: conversationKey,
      isPinned: true,
      isDeleted: false,
      ...notDeletedForUser(userId),
    };
    if (parsedCursor) Object.assign(query, buildCursorQuery(parsedCursor));

    const pinnedMessages = await Message.find(query)
      .sort({ pinnedAt: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic")
      .populate("pinnedBy", "username name")
      .lean();

    const { items, pageInfo } = buildCursorPageInfo(pinnedMessages, limitNum);
    res.status(200).json({ pinnedMessages: stripSharedSnapshots(items), pageInfo, hasMore: pageInfo.hasNextPage });
  } catch (error) {
    console.error("getPinnedMessages error:", error);
    res.status(500).json({ error: "Failed to fetch pinned messages" });
  }
};

export const getConversationMedia = async (req, res) => {
  try {
    const userId = req.user.id;
    const { username } = req.params;
    const { type, limit = 50, cursor } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    const receiver = await User.findOne({ username }).select("_id").lean();
    if (!receiver) return res.status(404).json({ error: "User not found" });

    const conversationKey = Message.dmConversationKey(userId, receiver._id);
    const query = {
      conversation: conversationKey,
      "media.0": { $exists: true },
      isDeleted: false,
      ...notDeletedForUser(userId),
      ...(type ? { "media.type": type } : {}),
      ...cursorQuery,
    };

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .select("media createdAt sender")
      .populate("sender", "username name profilePic")
      .lean();

    const { items: pagedMessages, pageInfo } = buildCursorPageInfo(messages, limitNum);
    const media = pagedMessages.flatMap((msg) =>
      msg.media.map((m) => ({ ...m, messageId: msg._id, timestamp: msg.createdAt, sender: msg.sender }))
    );

    res.status(200).json({ media, pageInfo, hasMore: pageInfo.hasNextPage, totalCount: media.length });
  } catch (error) {
    console.error("getConversationMedia error:", error);
    res.status(500).json({ error: "Failed to fetch media" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Media upload
// ─────────────────────────────────────────────────────────────────────────────

export const uploadChatMedia = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (req.file.size > 100 * 1024 * 1024) return res.status(400).json({ error: "File size exceeds 100MB limit" });

    const allowed = ["image/jpeg","image/png","image/gif","image/webp","video/mp4","video/quicktime","video/x-msvideo","audio/mpeg","audio/wav","audio/ogg","application/pdf","text/plain","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: "Invalid file type" });

    let fileType = "document";
    if (req.file.mimetype.startsWith("image/")) fileType = "image";
    if (req.file.mimetype.startsWith("video/")) fileType = "video";
    if (req.file.mimetype.startsWith("audio/")) fileType = "audio";

    const result = await uploadToCloudinary(req.file.path, "chat_media");
    res.status(200).json({
      url: result.secure_url, thumbnail: result.thumbnail_url || result.secure_url,
      fileSize: req.file.size, type: fileType, filename: req.file.originalname,
      duration: result.duration || null,
      dimensions: result.width && result.height ? { width: result.width, height: result.height } : null,
    });
  } catch (error) {
    console.error("uploadChatMedia error:", error);
    res.status(500).json({ error: "Failed to upload media" });
  }
};

export const uploadVoiceNote = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ error: "Voice note too large" });
    if (!req.file.mimetype.startsWith("audio/")) return res.status(400).json({ error: "Invalid audio file" });

    const result = await uploadToCloudinary(req.file.path, "voice_notes");
    const points = Math.min(100, Math.floor((result.duration || 0) * 10));
    res.status(200).json({ url: result.secure_url, duration: result.duration || 0, waveform: Array.from({ length: points }, () => Math.random()) });
  } catch (error) {
    console.error("uploadVoiceNote error:", error);
    res.status(500).json({ error: "Failed to upload voice note" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Polls
// ─────────────────────────────────────────────────────────────────────────────

export const createPoll = async (req, res) => {
  try {
    const userId = req.user.id;
    const { receiverId, groupId, question, options, settings: pollSettings = {} } = req.body;

    if (!question || !options || options.length < 2) return res.status(400).json({ error: "Question and at least 2 options are required" });
    if (options.length > 10) return res.status(400).json({ error: "Maximum 10 options allowed" });

    const pollData = {
      question: question.trim(),
      options: options.map((text) => ({ id: uuidv4(), text: text.trim(), votes: [], voteCount: 0 })),
      allowMultipleAnswers: pollSettings.allowMultipleAnswers || false,
      isAnonymous: pollSettings.isAnonymous || false,
      expiresAt: pollSettings.expiresAt ? new Date(pollSettings.expiresAt) : null,
      settings: { allowAddingOptions: pollSettings.allowAddingOptions || false, showVoteCount: pollSettings.showVoteCount !== false },
    };

    const convKey = groupId
      ? Message.groupConversationKey(groupId)
      : Message.dmConversationKey(userId, receiverId);

    const message = await Message.create({
      sender: userId,
      conversation: convKey,
      messageType: "poll",
      poll: pollData,
      ...(groupId ? { group: groupId, isGroupMessage: true } : { receiver: receiverId }),
    });
    await message.populate("sender", "username name profilePic isVerified");

    const io = getIO();
    if (groupId) io.to(groupId).emit("receiveGroupMessage", message.toObject());
    else {
      io.to(receiverId).emit("receiveMessage", { ...message.toObject(), isOwn: false });
      io.to(userId).emit("receiveMessage", { ...message.toObject(), isOwn: true });
    }

    res.status(201).json({ message: "Poll created successfully", poll: message.poll });
  } catch (error) {
    console.error("createPoll error:", error);
    res.status(500).json({ error: "Failed to create poll" });
  }
};

export default {
  getMessages, getGroupMessages, getChats, getChatPreferences,
  createChatCategory, reorderChatCategories, deleteChatCategory, assignChatCategory,
  toggleFavoriteChat, updateChatTheme, setDisappearingForChat, updateChatState, setChatLockPin,
  archiveChat, deleteChat, unsendMessage, deleteMessageForMe, editMessage, toggleReaction,
  forwardMessage, uploadChatMedia, uploadVoiceNote, getUnreadCount, markMessagesAsRead,
  searchMessages, globalSearch, pinMessage, getPinnedMessages, getConversationMedia,
  createPoll, getUserGroups,
};
