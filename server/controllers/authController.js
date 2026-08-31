import crypto from "crypto";
import { HUMAN_ACCOUNT } from "../utils/botAccounts.js";
import fs from "fs";
import nodemailer from "nodemailer";

import admin from "firebase-admin";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import PendingSignup from "../models/PendingSignup.js";
import User from "../models/User.js";
import UserSession from "../models/UserSession.js";
import UserSettings from "../models/UserSettings.js";
import { sendWelcomeNotification } from "./notificationController.js";
import { DEFAULT_AVATAR_URL } from "../utils/constants.js";
import { countryUpdate } from "../utils/geo.js";
import { generateAvailableUsername } from "../utils/username.js";
import {
  OTP_LENGTH,
  OTP_RE,
  generateOtp,
  otpMatches,
  hashOtp as hashOtpWith,
} from "../utils/otp.js";
import {
  JWT_VERIFY_OPTIONS,
  getAccessTokenSecret,
  getRefreshTokenSecret,
  getVerificationTicketSecret,
} from "../config/jwt.js";
import { revokeAccessToken } from "../utils/tokenRevocation.js";

/**
 * Outbound email, and why a missing configuration is no longer fatal.
 *
 * This module used to `throw` at import when any of the three Brevo variables
 * was absent. Because `server.js` imports the auth routes, that made SMTP
 * credentials a hard requirement for the process to start *at all* — so a
 * contributor cloning the repo to look at the feed, or a deployment that only
 * ever serves reads, needed a transactional email account before the server
 * would boot. The failure also arrived as a bare stack trace from an import,
 * which is the least legible moment for it to happen.
 *
 * Email is needed by exactly two flows — signup verification and password reset
 * — so the honest scope of "no SMTP configured" is that those two return an
 * error and everything else works. That is what this does: refuse at the point
 * of sending, with a message that says what is missing, and warn once at boot so
 * it is not a surprise.
 */
const MISSING_MAIL_VARS = [
  !process.env.BREVO_EMAIL && "BREVO_EMAIL",
  !process.env.BREVO_SMTP_KEY && "BREVO_SMTP_KEY",
  !process.env.SMTP_USER && "SMTP_USER",
].filter(Boolean);

export const mailConfigured = MISSING_MAIL_VARS.length === 0;

const transporter = mailConfigured
  ? nodemailer.createTransport({
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
    })
  : /*
     * A stand-in that rejects rather than a null that every call site has to
     * remember to check. The two senders already handle a failed send — signup
     * deletes the PendingSignup row and answers 502, forgot-password answers
     * generically — so they inherit correct behaviour without a new branch.
     */
    {
      sendMail: async () => {
        const error = new Error(
          `Email is not configured on this server (missing ${MISSING_MAIL_VARS.join(", ")})`
        );
        error.code = "EMAIL_NOT_CONFIGURED";
        throw error;
      },
    };

if (!mailConfigured) {
  console.warn(
    `Email disabled: missing ${MISSING_MAIL_VARS.join(", ")}. ` +
      "Signup verification and password reset will fail; everything else runs."
  );
} else {
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
}

const MISSING_FIREBASE_VARS = [
  !process.env.FIREBASE_PROJECT_ID && "FIREBASE_PROJECT_ID",
  !process.env.FIREBASE_PRIVATE_KEY && "FIREBASE_PRIVATE_KEY",
  !process.env.FIREBASE_CLIENT_EMAIL && "FIREBASE_CLIENT_EMAIL",
].filter(Boolean);

export const firebaseConfigured = MISSING_FIREBASE_VARS.length === 0;

if (firebaseConfigured) {
  try {
    const serviceAccountKey = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
    }
  } catch (error) {
    console.error("Firebase admin initialization failed:", error?.message);
  }
} else {
  console.warn(
    `Firebase disabled: missing ${MISSING_FIREBASE_VARS.join(", ")}. Google sign-in will fail; other auth routes run.`
  );
}

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
// Mirrors MAX_ACCOUNTS in frontend/src/lib/accounts.js (10 accounts).
const MAX_SWITCHABLE_ACCOUNTS = 10;

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

// Different token types use distinct derived secrets (cryptographic domain separation)
// so a signature from one type cannot verify against another.
const createAccessToken = (userId) =>
  jwt.sign({ id: userId, typ: "access" }, getAccessTokenSecret(), {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });

const createRefreshToken = (userId) =>
  jwt.sign({ id: userId, typ: "refresh" }, getRefreshTokenSecret(), {
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
        isTrusted: true,
        trustedAt: new Date(),
        revokedAt: null,
      },
    },
    { upsert: true, new: true },
  );

  // Enforce per-user active session cap: prune the oldest excess sessions
  try {
    const sessionCount = await UserSession.countDocuments({ user: userId });
    if (sessionCount > MAX_SESSIONS_PER_USER) {
      const excessCount = sessionCount - MAX_SESSIONS_PER_USER;
      const oldestSessions = await UserSession.find({ user: userId })
        .sort({ lastActiveAt: 1, createdAt: 1 })
        .limit(excessCount)
        .select("_id")
        .lean();

      if (oldestSessions.length > 0) {
        const oldestIds = oldestSessions.map((s) => s._id);
        await UserSession.deleteMany({ _id: { $in: oldestIds } });
      }
    }
  } catch (err) {
    console.error("storeRefreshToken: session cap enforcement error:", err?.message);
  }
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
    decoded = jwt.verify(refreshToken, getRefreshTokenSecret(), JWT_VERIFY_OPTIONS);
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
// ── Email verification (signup OTP) ──────────────────────────────────────────
/*
 * No account exists until the code is entered. The submitted name, email and
 * password live in `PendingSignup` — read the comment at the top of that model
 * before changing anything here, because the reason it is not a `User` row with
 * a flag on it is a security property, not a storage preference.
 */

