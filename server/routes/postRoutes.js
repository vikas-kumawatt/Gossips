import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  likePost,
  createPost,
  getHomeFeed,
  getUserPosts,
  getPost,
  deletePost,
  repostPost,
  getPostLikes,
  getPostReposts,
  getPostQuotes,
  getPostActivity,
  getSavedPosts,
  toggleSavePost,
  toggleHideLikeShareCount,
  updatePostWhoCanReply,
  markNotInterested,
  undoNotInterested,
  getDrafts,
  saveDraft,
  deleteDraft,
  getLikedPosts,
  trackPostView,
  trackBulkPostViews,
  editPost,
  getPostEditHistory,
} from "../controllers/postController.js";
import upload from "../config/multerConfig.js";
import {
  requirePostingEnabled,
  requireActiveAccount,
  applyMediaUploadFlag,
  requireAccountAge,
  enforceContentLength,
} from "../middleware/featureGate.js";

const router = express.Router();

// Creating content respects the admin flags and the author's account standing.
const canCreate = [protect, requireActiveAccount, requirePostingEnabled, requireAccountAge];
const postLength = enforceContentLength("maxPostLength");

// ── Specific GET routes (must come before /:username catch-all) ────────────
router.get("/feed", protect, getHomeFeed);
router.get("/saved-posts", protect, getSavedPosts);
router.get("/liked-posts", protect, getLikedPosts);
router.get("/drafts", protect, getDrafts);
router.get("/post/:postId", protect, getPost);
router.get("/likes/:postId", protect, getPostLikes);
router.get("/reposts/:postId", protect, getPostReposts);
router.get("/quotes/:postId", protect, getPostQuotes);
router.get("/activity/:postId", protect, getPostActivity);
router.get("/:id/edit-history", protect, getPostEditHistory);

// ── POST / mutating routes ─────────────────────────────────────────────────
// enforceContentLength runs after multer so req.body is populated.
router.post("/create", canCreate, upload.array("media", 5), applyMediaUploadFlag, postLength, createPost);
router.post("/save-draft", canCreate, upload.array("media", 5), applyMediaUploadFlag, postLength, saveDraft);
router.post("/views/bulk", protect, trackBulkPostViews);
router.post("/save/:postId", protect, toggleSavePost);
router.post("/:id/like", protect, likePost);
router.post("/:id/repost", protect, repostPost);
router.post("/:id/view", protect, trackPostView);
router.post("/:id/toggle-hide-count", protect, toggleHideLikeShareCount);
router.patch("/:id/who-can-reply", protect, updatePostWhoCanReply);
router.patch("/:id/edit", protect, requireActiveAccount, postLength, editPost);
router.post("/:id/not-interested", protect, markNotInterested);

// ── DELETE routes ──────────────────────────────────────────────────────────
router.delete("/draft/:id", protect, deleteDraft);
router.delete("/:id/not-interested", protect, undoNotInterested);
router.delete("/:id", protect, deletePost);

// ── Catch-all: must be last GET ────────────────────────────────────────────
router.get("/:username", protect, getUserPosts);

export default router;
