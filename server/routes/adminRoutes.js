import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { protect } from "../middleware/authMiddleware.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/adminMiddleware.js";
import {
  getAdminSession,
  listUsers,
  getUserDetail,
  suspendUser,
  unsuspendUser,
  setVerification,
  setUserRole,
  forceLogout,
  listContent,
  removeContent,
  listReports,
  getReportDetail,
  updateReportStatus,
  listPlatformReports,
  updatePlatformReportStatus,
  readSettings,
  updateSettings,
  listAuditLog,
} from "../controllers/adminController.js";
import {
  getOverview,
  getGrowth,
  getEngagement,
  getModerationMetrics,
  getRetention,
} from "../controllers/adminMetricsController.js";

const router = Router();

// Aggregations are expensive; a stuck dashboard shouldn't be able to hammer them.
const adminLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  message: "Too many requests",
  standardHeaders: true,
  legacyHeaders: false,
});

// Everything below is staff-only. `protect` loads the live user document and
// `requireAdmin` reads the role from it, so a demotion takes effect at once.
router.use(protect, requireAdmin, adminLimit);

router.get("/session", getAdminSession);

// ── Metrics ────────────────────────────────────────────────────────────────
router.get("/metrics/overview", getOverview);
router.get("/metrics/growth", getGrowth);
router.get("/metrics/engagement", getEngagement);
router.get("/metrics/moderation", getModerationMetrics);
router.get("/metrics/retention", getRetention);

// ── Users ──────────────────────────────────────────────────────────────────
router.get("/users", listUsers);
router.get("/users/:username", getUserDetail);
router.post("/users/:username/suspend", suspendUser);
router.post("/users/:username/unsuspend", unsuspendUser);
router.post("/users/:username/verification", setVerification);
router.post("/users/:username/force-logout", forceLogout);
// Granting staff access is the one action an ordinary admin can't perform.
router.post("/users/:username/role", requireSuperAdmin, setUserRole);

// ── Content ────────────────────────────────────────────────────────────────
router.get("/content", listContent);
router.delete("/content/:type/:id", removeContent);

// ── Reports ────────────────────────────────────────────────────────────────
router.get("/reports", listReports);
router.get("/reports/:id", getReportDetail);
router.patch("/reports/:id/status", updateReportStatus);

// ── Platform (bug) reports ─────────────────────────────────────────────────
router.get("/platform-reports", listPlatformReports);
router.patch("/platform-reports/:id/status", updatePlatformReportStatus);

// ── Settings ───────────────────────────────────────────────────────────────
router.get("/settings", readSettings);
// Flags change how the whole app behaves — super admin only.
router.patch("/settings", requireSuperAdmin, updateSettings);

// ── Audit ──────────────────────────────────────────────────────────────────
router.get("/audit", listAuditLog);

export default router;
