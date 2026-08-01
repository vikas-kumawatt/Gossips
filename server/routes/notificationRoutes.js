import { Router } from "express";
import {
  getUserNotifications,
  getUnreadNotificationCount,
  markAllNotificationsAsRead,
} from "../controllers/notificationController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/notifications", protect, getUserNotifications);
router.get("/unread-count", protect, getUnreadNotificationCount);
router.put("/mark-all-read", protect, markAllNotificationsAsRead);

export default router;