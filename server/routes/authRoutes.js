import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  signupUser,
  verifyOtp,
  resendOtp,
  loginUser,
  googleLogin,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  logoutUser,
  listAccounts,
  switchAccount,
  listSessions,
  revokeSession,
  logoutOtherDevices,
  logoutAllDevices,
} from "../controllers/authController.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireRegistrationsOpen } from "../middleware/featureGate.js";
import { isAllowedOrigin } from "../config/origins.js";

const router = Router();

/*
 * A CSRF guard for the state-changing auth routes.
 *
 * In production the session cookies are SameSite=none — they have to be, the
 * app and the API are on different origins — which means any site can make the
 * browser send them. A cross-site POST to /auth/logout was a *simple* request
 * needing no preflight, so any page could sign a visitor out; with account
 * switching that got worse, because logout now also revokes the session and
 * makes the account un-switchable.
 *
 * Browsers set Origin on every POST and can't be talked out of it, so
 * requiring it to be one of ours is enough. A missing Origin means a
 * same-origin or non-browser caller, which CORS wasn't protecting anyway.
 */
export const sameOriginOnly = (req, res, next) => {
  const origin = req.get("origin");
  if (!origin) return next();

  if (isAllowedOrigin(origin)) return next();

  return res.status(403).json({ error: "Cross-origin request rejected" });
};

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many accounts created, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotPasswordLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many reset requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

/*
 * The real budget lives on the `PendingSignup` row: five wrong codes for the life
 * of that row, whatever it is resent, plus five sends. These are the per-IP
 * budgets on top, and they exist for a different attacker — one holding many
 * tickets rather than hammering one.
 *
 * Deliberately loose enough not to punish a real person. Someone mistyping a code
 * on a phone and then asking for a new one uses maybe six requests; the row's own
 * counters stop them long before these do.
 */
const otpVerifyLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const otpResendLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many codes requested, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// All state-changing auth endpoints use `sameOriginOnly` to prevent cross-site CSRF/Origin attacks
router.post("/signup", sameOriginOnly, signupLimit, requireRegistrationsOpen, signupUser);
router.post("/verify-otp", sameOriginOnly, otpVerifyLimit, verifyOtp);
router.post("/resend-otp", sameOriginOnly, otpResendLimit, resendOtp);
router.post("/login", sameOriginOnly, loginLimit, loginUser);
router.post("/googlelogin", sameOriginOnly, loginLimit, googleLogin);
router.post("/forgot-password", sameOriginOnly, forgotPasswordLimit, forgotPassword);
router.post("/reset-password", sameOriginOnly, forgotPasswordLimit, resetPassword);
router.post("/refresh", sameOriginOnly, refreshAccessToken);
router.post("/logout", sameOriginOnly, logoutUser);
router.post("/logout-others", protect, sameOriginOnly, logoutOtherDevices);
router.post("/logout-all", protect, sameOriginOnly, logoutAllDevices);

// Session management (listing active devices and revoking specific sessions)
router.get("/sessions", protect, listSessions);
router.delete("/sessions/:sessionId", protect, sameOriginOnly, revokeSession);

// Multi-account. Both read the per-account refresh cookies, so they must live
// under /auth — that's the path those cookies are scoped to.
router.get("/accounts", sameOriginOnly, listAccounts);
/*
 * Rate limited like a login, because that is what it is: an attempt to obtain
 * a session for a named account. It needs a valid cookie to succeed, but the
 * limiter keeps it from being used to probe which ids this browser holds.
 */
const switchLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Its own bucket. Sharing the login limiter meant a few taps between
  // accounts locked the user out of logging in as well.
  max: 40,
  message: { error: "Too many account switches, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/switch", sameOriginOnly, switchLimit, switchAccount);

export default router;
