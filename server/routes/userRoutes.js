import { Router } from "express";
import rateLimit from "express-rate-limit";
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
  getProfileAbout,
  getUsernameAvailability,
  getUsernameStatus,
  changeUsername,
} from "../controllers/userController.js";
import { protect } from "../middleware/authMiddleware.js";
import upload from "../config/multerConfig.js";

const router = Router();

/*
 * The availability check runs while you type, so it's the one route here a
 * bored person could turn into a username enumerator. Generous enough for
 * debounced typing, tight enough that walking the namespace isn't practical.
 */
const availabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { error: "Slow down a moment" },
});

// Actually taking a name is cheap to do and expensive to undo, so it gets a
// much smaller allowance than the policy alone would imply.
const changeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { error: "Too many attempts. Try again later." },
});

router.post("/profile-setup", protect, upload.single("profilePic"), setupProfile);
router.get("/search", protect, getUsers);
/*
 * Hyphenated on purpose. A username can't contain a hyphen, so these paths
 * can never be mistaken for a real profile no matter where they sit in the
 * table — whereas "/username/availability" would be caught by `/:username/…`.
 */
router.get("/username-availability", protect, availabilityLimiter, getUsernameAvailability);
router.get("/username-status", protect, getUsernameStatus);
router.patch("/username", protect, changeLimiter, changeUsername);
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
router.get("/:username/about", protect, getProfileAbout);
router.get("/:username/followers", protect, getFollowersList);
router.get("/:username/following", protect, getFollowingList);
router.get("/:username/replies", protect, getReplies);
router.get("/:profileId/reposts", protect, getReposts);
router.get("/:username", protect, getUserProfile);

export default router;