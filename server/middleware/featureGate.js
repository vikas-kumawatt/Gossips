import { getSettings } from "../utils/settings.js";

/**
 * Enforces the admin feature flags on the routes they describe. A toggle that
 * nothing reads is worse than no toggle, so every flag in AppSettings is
 * checked by one of these.
 *
 * Staff bypass content flags — otherwise disabling posting would also stop a
 * moderator testing whether the fix worked.
 */
const isStaff = (req) => ["admin", "super_admin"].includes(req.user?.role);

const gate = (flag, message) => async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings[flag] === false && !isStaff(req)) {
      return res.status(503).json({ error: message });
    }
    return next();
  } catch (error) {
    console.error(`featureGate(${flag}) error:`, error);
    return next();
  }
};

export const requirePostingEnabled = gate(
  "postingEnabled",
  "Posting is temporarily disabled."
);

export const requireCommentingEnabled = gate(
  "commentingEnabled",
  "Commenting is temporarily disabled."
);

export const requireMessagingEnabled = gate(
  "directMessagesEnabled",
  "Direct messages are temporarily disabled."
);

/**
 * Enforces `maxPostLength` / `maxCommentLength`. The schema caps content at
 * 500; this lets an admin tighten it below that during an incident.
 */
export const enforceContentLength = (settingKey) => async (req, res, next) => {
  try {
    const settings = await getSettings();
    const limit = settings[settingKey];
    const content = req.body?.content;

    if (typeof content === "string" && typeof limit === "number" && content.trim().length > limit) {
      return res
        .status(400)
        .json({ error: `Must be ${limit} characters or fewer`, message: `Must be ${limit} characters or fewer` });
    }
    return next();
  } catch (error) {
    console.error(`enforceContentLength(${settingKey}) error:`, error);
    return next();
  }
};

/**
 * Blocks brand-new accounts from posting when `minAccountAgeHoursToPost` is
 * set — a blunt brake on signup-and-spam.
 */
export const requireAccountAge = async (req, res, next) => {
  try {
    const settings = await getSettings();
    const hours = settings.minAccountAgeHoursToPost;
    if (!hours || isStaff(req) || !req.user?.createdAt) return next();

    const ageHours = (Date.now() - new Date(req.user.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < hours) {
      const wait = Math.ceil(hours - ageHours);
      return res.status(403).json({
        error: `New accounts can't post yet. Try again in about ${wait} hour${wait === 1 ? "" : "s"}.`,
      });
    }
    return next();
  } catch (error) {
    console.error("requireAccountAge error:", error);
    return next();
  }
};

export const requireRegistrationsOpen = async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.registrationsOpen) {
      return res.status(503).json({ message: "New signups are closed right now." });
    }
    return next();
  } catch (error) {
    console.error("requireRegistrationsOpen error:", error);
    return next();
  }
};

/**
 * Suspended accounts keep a valid token until it expires, so every write path
 * has to check the live status rather than trusting the JWT.
 */
export const requireActiveAccount = (req, res, next) => {
  if (req.user?.accountStatus === "suspended") {
    return res.status(403).json({
      error: req.user.suspensionReason
        ? `Your account is suspended: ${req.user.suspensionReason}`
        : "Your account is suspended.",
      suspended: true,
      suspensionEndsAt: req.user.suspensionEndsAt || null,
    });
  }
  return next();
};

/**
 * Strips uploaded files when media is switched off, so the request still
 * succeeds as a text-only post instead of failing outright.
 */
export const applyMediaUploadFlag = async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.mediaUploadsEnabled && !isStaff(req) && req.files?.length) {
      req.files = [];
    }
    return next();
  } catch (error) {
    console.error("applyMediaUploadFlag error:", error);
    return next();
  }
};
