import express from "express";
import { rateLimit } from "express-rate-limit";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveAccount } from "../middleware/featureGate.js";
import upload from "../config/multerConfig.js";
import {
  addApiKey,
  createBot,
  deleteBot,
  getBot,
  getBotActivity,
  listApiKeys,
  listBots,
  revalidateApiKey,
  revokeApiKey,
  updateApiKey,
  updateBot,
  updateBotAvatar,
  getBotChats,
  getBotConversation,
} from "../controllers/botController.js";

const router = express.Router();

/*
 * Keys and bots share a router because they only exist for each other: a key is added in
 * order to run a bot, and the dashboard shows both on one screen. Mounted at `/bots` to
 * match this app's convention of bare domain prefixes (`/posts`, `/chats`, `/groups`)
 * rather than the spec's `/api/...`, which nothing else here uses.
 */

/**
 * Adding or revalidating a key makes an outbound call to the provider.
 *
 * That makes these the only endpoints in this file that cost real time and real money, and
 * the only ones worth abusing — a loop over `POST /keys` with guessed values would turn
 * this server into a free credential-testing oracle against Anthropic. Ten an hour is
 * generous for a person managing at most a handful of keys, and useless for that.
 */
const providerCallLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many key checks. Try again in a while." },
});

/** Creating an account is cheap but not free, and the cap is five. */
const createLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many bots created. Try again in a while." },
});

/** Avatar uploads. Each one stores a file, so it gets a tighter budget than an edit. */
const avatarLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many image uploads. Try again in a while." },
});

/** Ordinary reads and edits. Loose, but not unbounded. */
const manageLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down a moment." },
});

/*
 * `requireActiveAccount` on every write, for the same reason messaging has it: a suspended
 * or deactivated human must not keep operating bots. Reads are left open so someone who has
 * been suspended can still see what their bots are and what they did.
 */

// ── Keys ────────────────────────────────────────────────────────────────────
// Literal segment first: `/keys` would otherwise be captured by `/:id` below.
router.get("/keys", protect, manageLimit, listApiKeys);
router.post("/keys", protect, requireActiveAccount, providerCallLimit, addApiKey);
router.patch("/keys/:id", protect, requireActiveAccount, manageLimit, updateApiKey);
router.delete("/keys/:id", protect, requireActiveAccount, manageLimit, revokeApiKey);
router.post(
  "/keys/:id/revalidate",
  protect,
  requireActiveAccount,
  providerCallLimit,
  revalidateApiKey
);

// ── Bots ────────────────────────────────────────────────────────────────────
router.get("/", protect, manageLimit, listBots);
router.post("/", protect, requireActiveAccount, createLimit, createBot);
router.get("/:id/activity", protect, manageLimit, getBotActivity);
router.get("/:id", protect, manageLimit, getBot);
router.patch("/:id", protect, requireActiveAccount, manageLimit, updateBot);
/*
 * Its own route because it's multipart — see `updateBotAvatar`. `avatarLimit` rather than
 * `manageLimit`: this one writes a file to Cloudinary, so it is the only bot endpoint where
 * a loop costs storage rather than a few milliseconds.
 */
router.post(
  "/:id/avatar",
  protect,
  requireActiveAccount,
  avatarLimit,
  upload.single("profilePic"),
  updateBotAvatar
);
router.delete("/:id", protect, requireActiveAccount, manageLimit, deleteBot);
router.get("/:id/chats", protect, manageLimit, getBotChats);
router.get("/:id/chats/:username/messages", protect, manageLimit, getBotConversation);

export default router;