const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses allowed per code, enforced atomically in `claimAttempt`. */
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_SENDS = 5;
/*
 * Outstanding attempts allowed for one address at a time.
 *
 * There has to be a cap — rows are keyed on email but not unique, so without one
 * an address is an unbounded write target. It is deliberately generous relative
 * to `signupLimit` (5/hour/IP), which is the real brake; this is here so that
 * many IPs cannot do together what one cannot do alone.
 */
const MAX_PENDING_PER_EMAIL = 5;
/** Maximum active device sessions allowed per user account before LRU eviction. */
const MAX_SESSIONS_PER_USER = 10;
/** Maximum consecutive failed password attempts before temporary account lockout. */
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
/** Duration of temporary lockout following repeated failed login attempts (15 minutes). */
const ACCOUNT_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
/*
 * Matches `maxlength` on `User.name` and `PendingSignup.name`. Checked in the
 * handler so an over-long name is a 400 the user can act on rather than a
 * ValidationError surfacing as a 500.
 */
const MAX_NAME_LENGTH = 200;
/*
 * Must match `BCRYPT_COST` in models/User.js. Not imported from there because it
 * isn't exported, and exporting it to be read here would suggest the two are free
 * to diverge — they are not: this hash is written straight into `User.password`,
 * so a different cost would silently produce accounts hashed unlike every other.
 */
const SIGNUP_BCRYPT_COST = 10;
/*
 * Matches `OTP_TTL_MS` (10 minutes). Each resend pushes the row's expiry out
 * another ten minutes and mints a fresh verification ticket, so the client and
 * database remain strictly synchronized and a user cannot sit on a stale ticket
 * after an OTP has expired.
 */
const VERIFICATION_TICKET_EXPIRY = "10m";

/*
 * Bound to `JWT_SECRET` here so `utils/otp.js` stays pure and testable — that
 * file cannot read the environment without becoming as untestable as this one.
 * Rotating the secret therefore invalidates every live code as well as every
 * live token, which is the correct behaviour for a rotation and worth knowing.
 */
const hashOtp = (pendingId, code) => hashOtpWith(process.env.JWT_SECRET, pendingId, code);

/**
 * The ticket that identifies a signup in progress.
 *
 * It is not a session and must never become one — see `isAccessToken` in config/jwt.js,
 * which is what stops it authenticating a protected route or a socket. All it names is a
 * `PendingSignup` row; on its own it grants nothing, because finishing still requires the
 * code that was mailed.
 *
 * `sid` and not `id`: every other token in this app carries a *user* id under `id`, and
 * these two kinds of token must not be confusable by any handler that reads a claim
 * without checking `typ` first.
 */
const createVerificationTicket = (pendingId, email) =>
  jwt.sign({ sid: String(pendingId), typ: "verify", email }, getVerificationTicketSecret(), {
    expiresIn: VERIFICATION_TICKET_EXPIRY,
  });

const readVerificationTicket = (token) => {
  if (typeof token !== "string" || !token) return null;
  try {
    const decoded = jwt.verify(token, getVerificationTicketSecret(), JWT_VERIFY_OPTIONS);
    // An access or refresh token presented here must not be usable as a ticket,
    // which is the mirror image of the bug `isAccessToken` fixes.
    if (decoded.typ !== "verify") return null;
    if (typeof decoded.email !== "string") return null;
    /*
     * `sid` goes straight into an `_id` filter, and a value that isn't an ObjectId
     * makes Mongoose throw a CastError rather than simply not match — which would
     * surface as a 500 from the verify endpoint instead of "that code expired".
     * Only reachable by someone who can mint tokens, but the same shape check the
     * account routes apply to ids costs a line here too.
     */
    if (!/^[a-f\d]{24}$/i.test(String(decoded.sid))) return null;
    return decoded;
  } catch {
    return null;
  }
};

const otpEmailHtml = (code) => `
  <div style="margin:0;padding:0;background-color:#fafafa;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;padding:40px 16px;">
      <tr>
        <td align="center">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:460px;">

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

            <tr>
              <td style="background:#ffffff;border:1px solid #dbdbdb;border-radius:4px;padding:36px 32px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">

                  <tr>
                    <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:600;color:#1a1a1a;padding-bottom:14px;">
                      Confirm your email
                    </td>
                  </tr>

                  <tr>
                    <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;color:#737373;line-height:1.75;padding-bottom:24px;">
                      Enter this code in <strong style="color:#1a1a1a;">Gossips</strong> to finish creating your account.
                    </td>
                  </tr>

                  <tr>
                    <td align="center" style="padding-bottom:24px;">
                      <div style="display:inline-block;background:#fafafa;border:1px solid #efefef;border-radius:10px;padding:18px 28px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:32px;font-weight:700;color:#1a1a1a;letter-spacing:10px;">${code}</div>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding-bottom:18px;">
                      <div style="height:1px;background:#efefef;"></div>
                    </td>
                  </tr>

                  <tr>
                    <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#8e8e8e;line-height:1.7;">
                      This code expires in <strong style="color:#737373;">10 minutes</strong>. If you didn't try to sign up, you can ignore this email — no account has been created, and none will be without this code.
                    </td>
                  </tr>

                </table>
              </td>
            </tr>

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
`;

