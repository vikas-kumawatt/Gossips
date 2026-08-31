import crypto from "crypto";
import mongoose from "mongoose";
import RevokedToken from "../models/RevokedToken.js";

// Local in-memory hot cache: tokenHash -> expiresAt (epoch ms)
const localRevokedCache = new Map();

// Periodic sweep for local cache entries
const cleanLocalCache = () => {
  const now = Date.now();
  for (const [hash, exp] of localRevokedCache.entries()) {
    if (exp <= now) {
      localRevokedCache.delete(hash);
    }
  }
};
setInterval(cleanLocalCache, 60 * 1000).unref();

export const hashAccessToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

/**
 * Revoke an access token upon logout, session destruction, or password reset.
 *
 * @param {string} token - Raw JWT access token string
 * @param {string|mongoose.Types.ObjectId} [userId] - Account ID
 * @param {number} [expSec] - Token expiration timestamp in seconds from JWT decoded claim
 * @param {string} [reason="logout"] - Revocation reason
 */
export const revokeAccessToken = async (token, userId, expSec, reason = "logout") => {
  if (typeof token !== "string" || !token) return;
  const hash = hashAccessToken(token);
  const expiresAt = expSec
    ? new Date(expSec * 1000)
    : new Date(Date.now() + 15 * 60 * 1000);

  // Instantly block on this server process
  localRevokedCache.set(hash, expiresAt.getTime());

  // Only persist to MongoDB if database connection is active
  if (mongoose.connection.readyState === 1) {
    try {
      const updateDoc = { expiresAt, reason };
      if (userId && mongoose.isValidObjectId(userId)) {
        updateDoc.user = userId;
      }
      await RevokedToken.findOneAndUpdate(
        { tokenHash: hash },
        { $set: updateDoc },
        { upsert: true }
      );
    } catch (err) {
      console.error("revokeAccessToken DB error:", err?.message);
    }
  }
};

/**
 * Check whether an access token has been revoked before its natural expiration.
 *
 * @param {string} token - Raw JWT access token string
 * @returns {Promise<boolean>}
 */
export const isTokenRevoked = async (token) => {
  if (typeof token !== "string" || !token) return false;
  const hash = hashAccessToken(token);

  // Fast-path: local in-memory cache check
  const localExp = localRevokedCache.get(hash);
  if (localExp) {
    if (localExp > Date.now()) return true;
    localRevokedCache.delete(hash);
  }

  if (mongoose.connection.readyState === 1) {
    try {
      const exists = await RevokedToken.exists({ tokenHash: hash });
      if (exists) {
        localRevokedCache.set(hash, Date.now() + 15 * 60 * 1000);
        return true;
      }
    } catch {
      // Fallback to local cache result
    }
  }
  return false;
};
