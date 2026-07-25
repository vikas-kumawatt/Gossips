import { Router } from "express";
import {
  cancelScheduled,
  getScheduled,
  publishScheduledNow,
  rescheduleItem,
} from "../controllers/scheduleController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = Router();

// Everything here is the caller's own scheduled content — ownership is
// enforced in the controller by filtering on `author`.
router.get("/", protect, getScheduled);
router.patch("/:type/:id", protect, rescheduleItem);
router.post("/:type/:id/publish", protect, publishScheduledNow);
router.delete("/:type/:id", protect, cancelScheduled);

export default router;
