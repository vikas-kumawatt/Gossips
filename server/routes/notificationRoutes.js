import { Router } from "express";
import { getUserNotifications, markAllNotificationsAsRead } from "../controllers/notificationController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/notifications", protect, getUserNotifications);
router.put("/mark-all-read", protect, markAllNotificationsAsRead);

export default router;