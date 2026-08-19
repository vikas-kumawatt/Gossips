import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  sendMessage,
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
  resetChatLockPin,
  verifyChatLockPin,
  archiveChat,
  deleteChat,
  unsendMessage,
  deleteMessageForMe,
  editMessage,
  toggleReaction,
  forwardMessage,
  uploadChatMedia,
  uploadVoiceNote,
  discardChatMedia,
  getUnreadCount,
  markMessagesAsRead,
  searchMessages,
  globalSearch,
  pinMessage,
  getPinnedMessages,
  getGroupPinnedMessages,
  getConversationMedia,
  getCallIceServers,
  createPoll
} from "../controllers/chatController.js";
// The chat instance, not the shared one: chat is the only surface that takes
// documents, and widening the shared filter would let a PDF into the feed.
import { chatUpload } from "../config/multerConfig.js";
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

// Acting on a message you already sent. Removing your own content stays
// available while messaging is switched off — producing new content does not —
// but a suspended account can't do either, or suspending someone for abuse
// would leave them free to edit the abuse into fresh abuse, or delete it.
const canAmendOwn = [protect, requireActiveAccount];

// Rate limiters.
//
// Keyed on the authenticated user rather than express-rate-limit's default of
// req.ip: `protect` runs first on every route these are attached to, and an IP
// key means one person behind a carrier NAT spends everyone else's budget.
const byUser = (req) => req.user?.id ?? req.ip;

const messageRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 messages per minute
  keyGenerator: byUser,
  message: "Too many messages, please slow down",
  standardHeaders: true,
  legacyHeaders: false
});

// Acting on messages that already exist. Separate from the send budget because
// reacting is a high-frequency gesture — sixty taps while scrolling a backlog
// shouldn't leave you unable to send a message.
const amendRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 240,
  keyGenerator: byUser,
  message: "Too many requests, please slow down",
  standardHeaders: true,
  legacyHeaders: false
});

const uploadRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 uploads per 5 minutes
  keyGenerator: byUser,
  message: "Too many uploads, please try again later",
  standardHeaders: true,
  legacyHeaders: false
});

/*
 * Reads.
 *
 * These had no limiter at all — the chat list, the unread count, every thread
 * page, mark-read, the media grid and the pinned list. `GET /chats` is the most
 * expensive query in the app and is marked `no-store` so clients call it
 * constantly, and `getUnreadCount` has the same shape; a loop over either is a
 * database amplifier that costs the caller one HTTP request. Generous, because
 * these are the calls a normal session makes most: opening a conversation is a
 * thread page plus a mark-read plus a pinned fetch, and switching between ten
 * chats shouldn't be throttled.
 */
const readRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: byUser,
  message: "Too many requests, please slow down",
  standardHeaders: true,
  legacyHeaders: false,
});

/*
 * Preference writes.
 *
 * Every one of them appends to an array on a single UserSettings document. The
 * per-list caps in chatController bound the damage, but without a limiter a
 * script still walks each list to its ceiling in a second and each attempt is a
 * document read plus a save. Muting, pinning and favouriting are human-speed
 * gestures.
 */
const preferenceRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: byUser,
  message: "Too many changes, please slow down",
  standardHeaders: true,
  legacyHeaders: false,
});

/*
 * PIN attempts.
 *
 * A 4-digit PIN is ten thousand guesses and there was nothing at all in front
 * of it. bcrypt at cost 10 also makes each attempt ~100ms of server CPU, so an
 * unthrottled endpoint is a cheap way to pin a core as well as to brute-force
 * the lock.
 */
const lockPinRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: byUser,
  // Only failures count. Every unlock-to-read sends a correct PIN through this
  // same route, so counting successes would lock someone out of their own
  // chats after ten legitimate opens — and out of changing their PIN too.
  skipSuccessfulRequests: true,
  message: "Too many PIN attempts, try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

// /preferences/state is shared with mute, pin and favourite, which are ordinary
// high-frequency toggles — only the lock branch takes a PIN, so only it counts
// against the PIN budget.
const lockPinGuard = (req, res, next) =>
  req.body?.stateKey === "lock" ? lockPinRateLimit(req, res, next) : next();

const searchRateLimit = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 30, // 30 searches per 10 seconds
  keyGenerator: byUser,
  message: "Too many search requests, please slow down",
  standardHeaders: true,
  legacyHeaders: false
});

// Chat list and management
router.get("/", protect, readRateLimit, getChats);

/*
 * ICE servers for a call, fetched just before dialling or answering.
 *
 * Not baked into the client bundle: a TURN credential is a bandwidth bill, so it is
 * only handed to an authenticated caller. A literal two-segment path, above every
 * `/:param` route below.
 */
router.get("/call/ice-servers", protect, readRateLimit, getCallIceServers);

