import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { getUserGroups } from "../controllers/chatController.js";

const router = express.Router();

// Get user's groups
router.get("/user", protect, getUserGroups);

export default router;
