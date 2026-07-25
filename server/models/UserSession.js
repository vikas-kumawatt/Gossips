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
    lastActiveAt: { type: Date, default: Date.now },
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
