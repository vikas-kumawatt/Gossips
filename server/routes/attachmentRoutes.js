import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getPoll, voteInPoll } from "../controllers/pollController.js";
import { reverseGeocode, searchPlaces } from "../controllers/placeController.js";
import { optionalProtect, protect } from "../middleware/authMiddleware.js";

const router = Router();

/*
 * Nominatim's usage policy allows about one request a second for the whole
 * application, and the composer searches as you type. The debounce and the
 * day-long cache do most of the work; this is the backstop that keeps one
 * user from getting the whole app blocked.
 */
const placeLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  // Keyed by account, not IP: one user behind a shared NAT shouldn't burn
  // everyone's budget, and many IPs shouldn't multiply one user's.
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { success: false, error: { message: "Slow down a moment" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Voting is cheap but a poll is a target for automation, so cap the rate.
const voteLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { success: false, error: { message: "Slow down a moment" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// type is "post" or "comment"
router.post("/polls/:type/:id/vote", protect, voteLimit, voteInPoll);
router.get("/polls/:type/:id", optionalProtect, getPoll);

router.get("/places/search", protect, placeLimit, searchPlaces);
router.get("/places/reverse", protect, placeLimit, reverseGeocode);

export default router;
