import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getMessages,
  getGroupMessages,
  getChats,
  getChatPreferences,
  createChatCategory,
  reorderChatCategories,
  deleteChatCategory,
  assignChatCategory,
  toggleFavoriteChat,
  updateChatTheme,
  setDisappearingForChat,
  updateChatState,
  setChatLockPin,
  archiveChat,
  deleteChat,
  unsendMessage,
  deleteMessageForMe,
  editMessage,
  toggleReaction,
  forwardMessage,
  uploadChatMedia,
  uploadVoiceNote,
  getUnreadCount,
  markMessagesAsRead,
  searchMessages,
  globalSearch,
  pinMessage,
  getPinnedMessages,
  getConversationMedia,
  createPoll
} from "../controllers/chatController.js";
import upload from "../config/multerConfig.js";
import { rateLimit } from "express-rate-limit";
import {
  requireMessagingEnabled,
  requireActiveAccount,
} from "../middleware/featureGate.js";
import {
  getShareTargets,
  shareContent,
  hideShareSuggestion,
} from "../controllers/shareController.js";

const router = express.Router();

// New messages are created over the socket (gated in config/socket.js); these
// are the HTTP paths that also produce message content.
const canMessage = [protect, requireActiveAccount, requireMessagingEnabled];

// Rate limiters
const messageRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 messages per minute
  message: "Too many messages, please slow down",
  standardHeaders: true,
  legacyHeaders: false
});

const uploadRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 uploads per 5 minutes
  message: "Too many uploads, please try again later",
  standardHeaders: true,
  legacyHeaders: false
});

const searchRateLimit = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 30, // 30 searches per 10 seconds
  message: "Too many search requests, please slow down",
  standardHeaders: true,
  legacyHeaders: false
});

// Chat list and management
router.get("/", protect, getChats);

// ── Sharing a post/comment into chats ──────────────────────────────────────
// Literal single-segment paths; nothing above matches them.
router.get("/share-targets", protect, searchRateLimit, getShareTargets);
router.post("/share-targets/hide", protect, hideShareSuggestion);
router.post("/share", canMessage, messageRateLimit, shareContent);

router.get("/preferences", protect, getChatPreferences);
router.post("/preferences/categories", protect, createChatCategory);
router.put("/preferences/categories/reorder", protect, reorderChatCategories);
router.delete("/preferences/categories/:categoryId", protect, deleteChatCategory);
router.put("/preferences/assignments/:chatId", protect, assignChatCategory);
router.post("/preferences/favorites/:chatId/toggle", protect, toggleFavoriteChat);
router.patch("/preferences/appearance", protect, updateChatTheme);
router.put("/preferences/disappearing/:chatId", protect, setDisappearingForChat);
router.put("/preferences/state/:chatId", protect, updateChatState);
router.put("/preferences/lock-pin", protect, setChatLockPin);
router.get("/unread-count", protect, getUnreadCount);
router.post("/:chatId/archive", protect, archiveChat);
router.delete("/:username", protect, deleteChat);

// Message routes
router.get("/messages/:username", protect, getMessages);
router.get("/groups/:groupId/messages", protect, getGroupMessages);
router.post("/messages/mark-read", protect, markMessagesAsRead);

// Search
router.get("/messages/:username/search", protect, searchRateLimit, searchMessages);
router.get("/search/global", protect, searchRateLimit, globalSearch);

// Media and files
router.get("/messages/:username/media", protect, getConversationMedia);

// Individual message operations
router.delete("/message/:messageId/unsend", protect, unsendMessage);
router.delete("/message/:messageId/delete", protect, deleteMessageForMe);
router.put("/message/:messageId/edit", protect, editMessage);
router.post("/message/:messageId/reaction", protect, toggleReaction);
router.post("/message/:messageId/forward", canMessage, messageRateLimit, forwardMessage);
router.post("/message/:messageId/pin", protect, pinMessage);

// Pinned messages
router.get("/:conversationId/pinned", protect, getPinnedMessages);
router.get("/groups/:conversationId/pinned", protect, getPinnedMessages);

// Media upload
router.post("/upload", canMessage, uploadRateLimit, upload.single("file"), uploadChatMedia);
router.post("/upload/voice", canMessage, uploadRateLimit, upload.single("audio"), uploadVoiceNote);

// Polls
router.post("/polls", canMessage, messageRateLimit, createPoll);

export default router;