const sendOtpEmail = (email, code) =>
  transporter.sendMail({
    from: process.env.BREVO_EMAIL,
    to: email,
    subject: `${code} is your Gossips verification code`,
    html: otpEmailHtml(code),
  });

/** The response body that sends a client to the OTP screen. */
const verificationPending = (pending) => ({
  requiresVerification: true,
  verificationToken: createVerificationTicket(pending._id, pending.email),
  email: pending.email,
  codeLength: OTP_LENGTH,
  expiresInSeconds: OTP_TTL_MS / 1000,
  resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
});

/**
 * Take one guess off a pending signup's budget, atomically.
 *
 * The filter is the check. Reading `attempts` and then comparing it would leave the
 * gate wide under concurrency — six parallel guesses all read 4, all decide they are
 * under the limit, and the budget becomes "five plus however many requests fit in one
 * round trip". Here the fifth `$inc` is the last one the filter admits, whatever the
 * concurrency.
 *
 * @returns {Promise<{row: object, attemptsLeft: number}|null>} null when the budget is spent.
 */
const claimAttempt = async (pendingId) => {
  const row = await PendingSignup.findOneAndUpdate(
    { _id: pendingId, attempts: { $lt: OTP_MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true },
  );
  if (!row) return null;
  return { row, attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts) };
};

/**
 * Replace a pending signup's code and mail the new one.
 *
 * Throttling is reported rather than thrown so the caller can decide; `sendOtpEmail`
 * still throws, because a code that was never delivered is a failure and not a state.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: "cooldown"|"exhausted", retryAfter?: number}>}
 */
const reissueOtp = async (pending) => {
  const sinceLast = Date.now() - new Date(pending.lastSentAt).getTime();
  if (sinceLast < OTP_RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      reason: "cooldown",
      retryAfter: Math.ceil((OTP_RESEND_COOLDOWN_MS - sinceLast) / 1000),
    };
  }
  if (pending.resendCount >= OTP_MAX_SENDS) {
    return { ok: false, reason: "exhausted" };
  }

  const code = generateOtp();

  /*
   * The cooldown is re-checked in the filter, so two clicks that arrive together
   * produce one email rather than two.
   *
   * Note what is *not* here: `attempts` is not reset. Resetting it reads as the
   * obvious thing — the budget belongs to the code, and this is a new code — but
   * it makes the guess budget `OTP_MAX_ATTEMPTS × OTP_MAX_SENDS` rather than
   * `OTP_MAX_ATTEMPTS`, and it is the attacker who decides when to resend. Five
   * guesses is the budget for the row, and the row is what an attacker has to
   * keep paying `signupLimit` to replace.
   */
  const updated = await PendingSignup.findOneAndUpdate(
    {
      _id: pending._id,
      lastSentAt: { $lte: new Date(Date.now() - OTP_RESEND_COOLDOWN_MS) },
      resendCount: { $lt: OTP_MAX_SENDS },
    },
    {
      $set: {
        codeHash: hashOtp(pending._id, code),
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
      $inc: { resendCount: 1 },
    },
    { new: true },
  );

  if (!updated) {
    // Lost the race, or the row expired between the read and here. Either way a
    // code is already in flight and asking again immediately is the wrong answer.
    return { ok: false, reason: "cooldown", retryAfter: 1 };
  }

  try {
    await sendOtpEmail(updated.email, code);
  } catch (error) {
    console.error("reissueOtp: verification email failed:", error?.code ?? error?.name);
    return {
      ok: false,
      reason: "delivery_failed",
      error: "Couldn't send the verification email. Please check your email address or try again in a few moments.",
      retryAfter: 5,
      retryable: true,
    };
  }

  return { ok: true, row: updated };
};

/**
 * Begin a signup: store the credentials, mail a code, hand back the row.
 *
 * Shared by the two ways in — a brand-new address, and a Google-only account
 * setting its first password — because they differ in one field (`user`) and
 * must not differ in anything else. The takeover this feature exists to prevent
 * was, in the end, one of those two paths quietly skipping the code.
 *
 * @param {string|null} [args.user] account to attach the password to on success;
 *        null means "create one".
 * @returns {Promise<{ok: true, row: object} | {ok: false, status: number, error: string, retryAfter?: number, retryable?: boolean}>}
 */
