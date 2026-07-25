import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  signupUser,
  loginUser,
  googleLogin,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  logoutUser,
} from "../controllers/authController.js";
import { requireRegistrationsOpen } from "../middleware/featureGate.js";

const router = Router();

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

router.post("/signup", signupLimit, requireRegistrationsOpen, signupUser);
router.post("/login", loginLimit, loginUser);
router.post("/googlelogin", loginLimit, googleLogin);
router.post("/forgot-password", forgotPasswordLimit, forgotPassword);
// Same limiter as forgot-password: this endpoint is a token-guessing oracle
// otherwise, and it was the only auth route without one.
router.post("/reset-password", forgotPasswordLimit, resetPassword);
router.post("/refresh", refreshAccessToken);
router.post("/logout", logoutUser);

export default router;
