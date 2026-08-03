import express from "express";
import { rateLimit } from "express-rate-limit";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveAccount } from "../middleware/featureGate.js";
import { getUserGroups } from "../controllers/chatController.js";
import {
  addGroupMembers,
  createGroup,
  getGroup,
  getGroupMembers,
  leaveGroup,
  removeGroupMember,
  setGroupMemberBan,
  updateGroup,
  updateGroupMember,
} from "../controllers/groupController.js";

const router = express.Router();

// Keyed on the authenticated user, not req.ip: `protect` runs first on every
// route these are attached to, and an IP key spends one carrier-NAT user's
// budget on everyone behind it.
const byUser = (req) => req.user?.id ?? req.ip;

/*
 * Membership changes are the abuse-shaped ones — adding people is a fan-out
 * primitive and role churn is a way to spam every member's socket. Reads are
 * left alone; a member list is cheap and the page fetches it on open.
 */
const manageRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: byUser,
  message: "Too many group changes, please slow down",
  standardHeaders: true,
  legacyHeaders: false,
});

// Literal path first: "/user" would otherwise be captured by "/:groupId".
router.get("/user", protect, getUserGroups);

router.post("/", protect, requireActiveAccount, manageRateLimit, createGroup);

router.get("/:groupId", protect, getGroup);
router.get("/:groupId/members", protect, getGroupMembers);

// Writes need an active account for the same reason messaging does: suspending
// someone shouldn't leave them able to rename a group or evict its members.
router.patch("/:groupId", protect, requireActiveAccount, manageRateLimit, updateGroup);
router.post("/:groupId/members", protect, requireActiveAccount, manageRateLimit, addGroupMembers);
router.patch("/:groupId/members/:userId", protect, requireActiveAccount, manageRateLimit, updateGroupMember);
router.delete("/:groupId/members/:userId", protect, requireActiveAccount, manageRateLimit, removeGroupMember);
// Ban and unban are one endpoint taking `{banned}`, so the caller states the
// state it wants rather than toggling — a retried request can't flip a ban back.
router.put("/:groupId/members/:userId/ban", protect, requireActiveAccount, manageRateLimit, setGroupMemberBan);

// Leaving stays available to a suspended account — being unable to get out of
// a group is not a sanction anyone intended.
router.post("/:groupId/leave", protect, leaveGroup);

export default router;