const startPendingSignup = async ({ name, email, password, user = null }) => {
  const address = String(email).toLowerCase();

  /*
   * Bound the codes in flight for one address — each is somebody's inbox getting
   * mail they may not have asked for.
   *
   * When an email address already has MAX_PENDING_PER_EMAIL active pending rows,
   * new signup attempts for that email are rejected with a 429 rather than
   * evicting existing rows. This prevents an attacker from cycling and spamming
   * a victim's inbox indefinitely or invalidating their live verification codes.
   */
  const live = await PendingSignup.find({ email: address, expiresAt: { $gt: new Date() } })
    .sort({ expiresAt: 1 })
    .select("_id expiresAt")
    .lean();

  if (live.length >= MAX_PENDING_PER_EMAIL) {
    const earliestExpiry = live[0]?.expiresAt ? new Date(live[0].expiresAt).getTime() : Date.now() + OTP_TTL_MS;
    const retryAfter = Math.max(1, Math.ceil((earliestExpiry - Date.now()) / 1000));
    return {
      ok: false,
      status: 429,
      error: "Too many pending verification attempts for this email. Please check your inbox or try again in a few minutes.",
      retryAfter,
      retryable: false,
    };
  }

  /*
   * Hashed now, and stored nowhere else.
   *
   * The row lives for ten minutes holding a password for an account that may not
   * exist yet. People reuse passwords, so keeping it in plaintext for those ten
   * minutes would be a credential leak for other sites even though nothing here
   * could be signed into.
   */
  const passwordHash = await bcrypt.hash(password, SIGNUP_BCRYPT_COST);
  const code = generateOtp();

  // The id is minted here rather than read back from the insert, because the
  // code's HMAC is bound to it — a two-step create-then-save would leave a row
  // holding a placeholder hash if the second write failed.
  const _id = new mongoose.Types.ObjectId();

  const row = await PendingSignup.create({
    _id,
    user,
    name,
    email: address,
    passwordHash,
    codeHash: hashOtp(_id, code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    resendCount: 1,
  });

  try {
    await sendOtpEmail(address, code);
  } catch (error) {
    // The mail didn't go, so drop the row rather than leave it holding a code
    // nobody received and a slot nobody can use.
    console.error("startPendingSignup: verification email failed:", error?.code ?? error?.name);
    await PendingSignup.deleteOne({ _id: row._id });
    return {
      ok: false,
      status: 502,
      error: "Couldn't send the verification email. Please check your email address or try again in a few moments.",
      retryAfter: 5,
      retryable: true,
    };
  }

  return { ok: true, row };
};

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

    if (existingUser) {
      /*
       * A Google-linked account setting a password for the first time.
       *
       * This branch used to write the password straight onto the account and
       * return a session — an unauthenticated takeover of any Google-only user
       * whose address you could guess, in one request. The justification was
       * that Google had already proved the address, which is true and beside
       * the point: it says the *account owner* controls that mailbox, and says
       * nothing at all about who is sending this POST.
       *
       * So it goes through the same code as any other signup. The difference is
       * only that the pending row names an existing account to attach to
       * (`user`) rather than an account to create, and the code proves the
       * sender can read mail at an address the account already holds.
       */
      if (existingUser.googleId && !existingUser.password) {
        if (!password || !PASSWORD_RE.test(password)) {
          return res.status(400).json({ message: PASSWORD_MSG });
        }

        const pending = await startPendingSignup({
          name: name || existingUser.name || existingUser.username,
          email: existingUser.email,
          password,
          user: existingUser._id,
        });
        if (!pending.ok) {
          if (pending.retryAfter) {
            res.set("Retry-After", String(pending.retryAfter));
          }
          return res.status(pending.status).json({
            error: pending.error,
            ...(pending.retryAfter ? { retryAfter: pending.retryAfter } : {}),
            ...(pending.retryable !== undefined ? { retryable: pending.retryable } : {}),
          });
        }

        return res.status(200).json({
          message: "Verification code sent",
          ...verificationPending(pending.row),
        });
      }

      /*
       * An account already owns this address, so there is nothing to verify and
       * nothing here may touch it. Unchanged from before OTP: this endpoint has
       * never been able to modify an existing password-holding account, and the
       * whole point of keeping pending signups out of `users` is that it still
       * can't.
       */
      return res.status(400).json({ message: "User already exists" });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Please fill in all fields" });
    }
    if (typeof name !== "string" || name.length > MAX_NAME_LENGTH) {
      // Checked here rather than left to the schema: a `maxlength` violation
      // arrives as a ValidationError and would surface as a 500 "Server error"
      // on a field the user can see and fix.
      return res.status(400).json({ message: "That name is too long" });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }
    if (!PASSWORD_RE.test(password)) {
      return res.status(400).json({ message: PASSWORD_MSG });
    }

    const pending = await startPendingSignup({ name, email, password });
    if (!pending.ok) {
      if (pending.retryAfter) {
        res.set("Retry-After", String(pending.retryAfter));
      }
      return res.status(pending.status).json({
        error: pending.error,
        ...(pending.retryAfter ? { retryAfter: pending.retryAfter } : {}),
        ...(pending.retryable !== undefined ? { retryable: pending.retryable } : {}),
      });
    }

    /*
     * No account, no settings row, no session — only a ticket naming the pending
     * row. Everything is created in `verifyOtp`, once the code proves that
     * whoever submitted this address can read mail sent to it.
     */
    return res.status(201).json({
      message: "Verification code sent",
      ...verificationPending(pending.row),
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

    // password, failedLoginAttempts, and lockoutUntil are select:false — must be explicitly requested
    const user = await User.findOne(query).select("+password +googleId +failedLoginAttempts +lockoutUntil");

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

    // Per-account lockout check: stops distributed credential stuffing across rotating IPs
    if (user.lockoutUntil && user.lockoutUntil > new Date()) {
      const remainingSeconds = Math.max(1, Math.ceil((user.lockoutUntil.getTime() - Date.now()) / 1000));
      res.set("Retry-After", String(remainingSeconds));
      return res.status(429).json({
        error: `Account temporarily locked due to repeated failed login attempts. Please try again in ${Math.ceil(remainingSeconds / 60)} minute(s) or reset your password.`,
        retryAfter: remainingSeconds,
        locked: true,
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockoutUntil = new Date(Date.now() + ACCOUNT_LOCKOUT_DURATION_MS);
        await User.updateOne(
          { _id: user._id },
          { $set: { failedLoginAttempts: MAX_FAILED_LOGIN_ATTEMPTS, lockoutUntil } }
        );
        const retryAfter = Math.ceil(ACCOUNT_LOCKOUT_DURATION_MS / 1000);
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({
          error: "Too many failed login attempts. Account temporarily locked for 15 minutes. Please try again later or reset your password.",
          retryAfter,
          locked: true,
        });
      }

      await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: attempts } });
      const attemptsLeft = MAX_FAILED_LOGIN_ATTEMPTS - attempts;
      return res.status(400).json({
        error: "Invalid credentials",
        attemptsLeft,
      });
    }

    // Password matched: clear any lingering failed attempt count or lockout
    if (user.failedLoginAttempts > 0 || user.lockoutUntil) {
      await User.updateOne(
        { _id: user._id },
        { $set: { failedLoginAttempts: 0, lockoutUntil: null } }
      );
    }

    recordSignInCountry(req, user._id);

    const deviceId = requestDeviceId(req);
    const existingSession = await UserSession.findOne({
      user: user._id,
      deviceId,
      revokedAt: null,
      refreshTokenExpiresAt: { $gt: new Date() },
    }).lean();
    const isTrustedDevice = Boolean(existingSession?.isTrusted);

    const token = await issueAuthTokens(user._id, res, {
      deviceId,
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
      isTrustedDevice,
      token,
    });
  } catch (error) {
    console.error("loginUser error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const googleLogin = async (req, res) => {
  try {
    if (!firebaseConfigured || admin.apps.length === 0) {
      return res.status(503).json({
        error: "Google sign-in is not configured on this server.",
      });
    }
    const { token: idToken } = req.body;
    if (typeof idToken !== "string" || !idToken) {
      return res.status(400).json({ error: "Google ID token is required" });
    }
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    let { email, name, picture } = decodedToken;

    /*
     * Google says it verified this address, not merely that it issued a token.
     *
     * `verifyIdToken` proves the token came from *our Firebase project* — it says
     * nothing about who owns the mailbox in the `email` claim. The lookup below
     * then attaches this identity to whatever account holds that address, so a
     * token from any other provider enabled on the project, present or future,
     * carrying an arbitrary claimed email would be an account takeover.
     *
     * That was survivable while nothing depended on it. It isn't now: this path
     * is the one exception to "no session without a proved address", and an
     * exception has to actually check the thing it claims. The web client uses
     * `GoogleAuthProvider` only, so this rejects nothing that works today.
     */
    if (!decodedToken.email_verified) {
      return res.status(403).json({
        error: "Your Google account's email address isn't verified.",
      });
    }
    if (typeof email !== "string" || !email) {
      return res.status(400).json({ error: "Google authentication failed" });
    }

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
        // Google verified the address as a condition of issuing the token we
        // just checked. Leaving this false would make the account look pending
        // to every check added from here on.
        isEmailVerified: true,
      });
      await UserSettings.create({ user: user._id });
    } else {
      // update googleId and profile pic (only if default) in place
      const updateData = {
        googleId: decodedToken.uid,
        // Google has now proved the address, whatever the row said before.
        isEmailVerified: true,
      };

      if (!user.profilePic || user.profilePic === DEFAULT_AVATAR_URL) {
        if (picture) {
          updateData.profilePic = picture;
          user.profilePic = picture;
        }
      }

      await User.updateOne(
        { _id: user._id },
        { $set: updateData },
      );
    }

    /*
     * Any email signup still in flight for this address is moot — the account it
     * would have created now exists, and its code would only ever produce a
     * "that email is already registered" a few minutes from now. Dropping the
     * rows also returns the address's share of `MAX_PENDING_PER_EMAIL`.
     */
    await PendingSignup.deleteMany({ email: user.email });

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
/**
 * POST /auth/verify-otp — spend the emailed code, create the account, sign in.
 *
 * This is the only place a `User` is created by the email/password flow, which is
 * the point: until the code is entered there is nothing to attack, and every check
 * that would otherwise be spread across signup, login, refresh and the socket
 * handshake collapses into the few below.
 */
