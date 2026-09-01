import { Schema, model } from "mongoose";

/**
 * UserSession — one document per active session/device.
 * Replaces User.refreshTokens[], User.activeSessions[], User.deviceTokens[].
 * Refresh tokens stored as sha256 hashes only — never plaintext.
 */
const userSessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    refreshTokenHash:      { type: String, required: true, unique: true, index: true },
    refreshTokenExpiresAt: { type: Date, required: true },

    deviceId:   { type: String, index: true },
    deviceType: String, // "phone" | "tablet" | "desktop"
    os:         String,
    browser:    String,
    appVersion: String,
    ipAddress:  String,
    userAgent:  String,

    push: {
      token:    String,
      platform: { type: String, enum: ["ios", "android", "web"] },
    },

    isCurrent:    { type: Boolean, default: true },

    /*
     * ── Trusted device ────────────────────────────────────────────────────
     *
     * "This device has passed a two-factor challenge and the person asked us to
     * remember it", so the second factor is not demanded again until
     * `trustedUntil`. Nothing else grants it.
     *
     * These defaulted to `true`/`Date.now` and `storeRefreshToken` re-set them
     * on every token issue — every login, every silent refresh, every account
     * switch. So every session that had ever existed was "trusted", nothing
     * could ever be untrusted, and `trustedAt` recorded the last refresh rather
     * than when trust was granted. A field that is unconditionally true is not
     * a signal, and this one is read on a screen where the user is being asked
     * to judge whether a device is theirs.
     *
     * `trustedUntil` is stored rather than derived from `trustedAt` so that
     * changing the window doesn't retroactively extend or revoke trust someone
     * has already been granted.
     */
    isTrusted:     { type: Boolean, default: false },
    trustedAt:     { type: Date, default: null },
    trustedUntil:  { type: Date, default: null },

    lastActiveAt: { type: Date, default: Date.now },
    previousRefreshTokenHash: { type: String, default: null, index: true },
    rotatedAt:    { type: Date, default: null },
    revokedAt:    { type: Date, default: null },
  },
  { timestamps: true }
);

// One session per (user, device)
userSessionSchema.index({ user: 1, deviceId: 1 }, { unique: true, sparse: true });

// Auto-expire when refresh token expires
userSessionSchema.index({ refreshTokenExpiresAt: 1 }, { expireAfterSeconds: 0 });

// Push token lookups (fan-out notifications)
userSessionSchema.index({ "push.token": 1 }, { sparse: true });

export default model("UserSession", userSessionSchema);
