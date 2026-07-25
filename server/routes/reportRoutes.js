import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  createPlatformReport,
  createReport,
  getReportStatus,
} from "../controllers/reportController.js";
import { optionalProtect, protect } from "../middleware/authMiddleware.js";
import upload from "../config/multerConfig.js";

const router = Router();

const reportLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20, // 20 reports per 10 minutes
  message: "Too many reports, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /reports/status — whether the caller has already reported this target
router.get("/status", protect, getReportStatus);

// POST /reports — report a post, comment, message, conversation or account
router.post("/", protect, reportLimit, createReport);

// POST /reports/platform — submit a platform-level problem report (auth optional)
router.post("/platform", optionalProtect, upload.single("screenshot"), createPlatformReport);

export default router;
