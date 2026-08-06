import crypto from "crypto";
import { HUMAN_ACCOUNT } from "../utils/botAccounts.js";
import fs from "fs";
import nodemailer from "nodemailer";

import admin from "firebase-admin";
import jwt from "jsonwebtoken";

import User from "../models/User.js";
import UserSession from "../models/UserSession.js";
import UserSettings from "../models/UserSettings.js";
import { sendWelcomeNotification } from "./notificationController.js";
import { DEFAULT_AVATAR_URL } from "../utils/constants.js";
import { countryUpdate } from "../utils/geo.js";
import { generateAvailableUsername } from "../utils/username.js";
import { JWT_VERIFY_OPTIONS } from "../config/jwt.js";

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

/*
 * Multi-account sessions.
 *
 * Instagram-style switching needs a live session per account on this device,
 * not just the one. The refresh token stays where it belongs — an httpOnly
 * cookie the page's JavaScript can't read — so instead of one cookie there is
 * one *per account*: `rt_<userId>`. Switching is then the server reading the
 * cookie for the account you asked for and minting a fresh access token from
 * it. Nothing that could be stolen by XSS ever reaches localStorage; the list
 * the client keeps is names and avatars, and it is not what authorises
 * anything.
 *
 * Scoped to /auth so they ride only on the four routes that read them.
 * Otherwise five signed-in accounts would attach five refresh tokens to every
 * image request and API call on the site.
 */
const ACCOUNT_COOKIE_PREFIX = "rt_";
const ACCOUNT_COOKIE_PATH = "/auth";
// Mirrors MAX_ACCOUNTS in frontend/src/lib/accounts.js.
const MAX_SWITCHABLE_ACCOUNTS = 5;

const accountCookieName = (userId) => `${ACCOUNT_COOKIE_PREFIX}${userId}`;

const getAccountCookieOptions = () => ({
  ...getRefreshTokenCookieOptions(),
  path: ACCOUNT_COOKIE_PATH,
});

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
/**
 * A browser's own id, so a session row means "this account on this device".
 *
 * The client mints one and keeps it; a request without the header gets a
 * random one, which simply means that sign-in occupies a row of its own until
 * the TTL reaps it. Either way it is *not* a credential — it names a device,
 * it doesn't authorise anything, and forging one buys nothing.
 */
const requestDeviceId = (req) => {
  const header = req?.headers?.["x-device-id"];
  if (typeof header === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(header)) return header;
  return `srv_${crypto.randomBytes(12).toString("hex")}`;
};

/**
 * Store a refresh token in UserSession (hash only — never plaintext).
 *
 * The filter has to include a real device id. It used to be
 * `{ user, deviceId: null }` while nothing ever set a device id, so the upsert
 * always matched the account's single existing row and overwrote it — one
 * session per user across every device they owned. Signing in on a phone
 * silently logged out the laptop, and with account switching that fires on
 * every switch. The unique {user, deviceId} index gives the intended "one
 * session per account per device" once the id is actually populated.
 */