export const verifyOtp = async (req, res) => {
  try {
    const { token, code } = req.body;

    const ticket = readVerificationTicket(token);
    if (!ticket) {
      return res.status(401).json({
        error: "This verification session has expired. Please sign up again.",
        expired: true,
      });
    }

    const submitted = typeof code === "string" ? code.trim() : "";
    if (!OTP_RE.test(submitted)) {
      return res.status(400).json({ error: `Enter the ${OTP_LENGTH}-digit code` });
    }

    /*
     * Take the guess off the budget *before* looking at the code, and let the
     * update's own filter be the limit check. Reading `attempts` and comparing it
     * here would leave the gate open under concurrency: parallel guesses all read
     * the same value, all decide they are under the limit, and the budget becomes
     * "five, plus however many requests fit in one round trip".
     */
    const claim = await claimAttempt(ticket.sid);
    if (!claim) {
      /*
       * Either the budget is spent or the row is gone — expired, already used, or
       * never existed because `sid` was invented. One answer for all of them: this
       * endpoint should not report whether a given pending signup exists.
       */
      const stillThere = await PendingSignup.exists({ _id: ticket.sid });
      return stillThere
        ? res.status(429).json({
            error: "Too many incorrect codes. Request a new one.",
            locked: true,
          })
        : res.status(410).json({
            error: "That code has expired. Request a new one.",
            codeExpired: true,
          });
    }

    const pending = claim.row;

    /*
     * Expiry is checked here as well as by the TTL index. Mongo's TTL monitor runs
     * about once a minute, so between the deadline and the sweep the row is still
     * readable — and a code that works for up to a minute past its stated life has
     * a longer life than the one stated.
     *
     * The email is checked against the ticket too. They are written together and
     * neither is mutable today, so this can't currently diverge; it costs a
     * comparison and it is what keeps the ticket bound to one address if an
     * "edit your email" affordance is ever added to the OTP screen.
     */
    if (pending.expiresAt <= new Date() || pending.email !== ticket.email) {
      return res.status(410).json({
        error: "That code has expired. Request a new one.",
        codeExpired: true,
      });
    }

    if (!otpMatches(pending.codeHash, hashOtp(pending._id, submitted))) {
      const left = claim.attemptsLeft;
      return res.status(400).json({
        error: left
          ? `That code isn't right. ${left} attempt${left === 1 ? "" : "s"} left.`
          : "Too many incorrect codes. Request a new one.",
        attemptsLeft: left,
        locked: left === 0,
      });
    }

    /*
     * Correct. Spend the row first: it is what makes this code single-use, and
     * doing it before the account is created means a double-submitted code
     * produces one account and one "expired" rather than a duplicate-key 500.
     */
    const spent = await PendingSignup.findOneAndDelete({ _id: pending._id });
    if (!spent) {
      return res.status(410).json({
        error: "That code has already been used.",
        codeExpired: true,
      });
    }

    // Whatever happens below, every other code in flight for this address is
    // moot — the address is about to be settled one way or the other.
    await PendingSignup.deleteMany({ email: pending.email });

    let user;

    if (pending.user) {
      /*
       * Attaching a first password to an account that already exists — the
       * Google-only case. The account is looked up again rather than trusted
       * from the row: ten minutes have passed, and it may since have been
       * deleted, or have gained a password by another route, in which case this
       * must not overwrite it.
       */
      user = await User.findOne({ _id: pending.user, ...HUMAN_ACCOUNT }).select("+password");
      if (!user || ["deleted", "deactivated"].includes(user.accountStatus)) {
        return res.status(410).json({
          error: "That account is no longer available.",
          expired: true,
        });
      }
      if (user.password) {
        return res.status(409).json({
          error: "That account already has a password. Please log in.",
          alreadyVerified: true,
        });
      }

      await User.updateOne(
        { _id: user._id, password: { $exists: false } },
        { $set: { password: pending.passwordHash, name: pending.name, isEmailVerified: true } },
      );
    } else {
      /*
       * Somebody may have taken the address in the ten minutes this was pending —
       * through Google, or through a sibling pending signup that verified first.
       * Checked here *and* caught below, because between the two there is a race
       * that only the unique index can settle.
       */
      const taken = await User.findOne({ email: pending.email, ...HUMAN_ACCOUNT }).select("_id");
      if (taken) {
        return res.status(409).json({
          error: "That email is already registered. Please log in.",
          alreadyVerified: true,
        });
      }

      try {
        user = await User.create({
          name: pending.name,
          email: pending.email,
          username: await generateUniqueUsername(pending.email.split("@")[0]),
          profilePic: DEFAULT_AVATAR_URL,
          isEmailVerified: true,
        });
      } catch (error) {
        if (error?.code === 11000) {
          return res.status(409).json({
            error: "That email is already registered. Please log in.",
            alreadyVerified: true,
          });
        }
        throw error;
      }

      /*
       * The password and the settings row go on after the account, and both are
       * inside the rollback.
       *
       * The password is a second write deliberately: it is already bcrypted — it
       * was hashed at signup so it never sat in the pending row in plaintext —
       * and `User`'s pre-save hook hashes any modified `password`. Passing it to
       * `create` would hash the hash, and the account could never be logged
       * into. Teaching the hook to recognise an already-hashed value is the
       * tempting alternative and a worse one: it makes every future save guess
       * at its input. `updateOne` is query middleware, so the hook doesn't run.
       *
       * If either write fails the account is removed rather than left behind.
       * The pending row is already spent by this point, so a survivor would be
       * an account its owner cannot sign into, cannot verify again (the code is
       * gone), and cannot re-register (the address is taken) — discoverable only
       * by guessing to try a password they were just told didn't work.
       */
      try {
        await User.updateOne({ _id: user._id }, { $set: { password: pending.passwordHash } });
        await UserSettings.create({ user: user._id });
      } catch (error) {
        await Promise.all([
          User.deleteOne({ _id: user._id }),
          UserSettings.deleteOne({ user: user._id }),
        ]);
        throw error;
      }

      /*
       * Not awaited. The signup is complete and the session is about to be
       * issued; a greeting that fails to send is not a reason to fail all of
       * that and leave the account in the unreachable state described above.
       */
      sendWelcomeNotification(user._id).catch((error) =>
        console.error("verifyOtp: welcome notification failed:", error),
      );
    }

    recordSignInCountry(req, user._id);

    const accessToken = await issueAuthTokens(user._id, res, {
      deviceId: requestDeviceId(req),
    });

    return res.status(201).json({
      message: "Email verified",
      id: user._id,
      name: pending.name,
      email: user.email,
      username: user.username,
      profilePic: user.profilePic,
      role: user.role,
      token: accessToken,
    });
  } catch (error) {
    console.error("verifyOtp error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

/**
 * POST /auth/resend-otp — mail a fresh code for a signup already in progress.
 *
 * Requires the ticket, so it cannot mail codes to addresses the caller hasn't just
 * submitted and isn't a spam vector on its own. The per-row cooldown and send cap in
 * `reissueOtp` are what stop somebody holding a valid ticket from making it one.
 */
export const resendOtp = async (req, res) => {
  try {
    const ticket = readVerificationTicket(req.body?.token);
    if (!ticket) {
      return res.status(401).json({
        error: "This verification session has expired. Please sign up again.",
        expired: true,
      });
    }

    const pending = await PendingSignup.findOne({ _id: ticket.sid });
    if (!pending || pending.expiresAt <= new Date() || pending.email !== ticket.email) {
      return res.status(410).json({
        error: "This signup has expired. Please sign up again.",
        expired: true,
      });
    }

    const sent = await reissueOtp(pending);
    if (!sent.ok) {
      if (sent.reason === "cooldown") {
        return res.status(429).json({
          error: `Please wait ${sent.retryAfter}s before asking for another code.`,
          retryAfter: sent.retryAfter,
        });
      }
      if (sent.reason === "delivery_failed") {
        if (sent.retryAfter) {
          res.set("Retry-After", String(sent.retryAfter));
        }
        return res.status(502).json({
          error: sent.error,
          ...(sent.retryAfter ? { retryAfter: sent.retryAfter } : {}),
          ...(sent.retryable !== undefined ? { retryable: sent.retryable } : {}),
        });
      }
      return res.status(429).json({
        error: "Too many codes requested. Please sign up again in a little while.",
        exhausted: true,
      });
    }

    return res.status(200).json({
      message: "A new code is on its way",
      verificationToken: createVerificationTicket(sent.row._id, sent.row.email),
      codeLength: OTP_LENGTH,
      expiresInSeconds: OTP_TTL_MS / 1000,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
    });
  } catch (error) {
    // Log the shape, not the body — a mail transport error can echo the address.
    console.error("resendOtp error:", error?.code ?? error?.name);
    return res.status(500).json({ error: "Failed to send a new code" });
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

    /*
     * The raw token goes in the email; only its hash is stored.
     *
     * It was persisted verbatim, which made `User.resetPasswordToken` a
     * plaintext credential sitting in the database for an hour — anyone who
     * could read a row (a backup, a dump, a logged query, an aggregation in the
     * admin panel) could take over that account without knowing the password.
     * Refresh tokens in this same file are already stored as `hashToken(...)`
     * for exactly this reason, and OTP codes are HMAC'd; this was the one
     * bearer secret still kept in the clear.
     *
     * SHA-256 with no salt and no stretching is the right primitive here and the
     * wrong one for a password: the input is 32 bytes of CSPRNG, so there is no
     * dictionary to run and nothing for a work factor to buy. It is the same
     * argument `hashToken` makes about refresh tokens.
     */
    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = hashToken(resetToken);
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

const passwordChangedEmailHtml = (name) => `
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
                      Your password was changed
                    </td>
                  </tr>

                  <!-- Body text -->
                  <tr>
                    <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;color:#737373;line-height:1.75;padding-bottom:24px;">
                      The password for your <strong style="color:#1a1a1a;">Gossips</strong> account (${name ? `<strong>${name}</strong>` : "account"}) was recently changed. For your security, all active sessions on other devices have been signed out.
                    </td>
                  </tr>

                  <!-- Divider -->
                  <tr>
                    <td style="padding-bottom:18px;">
                      <div style="height:1px;background:#efefef;"></div>
                    </td>
                  </tr>

                  <!-- Security warning -->
                  <tr>
                    <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#8e8e8e;line-height:1.7;">
                      If you did not make this change, please <a href="${process.env.FRONTEND_URL}/forgot-password" style="color:#1a1a1a;font-weight:600;text-decoration:underline;">reset your password immediately</a> to secure your account.
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
`;

const sendPasswordChangedEmail = (email, name) =>
  transporter.sendMail({
    from: process.env.BREVO_EMAIL,
    to: email,
    subject: "Your Gossips password was changed",
    html: passwordChangedEmailHtml(name),
  });

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

    // Hashed on the way in, so the stored value is never the bearer secret —
    // see forgotPassword. A link issued before this shipped no longer matches,
    // which costs its holder one more "forgot password" click.
    const user = await User.findOne({
      ...HUMAN_ACCOUNT,
      resetPasswordToken: hashToken(token),
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    user.password = password; // pre-save hook hashes it
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.failedLoginAttempts = 0;
    user.lockoutUntil = null;
    await user.save();

    // Revoke all existing sessions on password reset (security best practice)
    await UserSession.deleteMany({ user: user._id });

    // Send security confirmation email asynchronously (do not fail reset if email transport fails)
    sendPasswordChangedEmail(user.email, user.name || user.username).catch((err) =>
      console.error("resetPassword: confirmation email failed:", err?.code ?? err?.name)
    );

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
      decoded = jwt.verify(refreshToken, getRefreshTokenSecret(), JWT_VERIFY_OPTIONS);
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
      // Refresh token reuse detection (OAuth 2.0 / RFC 6819):
      // Check if this token was already rotated previously.
      const reusedSession = await UserSession.findOne({
        user: decoded.id,
        previousRefreshTokenHash: tokenHash,
      });

      if (reusedSession) {
        // Malicious token reuse detected: an old rotated token was presented again.
        // Revoke all sessions for this account immediately to terminate the breach.
        console.warn(
          `Security Alert: Refresh token reuse detected for user ${decoded.id}. Revoking all sessions.`
        );
        await UserSession.deleteMany({ user: decoded.id });

        const baseOptions = {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        };
        res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, baseOptions);
        if (requestedId) {
          res.clearCookie(accountCookieName(requestedId), {
            ...baseOptions,
            path: ACCOUNT_COOKIE_PATH,
          });
        }

        return res.status(401).json({
          message: "Compromised token: Refresh token reuse detected. All sessions have been revoked for your security.",
          reuseDetected: true,
        });
      }

      return res
        .status(401)
        .json({ message: "Refresh token expired or revoked" });
    }

    const user = await User.findById(decoded.id);
    if (!user || ["deleted", "deactivated"].includes(user.accountStatus)) {
      await UserSession.deleteOne({ _id: session._id });
      return res.status(401).json({ message: "User not found or unavailable" });
    }

    // Atomic in-place rotation: generate new token and update the existing session row
    const newAccessToken = createAccessToken(user._id);
    const newRefreshToken = createRefreshToken(user._id);
    const newTokenHash = hashToken(newRefreshToken);
    const newExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );

    const updatedSession = await UserSession.findOneAndUpdate(
      {
        _id: session._id,
        refreshTokenHash: tokenHash,
      },
      {
        $set: {
          refreshTokenHash: newTokenHash,
          previousRefreshTokenHash: tokenHash,
          refreshTokenExpiresAt: newExpiresAt,
          rotatedAt: new Date(),
          lastActiveAt: new Date(),
          revokedAt: null,
        },
      },
      { new: true }
    );

    if (!updatedSession) {
      return res.status(401).json({ message: "Refresh token rotation conflict" });
    }

    // Set updated cookies
    const makeActive = refreshToken === sharedCookie;
    if (makeActive) {
      res.cookie(REFRESH_TOKEN_COOKIE_NAME, newRefreshToken, getRefreshTokenCookieOptions());
    }
    res.cookie(accountCookieName(user._id), newRefreshToken, {
      ...getRefreshTokenCookieOptions(),
      path: ACCOUNT_COOKIE_PATH,
    });

    // The id goes back so the client can assert it got what it asked for.
    return res.status(200).json({ token: newAccessToken, accountId: user._id });
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
        const decoded = jwt.verify(target, getRefreshTokenSecret(), JWT_VERIFY_OPTIONS);
        loggedOutId = decoded?.id || loggedOutId;
      } catch {
        // An unverifiable token still gets its cookie cleared below.
      }
      // By hash, so only this device's session dies — other devices keep theirs.
      await UserSession.deleteOne({ refreshTokenHash: hashToken(target) });
    }

    // Immediately revoke the active bearer access token if present in the request
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const accessToken = authHeader.split(" ")[1];
      try {
        const decodedAccess = jwt.verify(accessToken, getAccessTokenSecret(), JWT_VERIFY_OPTIONS);
        await revokeAccessToken(accessToken, decodedAccess?.id, decodedAccess?.exp, "logout");
      } catch {
        await revokeAccessToken(accessToken, null, null, "logout");
      }
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

/**
 * GET /auth/sessions — List all active sessions/devices for the signed-in user.
 */
export const listSessions = async (req, res) => {
  try {
    const currentDeviceId = requestDeviceId(req);
    const sessions = await UserSession.find({
      user: req.user._id,
      refreshTokenExpiresAt: { $gt: new Date() },
      revokedAt: null,
    })
      .sort({ lastActiveAt: -1, createdAt: -1 })
      .select("deviceId deviceType os browser appVersion ipAddress userAgent isTrusted trustedAt lastActiveAt createdAt")
      .lean();

    const mapped = sessions.map((s) => ({
      id: s._id,
      deviceId: s.deviceId,
      deviceType: s.deviceType || "desktop",
      os: s.os || "Unknown OS",
      browser: s.browser || "Browser",
      ipAddress: s.ipAddress || "",
      userAgent: s.userAgent || "",
      isTrusted: Boolean(s.isTrusted),
      trustedAt: s.trustedAt,
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
      isCurrent: s.deviceId === currentDeviceId,
    }));

    return res.status(200).json({ sessions: mapped });
  } catch (error) {
    console.error("listSessions error:", error);
    return res.status(500).json({ error: "Failed to list sessions" });
  }
};

/**
 * DELETE /auth/sessions/:sessionId — Revoke a specific active device session.
 */
export const revokeSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const currentDeviceId = requestDeviceId(req);

    const session = await UserSession.findOne({ _id: sessionId, user: req.user._id });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    await UserSession.deleteOne({ _id: session._id });

    const isCurrent = session.deviceId === currentDeviceId;
    if (isCurrent) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const accessToken = authHeader.split(" ")[1];
        await revokeAccessToken(accessToken, req.user._id, null, "revocation");
      }
    }

    return res.status(200).json({
      message: "Session revoked successfully",
      sessionId,
      isCurrent,
    });
  } catch (error) {
    console.error("revokeSession error:", error);
    return res.status(500).json({ error: "Failed to revoke session" });
  }
};