// ── Sharing a post/comment into chats ──────────────────────────────────────
// Literal single-segment paths; nothing above matches them.
router.get("/share-targets", protect, searchRateLimit, getShareTargets);
router.post("/share-targets/hide", protect, hideShareSuggestion);
router.post("/share", canMessage, messageRateLimit, shareContent);

router.get("/preferences", protect, readRateLimit, getChatPreferences);
router.post("/preferences/categories", protect, preferenceRateLimit, createChatCategory);
router.put("/preferences/categories/reorder", protect, preferenceRateLimit, reorderChatCategories);
router.delete("/preferences/categories/:categoryId", protect, preferenceRateLimit, deleteChatCategory);
router.put("/preferences/assignments/:chatId", protect, preferenceRateLimit, assignChatCategory);
router.post("/preferences/favorites/:chatId/toggle", protect, preferenceRateLimit, toggleFavoriteChat);
router.patch("/preferences/appearance", protect, preferenceRateLimit, updateChatTheme);
router.put("/preferences/disappearing/:chatId", protect, preferenceRateLimit, setDisappearingForChat);
router.put("/preferences/state/:chatId", protect, preferenceRateLimit, lockPinGuard, updateChatState);
router.put("/preferences/lock-pin", protect, lockPinRateLimit, setChatLockPin);
// Password-gated, so it shares the PIN budget: it's the other way to attack the
// same lock, and bcrypt makes each attempt ~100ms of server CPU either way.
router.post("/preferences/lock-pin/reset", protect, lockPinRateLimit, resetChatLockPin);
/*
 * Proving the PIN to read one locked conversation.
 *
 * Same budget as the other two: it's a bcrypt comparison against the same
 * secret, and it's the endpoint an attacker would actually pick — ten thousand
 * combinations for a 4-digit PIN. `skipSuccessfulRequests` on that limiter means
 * legitimately opening a locked chat repeatedly doesn't consume it.
 */
router.post("/preferences/lock-pin/verify", protect, lockPinRateLimit, verifyChatLockPin);
router.get("/unread-count", protect, readRateLimit, getUnreadCount);
router.post("/:chatId/archive", protect, preferenceRateLimit, archiveChat);
router.delete("/:username", protect, preferenceRateLimit, deleteChat);

// Message routes
/*
 * Sending, as a fallback for the socket.
 *
 * `canMessage` and `messageRateLimit` are the same guards `/share` and
 * `/forward` use — both of which already create messages over HTTP. The socket
 * remains the primary path and is unchanged; this exists so a dropped connection
 * stops meaning "cannot send". See the note on the controller.
 *
 * Above `/messages/:username`, which is a GET, so there is no conflict — grouped
 * here to keep the send and the read of a conversation adjacent.
 */
router.post("/messages", canMessage, messageRateLimit, sendMessage);
router.get("/messages/:username", protect, readRateLimit, getMessages);
router.get("/groups/:groupId/messages", protect, readRateLimit, getGroupMessages);
router.post("/messages/mark-read", protect, readRateLimit, markMessagesAsRead);

// Search
router.get("/messages/:username/search", protect, searchRateLimit, searchMessages);
router.get("/search/global", protect, searchRateLimit, globalSearch);

// Media and files
router.get("/messages/:username/media", protect, readRateLimit, getConversationMedia);

// Individual message operations
router.delete("/message/:messageId/unsend", canAmendOwn, amendRateLimit, unsendMessage);
router.delete("/message/:messageId/delete", canAmendOwn, amendRateLimit, deleteMessageForMe);
router.put("/message/:messageId/edit", canMessage, amendRateLimit, editMessage);
router.post("/message/:messageId/reaction", canMessage, amendRateLimit, toggleReaction);
router.post("/message/:messageId/forward", canMessage, messageRateLimit, forwardMessage);
router.post("/message/:messageId/pin", canAmendOwn, amendRateLimit, pinMessage);

// Pinned messages
// Two handlers, not one: the scope decides whether the conversation key is a
// DM key or a group key, and it has to come from the route rather than from a
// client-supplied id.
router.get("/groups/:conversationId/pinned", protect, readRateLimit, getGroupPinnedMessages);
router.get("/:conversationId/pinned", protect, readRateLimit, getPinnedMessages);

// Media upload
router.post("/upload", canMessage, uploadRateLimit, chatUpload.single("file"), uploadChatMedia);
router.post("/upload/voice", canMessage, uploadRateLimit, chatUpload.single("audio"), uploadVoiceNote);
/*
 * Cleaning up uploads that were never sent (CF28).
 *
 * Not behind `uploadRateLimit`: it runs on the error path of an upload batch that
 * has already consumed that budget, and refusing the cleanup because the uploads
 * used up the allowance is exactly backwards. `preferenceRateLimit` is the ordinary
 * write budget — enough for any real failure, bounded against a loop.
 */
router.post("/upload/discard", canMessage, preferenceRateLimit, discardChatMedia);

// Polls
router.post("/polls", canMessage, messageRateLimit, createPoll);

export default router;