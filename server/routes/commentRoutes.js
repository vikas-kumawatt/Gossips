import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { deleteComment, getComments,  likeComment, replyOnPost, getComment, getRepliesForComment, getCommentsWithReplies, createNestedComment, repostComment, updateCommentWhoCanReply, editComment, getCommentEditHistory } from "../controllers/commentController.js";
import upload from "../config/multerConfig.js";
import {
  requireCommentingEnabled,
  requireActiveAccount,
  applyMediaUploadFlag,
  requireAccountAge,
  enforceContentLength,
} from "../middleware/featureGate.js";

const router = express.Router();

const canComment = [protect, requireActiveAccount, requireCommentingEnabled, requireAccountAge];
const commentLength = enforceContentLength("maxCommentLength");

router.post("/comment", canComment, upload.array("media", 5), applyMediaUploadFlag, commentLength, replyOnPost);
router.post("/nested-comment", canComment, upload.array("media", 5), applyMediaUploadFlag, commentLength, createNestedComment);
router.get("/replies/:postId", protect, getCommentsWithReplies);
router.get("/comments/replies/:commentId", protect, getRepliesForComment);
router.get("/comments/:postId", protect, getComments);
router.get("/:commentId/edit-history", protect, getCommentEditHistory);
router.patch("/:commentId/who-can-reply", protect, updateCommentWhoCanReply);
router.patch("/:commentId/edit", protect, requireActiveAccount, commentLength, editComment);
router.post("/:commentId/like", protect, likeComment);
router.delete("/:commentId", protect, deleteComment);
router.get("/:commentId", protect, getComment);
router.post("/:id/repost", protect, repostComment);

export default router;