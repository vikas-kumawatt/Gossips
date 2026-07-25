import crypto from "crypto";
import fs from "fs";
import nodemailer from "nodemailer";

import admin from "firebase-admin";
import jwt from "jsonwebtoken";

import User from "../models/User.js";
import UserSession from "../models/UserSession.js";
import UserSettings from "../models/UserSettings.js";
import { sendWelcomeNotification } from "./notificationController.js";
import { DEFAULT_AVATAR_URL } from "../utils/constants.js";

if (!process.env.BREVO_EMAIL || !process.env.BREVO_SMTP_KEY || !process.env.SMTP_USER) {
  throw new Error(
    `Missing required Brevo env vars: ${[
      !process.env.BREVO_EMAIL && "BREVO_EMAIL",
      !process.env.BREVO_SMTP_KEY && "BREVO_SMTP_KEY",
      !process.env.SMTP_USER && "SMTP_USER",
    ]
      .filter(Boolean)
      .join(", ")}`,
  );
}

const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.BREVO_SMTP_KEY,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

transporter.verify((error) => {
  if (error) {
    console.error("Brevo SMTP verification failed:", {
      message: error.message,
      code: error.code,
    });
  } else {
    console.log("Brevo SMTP ready");
  }
});

const serviceAccountKey = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountKey),
});

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_DAYS = 7;
const REFRESH_TOKEN_COOKIE_NAME = "refreshToken";

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const getRefreshTokenCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
});

// The two tokens share a secret, so without a type claim a refresh token would
// authenticate every protected route for its full lifetime — which would let a
// user walk straight past a suspension or a forced sign-out.
const createAccessToken = (userId) =>
  jwt.sign({ id: userId, typ: "access" }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });

const createRefreshToken = (userId) =>
  jwt.sign({ id: userId, typ: "refresh" }, process.env.JWT_SECRET, {
    expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d`,
  });

/**
 * Store a refresh token in UserSession (hash only — never plaintext).
 * If a stale session with the same hash exists, replace it.
 */
const storeRefreshToken = async (userId, refreshToken, deviceId = null) => {
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
  const tokenHash = hashToken(refreshToken);

  await UserSession.findOneAndUpdate(
    { user: userId, deviceId: deviceId ?? null },
    {
      $set: {
        refreshTokenHash: tokenHash,
        refreshTokenExpiresAt: expiresAt,
        lastActiveAt: new Date(),
        isCurrent: true,
        revokedAt: null,
      },
    },
    { upsert: true, new: true },
  );
};

const issueAuthTokens = async (userId, res) => {
  const token = createAccessToken(userId);
  const refreshToken = createRefreshToken(userId);

  await storeRefreshToken(userId, refreshToken);
  res.cookie(
    REFRESH_TOKEN_COOKIE_NAME,
    refreshToken,
    getRefreshTokenCookieOptions(),
  );

  return token;
};

const generateUniqueUsername = async (baseUsername) => {
  let username = baseUsername;
  let count = 1;
  while (await User.findOne({ username })) {
    username = `${baseUsername}${count}`;
    count++;
  }
  return username;
};

// ── Validators (kept local, no library dependency) ───────────────────────────
const EMAIL_RE = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
const PASSWORD_RE = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/;
const PASSWORD_MSG =
  "Password must be 6–20 characters and contain at least one digit, one uppercase, and one lowercase letter";

// ── Auth handlers ─────────────────────────────────────────────────────────────

export const signupUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // `email` reaches a filter, and this branch can hand back a session for a
    // Google-linked account — a non-string here would be account takeover.
    if (typeof email !== "string" || !email) {
      return res.status(400).json({ message: "Invalid email" });
    }

    const existingUser = await User.findOne({ email }).select(
      "+googleId +password",
    );

    // Google-linked account adding a password for the first time
    if (existingUser) {
      if (existingUser.googleId && !existingUser.password) {
        if (!password || !PASSWORD_RE.test(password)) {
          return res.status(400).json({ message: PASSWORD_MSG });
        }
        existingUser.password = password; // pre-save hook hashes it
        existingUser.name = name || existingUser.name;
        await existingUser.save();

        const token = await issueAuthTokens(existingUser._id, res);
        return res.status(200).json({
          message: "Account updated successfully",
          id: existingUser._id,
          name: existingUser.name,
          email: existingUser.email,
          username: existingUser.username,
          profilePic: existingUser.profilePic,
          token,
        });
      }
      return res.status(400).json({ message: "User already exists" });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Please fill in all fields" });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }
    if (!PASSWORD_RE.test(password)) {
      return res.status(400).json({ message: PASSWORD_MSG });
    }

    const username = await generateUniqueUsername(email.split("@")[0]);

    const newUser = await User.create({
      name,
      email,
      password, // pre-save hook hashes it
      username,
      profilePic: DEFAULT_AVATAR_URL,
    });

    // Provision default settings row (1:1 with user)
    await UserSettings.create({ user: newUser._id });

    await sendWelcomeNotification(newUser._id);

    const token = await issueAuthTokens(newUser._id, res);
    return res.status(201).json({
      message: "User registered successfully",
      id: newUser._id,
      name: newUser.name,
      email: newUser.email,
      username: newUser.username,
      profilePic: newUser.profilePic,
      role: newUser.role,
      token,
    });
  } catch (error) {
    console.error("signupUser error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

export const loginUser = async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (!email && !username) {
      return res.status(400).json({ error: "Username or email is required" });
    }
    // Both are used as query filters.
    if ((email && typeof email !== "string") || (username && typeof username !== "string")) {
      return res.status(400).json({ error: "Invalid credentials" });
    }
    if (!password) {
      return res.status(400).json({ error: "Password is required" });
    }

    const query = {};
    if (email) query.email = email;
    if (username) query.username = username;

    // password is select:false — must be explicitly requested
    const user = await User.findOne(query).select("+password +googleId");

    if (!user) {
      return res
        .status(400)
        .json({ error: "User not found. Please register." });
    }

    if (user.googleId && !user.password) {
      return res.status(400).json({
        error: "Please set up a password first",
        needPasswordSetup: true,
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const token = await issueAuthTokens(user._id, res);

    res.status(200).json({
      message: "Login successful",
      id: user._id,
      name: user.name,
      email: user.email,
      username: user.username,
      profilePic: user.profilePic,
      bio: user.bio,
      link: user.link,
      isPrivate: user.isPrivate,
      isVerified: user.isVerified,
      role: user.role,
      counts: user.counts,
      token,
    });
  } catch (error) {
    console.error("loginUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const googleLogin = async (req, res) => {
  try {
    const { token: idToken } = req.body;
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    let { email, name, picture } = decodedToken;

    if (picture) {
      picture = picture.replace("s96-c", "s1024-c");
    }

    let user = await User.findOne({ email }).select("+googleId");
    let newUser = false;

    if (!user) {
      newUser = true;
      user = await User.create({
        name,
        email,
        googleId: decodedToken.uid,
        username: await generateUniqueUsername(email.split("@")[0]),
        profilePic: picture || DEFAULT_AVATAR_URL,
      });
      await UserSettings.create({ user: user._id });
    } else {
      // update googleId and profile pic in place
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            googleId: decodedToken.uid,
            profilePic: picture || user.profilePic,
          },
        },
      );
      user.profilePic = picture || user.profilePic;
    }

    const token = await issueAuthTokens(user._id, res);

    res.status(200).json({
      message: "Login successful",
      id: user._id,
      name: user.name,
      email: user.email,
      username: user.username,
      profilePic: user.profilePic,
      bio: user.bio,
      link: user.link,
      isPrivate: user.isPrivate,
      isVerified: user.isVerified,
      role: user.role,
      counts: user.counts,
      token,
      newUser,
    });
  } catch (error) {
    console.error("googleLogin error:", error);
    res.status(500).json({ error: "Google authentication failed" });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed, use POST" });
    }

    const { email } = req.body;
    if (typeof email !== "string" || !email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const genericResponse = {
      message: "If that email is registered, a reset link has been sent.",
    };

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(200).json(genericResponse);
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    if (!process.env.FRONTEND_URL) {
      throw new Error("FRONTEND_URL is not defined");
    }

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
    await transporter.sendMail({
      from: process.env.BREVO_EMAIL,
      to: email,
      subject: "Reset Your Gossips Password",
      html: `
        <div style="margin:0;padding:0;background-color:#fafafa;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;padding:40px 16px;">
            <tr>
              <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:460px;">

                  <!-- Logo + brand name above card -->
                  <tr>
                    <td align="center" style="padding-bottom:20px;">
                      <img
                        src="${process.env.FRONTEND_URL}/images/logo-light.png"
                        alt="Gossips"
                        width="52"
                        height="52"
                        style="display:block;margin:0 auto 10px;border-radius:12px;"
                      />
                      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:#1a1a1a;letter-spacing:-0.3px;">Gossips</div>
                    </td>
                  </tr>

                  <!-- Card -->
                  <tr>
                    <td style="background:#ffffff;border:1px solid #dbdbdb;border-radius:4px;padding:36px 32px;">
                      <table width="100%" cellpadding="0" cellspacing="0" border="0">

                        <!-- Heading -->
                        <tr>
                          <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:600;color:#1a1a1a;padding-bottom:14px;">
                            Reset your password
                          </td>
                        </tr>

                        <!-- Body text -->
                        <tr>
                          <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;color:#737373;line-height:1.75;padding-bottom:24px;">
                            We got a request to reset your <strong style="color:#1a1a1a;">Gossips</strong> password. Click the button below to create a new one.
                          </td>
                        </tr>

                        <!-- CTA Button -->
                        <tr>
                          <td style="padding-bottom:24px;">
                            <a
                              href="${resetUrl}"
                              style="display:inline-block;background:#000000;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;"
                            >
                              Reset password
                            </a>
                          </td>
                        </tr>

                        <!-- Divider -->
                        <tr>
                          <td style="padding-bottom:18px;">
                            <div style="height:1px;background:#efefef;"></div>
                          </td>
                        </tr>

                        <!-- Expiry + ignore note -->
                        <tr>
                          <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#8e8e8e;line-height:1.7;padding-bottom:18px;">
                            This link expires in <strong style="color:#737373;">1 hour</strong>. If you didn't request this, you can safely ignore this email — your password won't change.
                          </td>
                        </tr>

                        <!-- Fallback link -->
                        <tr>
                          <td style="background:#fafafa;border:1px solid #efefef;border-radius:6px;padding:14px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;color:#8e8e8e;word-break:break-all;line-height:1.65;">
                            <strong style="color:#737373;">Can't click the button?</strong> Copy this link into your browser:<br/><br/>
                            <a href="${resetUrl}" style="color:#1a1a1a;text-decoration:none;">${resetUrl}</a>
                          </td>
                        </tr>

                      </table>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td align="center" style="padding-top:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;color:#a8a8a8;line-height:1.6;">
                      &copy; ${new Date().getFullYear()} Gossips &middot; All rights reserved
                    </td>
                  </tr>

                </table>
              </td>
            </tr>
          </table>
        </div>
      `,
    });

    res.status(200).json(genericResponse);
  } catch (error) {
    console.error("forgotPassword error:", error.code ?? error.name);
    res.status(500).json({ error: "Failed to send reset link" });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    // Belt-and-braces behind sanitizeMongo: this value goes straight into a
    // filter, and a non-string here would match an arbitrary live reset token.
    if (typeof token !== "string" || !token) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    if (!PASSWORD_RE.test(password)) {
      return res.status(400).json({ message: PASSWORD_MSG });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    user.password = password; // pre-save hook hashes it
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Revoke all existing sessions on password reset (security best practice)
    await UserSession.deleteMany({ user: user._id });

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("resetPassword error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
};

export const refreshAccessToken = async (req, res) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token missing" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const tokenHash = hashToken(refreshToken);
    const session = await UserSession.findOne({
      refreshTokenHash: tokenHash,
      refreshTokenExpiresAt: { $gt: new Date() },
    });

    if (!session) {
      return res
        .status(401)
        .json({ message: "Refresh token expired or revoked" });
    }

    // Rotate: delete old session, issue new tokens
    await UserSession.deleteOne({ _id: session._id });

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    const token = await issueAuthTokens(user._id, res);
    return res.status(200).json({ token });
  } catch (error) {
    console.error("refreshAccessToken error:", error);
    return res.status(500).json({ error: "Failed to refresh token" });
  }
};

export const logoutUser = async (req, res) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];

    if (refreshToken) {
      let decoded = null;
      try {
        decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
      } catch {
        decoded = null;
      }

      if (decoded?.id) {
        const tokenHash = hashToken(refreshToken);
        await UserSession.deleteOne({ refreshTokenHash: tokenHash });
      }
    }

    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });
    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("logoutUser error:", error);
    return res.status(500).json({ error: "Failed to logout" });
  }
};