/**
 * POST /auth/logout-others — Sign out of all other devices except this current one.
 */
export const logoutOtherDevices = async (req, res) => {
  try {
    const currentDeviceId = requestDeviceId(req);
    await UserSession.deleteMany({
      user: req.user._id,
      deviceId: { $ne: currentDeviceId },
    });

    return res.status(200).json({ message: "Logged out of all other devices successfully" });
  } catch (error) {
    console.error("logoutOtherDevices error:", error);
    return res.status(500).json({ error: "Failed to log out of other devices" });
  }
};

/**
 * POST /auth/logout-all — Sign out of all devices and terminate all sessions.
 */
export const logoutAllDevices = async (req, res) => {
  try {
    await UserSession.deleteMany({ user: req.user._id });

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const accessToken = authHeader.split(" ")[1];
      await revokeAccessToken(accessToken, req.user._id, null, "logout_all");
    }

    const baseOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    };
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, baseOptions);
    res.clearCookie(accountCookieName(req.user._id), {
      ...baseOptions,
      path: ACCOUNT_COOKIE_PATH,
    });

    return res.status(200).json({ message: "Logged out of all devices successfully" });
  } catch (error) {
    console.error("logoutAllDevices error:", error);
    return res.status(500).json({ error: "Failed to log out of all devices" });
  }
};
