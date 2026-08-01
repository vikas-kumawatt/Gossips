import { Router } from "express";
import {
  setupProfile,
  getUserProfile,
  getFollowRequests,
  getUsers,
  acceptFollowRequest,
  rejectFollowRequest,
  cancelFollowRequest,
  followUser,
  unfollowUser,
  checkPendingRequestStatus,
  getReplies,
  getReposts,
  isFollowingMe,
  restrictUser,
  blockUser,
  unblockUser,
  muteUser,
  unmuteUser,
  getMutedUsers,
  getBlockedUsers,
  getFollowersList,
  removeFollower,
  getFollowingList,
} from "../controllers/userController.js";
import { protect } from "../middleware/authMiddleware.js";
import upload from "../config/multerConfig.js";

const router = Router();

router.post("/profile-setup", protect, upload.single("profilePic"), setupProfile);
router.get("/search", protect, getUsers);
router.get("/users", protect, getUsers);
router.get("/muted", protect, getMutedUsers);
router.get("/blocked", protect, getBlockedUsers);
router.get("/follow-requests", protect, getFollowRequests);
router.post("/follow-requests/:requestId/accept", protect, acceptFollowRequest);
router.post("/follow-requests/:requestId/reject", protect, rejectFollowRequest);
router.delete("/follow-request/:username", protect, cancelFollowRequest);
router.get("/pending-request/:username", protect, checkPendingRequestStatus);
router.post("/follow/:username", protect, followUser);
router.post("/unfollow/:username", protect, unfollowUser);
router.post("/restrict/:username", protect, restrictUser);
router.post("/block/:username", protect, blockUser);
router.post("/unblock/:username", protect, unblockUser);
router.post("/mute/:username", protect, muteUser);
router.post("/unmute/:username", protect, unmuteUser);
router.get('/is-following-me/:username', protect, isFollowingMe);
// Owner-only: removing someone from your followers. Registered before the
// GET list routes only for grouping — different verbs, no conflict.
router.delete("/followers/:username", protect, removeFollower);
router.get("/:username/followers", protect, getFollowersList);
router.get("/:username/following", protect, getFollowingList);
router.get("/:username/replies", protect, getReplies);
router.get("/:profileId/reposts", protect, getReposts);
router.get("/:username", protect, getUserProfile);

export default router;