const storeRefreshToken = async (userId, refreshToken, deviceId) => {
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
  const tokenHash = hashToken(refreshToken);

  /*
   * Never let the filter go device-less. Mongoose strips undefined keys, so a
   * caller that forgot to pass one would silently turn this into
   * `{ user }` — matching *any* session the account has anywhere and
   * overwriting it. That is exactly the bug this function was rewritten to
   * fix, and it fails invisibly, so it gets a guard rather than a comment.
   */
  const device =
    typeof deviceId === "string" && deviceId
      ? deviceId
      : `srv_${crypto.randomBytes(12).toString("hex")}`;

  await UserSession.findOneAndUpdate(
    { user: userId, deviceId: device },
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

/**
 * @param {object} [options]
 * @param {boolean} [options.makeActive] whether this account becomes the one
 *        the shared `refreshToken` cookie points at. False when merely
 *        refreshing a background account: otherwise the pointer drifts to
 *        "whoever refreshed last", and logout then compares the wrong tokens.
 */
const issueAuthTokens = async (userId, res, { makeActive = true, deviceId } = {}) => {
  const token = createAccessToken(userId);
  const refreshToken = createRefreshToken(userId);

  await storeRefreshToken(userId, refreshToken, deviceId);

  /*
   * Two cookies, same token. `refreshToken` marks the account that is
   * currently active — it is what a client with no idea about switching
   * (or an older tab) falls back to. `rt_<id>` is the per-account copy that
   * survives switching away and back.
   */
  if (makeActive) {
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, getRefreshTokenCookieOptions());
  }
  res.cookie(accountCookieName(userId), refreshToken, getAccountCookieOptions());

  return token;
};

/**
 * Reads and validates the stored session for one account on this device.
 *
 * Four things have to hold, and each of them is a way a stale switcher entry
 * goes wrong in practice: the cookie exists, the JWT verifies and is a
 * *refresh* token for that exact account, a matching un-expired session row
 * still exists (so a "log out everywhere" really did), and the account is
 * still usable.
 *
 * @returns {Promise<{user: object, refreshToken: string}|null>}
 */
const readAccountSession = async (req, userId) => {
  const refreshToken = req.cookies?.[accountCookieName(userId)];
  if (!refreshToken) return null;

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
  } catch {
    return null;
  }

  // The cookie name is attacker-controllable in the sense that anyone can set
  // a cookie; the signature and this check are what make it meaningless to.
  if (decoded.typ !== "refresh" || String(decoded.id) !== String(userId)) return null;

  const session = await UserSession.findOne({
    refreshTokenHash: hashToken(refreshToken),
    refreshTokenExpiresAt: { $gt: new Date() },
  }).lean();
  if (!session || session.revokedAt) return null;

  const user = await User.findById(decoded.id).select(
    "username name email profilePic bio link isPrivate isVerified role counts accountStatus",
  );
  // Same rule as the auth middleware: deleted and deactivated accounts can't
  // be signed into. A suspension is handled per-route, so it stays switchable.
  if (!user || ["deleted", "deactivated"].includes(user.accountStatus)) return null;

  return { user, refreshToken };
};

/** Every account id that has a cookie on this device, valid or not. */
const cookieAccountIds = (req) =>
  Object.keys(req.cookies || {})
    .filter((name) => name.startsWith(ACCOUNT_COOKIE_PREFIX))
    .map((name) => name.slice(ACCOUNT_COOKIE_PREFIX.length))
    // A cookie name is free-form; only look up things shaped like an id.
    .filter((id) => /^[a-f\d]{24}$/i.test(id));

const sessionPayload = (user, token) => ({
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

/*
 * Was a local loop appending 1, 2, 3… to the email's local part. Two problems:
 * it fed that part to the schema unsanitised, so "first.last@…" threw a
 * validation error at signup, and it happily handed out reserved names like
 * "support". generateAvailableUsername does both checks.
 */
const generateUniqueUsername = (baseUsername) => generateAvailableUsername(baseUsername);

/**
 * Records where this sign-in came from.
 *
 * Deliberately not awaited. Resolving the country can involve an outbound IP
 * lookup, and nobody should wait three seconds to log in — let alone fail to —
 * so that a profile row can be filled.
 */
const recordSignInCountry = (req, userId) => {
  countryUpdate(req)
    .then((update) => {
      if (!update) return undefined;
      return User.updateOne({ _id: userId }, { $set: update });
    })
    .catch((error) => console.error("recordSignInCountry error:", error));
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

    /*
     * Humans only — and this one is load-bearing now that bots share their owner's address.
     *
     * Without the filter, `findOne` could return a *bot* row for an address a human already
     * uses. The branch below then reads `googleId` and `password` off it, finds neither, and
     * falls through to "User already exists" — which is the right answer by accident. The
     * wrong answer was one refactor away: any change that treats a passwordless row as an
     * account to attach credentials to would have been attaching them to somebody's bot.
     */
    const existingUser = await User.findOne({ email, ...HUMAN_ACCOUNT }).select(
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

        const token = await issueAuthTokens(existingUser._id, res, {
          deviceId: requestDeviceId(req),
        });
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

    recordSignInCountry(req, newUser._id);

    const token = await issueAuthTokens(newUser._id, res, {
      deviceId: requestDeviceId(req),
    });
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

    /*
     * `HUMAN_ACCOUNT` is part of the query, so a bot account is simply not found.
     *
     * A bot row has no password. Without this, logging in with a bot's username found the
     * row, fell past the OAuth branch below (a bot has no `googleId` either), and reached
     * `comparePassword` with `undefined` — which throws into the 500 handler. That is both
     * fragile and an enumeration oracle: a 500 for bot usernames and a 400 for everything
     * else tells an attacker which accounts are bots through a channel that is meant to be
     * uniform.
     */
    const query = { ...HUMAN_ACCOUNT };
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

    recordSignInCountry(req, user._id);

    const token = await issueAuthTokens(user._id, res, {
      deviceId: requestDeviceId(req),
    });

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

    /*
     * A Google identity can never attach to a bot row.
     *
     * This is the sharpest of the four: if a bot ever carried an email, signing in with
     * Google using that address would find the bot, attach `googleId` to it, and issue a
     * human session *for the bot account* — handing the persona's identity to whoever
     * controls the mailbox. The filter makes it a miss, so the branch below creates a
     * separate human account instead.
     */
    let user = await User.findOne({ email, ...HUMAN_ACCOUNT }).select("+googleId");
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

    recordSignInCountry(req, user._id);

    const token = await issueAuthTokens(user._id, res, {
      deviceId: requestDeviceId(req),
    });

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

    /*
     * Bots excluded here too, even though a bot has no email to be found by.
     *
     * "It can't happen" is a property of today's creation flow, not of this endpoint. If a
     * bot ever gains an email — an owner-set contact address, a migration, a future
     * feature — this line is what stops a password reset minting a session for an account
     * that is not supposed to have one.
     */
    const user = await User.findOne({ email, ...HUMAN_ACCOUNT });
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
      ...HUMAN_ACCOUNT,
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
    /*
     * The client sends the account it believes is signed in. Without that this
     * would always refresh whoever the `refreshToken` cookie last pointed at —
     * so after switching to B, an older tab still showing A would silently be
     * handed B's session. Falls back to the shared cookie for clients that
     * predate switching.
     */
    const requestedId = req.body?.accountId;
    const accountCookie = requestedId ? req.cookies?.[accountCookieName(requestedId)] : null;
    const sharedCookie = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    const refreshToken = accountCookie || sharedCookie;

    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token missing" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
    } catch {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    /*
     * If the client named an account, the token had better belong to it. This
     * is what stops the fallback above from quietly upgrading tab A into a
     * session for account B.
     */
    if (requestedId && String(decoded.id) !== String(requestedId)) {
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

    const token = await issueAuthTokens(user._id, res, {
      /*
       * A background account refreshing must not become "the active account".
       * Only a refresh that came through the shared cookie — i.e. was already
       * the active one — is allowed to rewrite that pointer.
       */
      makeActive: refreshToken === sharedCookie,
      deviceId: requestDeviceId(req),
    });
    // The id goes back so the client can assert it got what it asked for.
    return res.status(200).json({ token, accountId: user._id });
  } catch (error) {
    console.error("refreshAccessToken error:", error);
    return res.status(500).json({ error: "Failed to refresh token" });
  }
};

/**
 * POST /auth/logout — signs one account out of this device.
 *
 * `accountId` names which; without it, the active one. The distinction is the
 * whole point of the switcher: logging out of a second account must leave the
 * others signed in, and must make the one you left un-switchable rather than
 * just hidden — so the session row goes and the cookie is cleared, not merely
 * dropped from a list in localStorage.
 */
export const logoutUser = async (req, res) => {
  try {
    const activeToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    const rawId = req.body?.accountId;
    const requestedId = /^[a-f\d]{24}$/i.test(String(rawId || "")) ? String(rawId) : null;
    const accountToken = requestedId ? req.cookies?.[accountCookieName(requestedId)] : null;

    /*
     * No falling back to the active account. This used to be
     * `accountToken || activeToken`, so asking to sign out account X whose
     * cookie had already been pruned would sign out whoever was *currently*
     * signed in instead — the client asks for one account and loses another.
     * A missing cookie means that account is already signed out here.
     */
    const target = requestedId ? accountToken : activeToken;

    let loggedOutId = requestedId || null;
    if (typeof target === "string" && target) {
      try {
        const decoded = jwt.verify(target, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
        loggedOutId = decoded?.id || loggedOutId;
      } catch {
        // An unverifiable token still gets its cookie cleared below.
      }
      // By hash, so only this device's session dies — other devices keep theirs.
      await UserSession.deleteOne({ refreshTokenHash: hashToken(target) });
    }

    const baseOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    };

    if (loggedOutId) {
      res.clearCookie(accountCookieName(loggedOutId), {
        ...baseOptions,
        path: ACCOUNT_COOKIE_PATH,
      });
    }

    /*
     * Only clear the shared "active account" pointer when it is the account
     * being logged out. Clearing it while signing out a *different* account
     * would sign the current one out too.
     */
    /*
     * Only clear the shared pointer when it really is this account's. Comparing
     * the raw tokens is exact — the two cookies hold the same string for the
     * active account and diverge for any other.
     */
    const activeIsTarget = !requestedId || (Boolean(activeToken) && activeToken === target);
    if (activeIsTarget) res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, baseOptions);

    return res.status(200).json({ message: "Logged out successfully", accountId: loggedOutId });
  } catch (error) {
    console.error("logoutUser error:", error);
    return res.status(500).json({ error: "Failed to logout" });
  }
};

/**
 * GET /auth/accounts — which accounts can be switched to from this device.
 *
 * The client keeps its own list for instant rendering, but that list is names
 * and avatars and it goes stale in ways only the server knows about: the
 * session expired, someone signed out everywhere, an admin revoked it, the
 * account was deleted. This is the authority, and it prunes the cookies it
 * finds dead along the way.
 */
export const listAccounts = async (req, res) => {
  try {
    const ids = cookieAccountIds(req);
    if (!ids.length) return res.status(200).json({ accounts: [] });

    const results = await Promise.all(
      ids.map(async (id) => ({ id, session: await readAccountSession(req, id) })),
    );

    const accounts = [];
    for (const { id, session } of results) {
      if (!session) {
        // Dead cookie — clear it so it stops being sent and stops being asked
        // about on every open of the switcher.
        res.clearCookie(accountCookieName(id), {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
          path: ACCOUNT_COOKIE_PATH,
        });
        continue;
      }
      const { user } = session;
      /*
       * The cap is enforced here as well as in the client's list — the cookies
       * are what actually make an account switchable, so a client that ignored
       * the limit would otherwise keep a sixth alive.
       */
      if (accounts.length >= MAX_SWITCHABLE_ACCOUNTS) {
        res.clearCookie(accountCookieName(id), {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
          path: ACCOUNT_COOKIE_PATH,
        });
        continue;
      }
      accounts.push({
        id: user._id,
        username: user.username,
        name: user.name || "",
        profilePic: user.profilePic,
        isVerified: Boolean(user.isVerified),
      });
    }

    return res.status(200).json({ accounts });
  } catch (error) {
    console.error("listAccounts error:", error);
    return res.status(500).json({ error: "Failed to load accounts" });
  }
};

/**
 * POST /auth/switch — become another account already signed in on this device.
 *
 * Not behind `protect`: you may be switching *away from* a session that has
 * just expired, which is exactly when you most want to. The authorisation is
 * the target account's own refresh cookie — proof that this browser completed
 * a real sign-in for it and hasn't been signed out since.
 */
export const switchAccount = async (req, res) => {
  try {
    const { accountId } = req.body || {};
    if (!accountId || !/^[a-f\d]{24}$/i.test(String(accountId))) {
      return res.status(400).json({ error: "accountId is required" });
    }

    const session = await readAccountSession(req, accountId);
    if (!session) {
      // Deliberately the same answer for "no cookie", "expired", "revoked" and
      // "no such account": a switch endpoint shouldn't confirm who exists.
      return res.status(401).json({ error: "Please log in to this account again" });
    }

    // Rotate, exactly as a refresh does — the token that got us here is spent.
    await UserSession.deleteOne({ refreshTokenHash: hashToken(session.refreshToken) });

    recordSignInCountry(req, session.user._id);
    const token = await issueAuthTokens(session.user._id, res, {
      deviceId: requestDeviceId(req),
    });

    return res.status(200).json({
      message: "Switched account",
      ...sessionPayload(session.user, token),
    });
  } catch (error) {
    console.error("switchAccount error:", error);
    return res.status(500).json({ error: "Failed to switch account" });
  }
};
