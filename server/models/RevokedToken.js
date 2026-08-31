import mongoose from "mongoose";

/**
 * Access token denylist model.
 *
 * Stolen or logged-out access tokens are recorded here by hash until their expiry.
 * A Mongo TTL index removes expired rows automatically so the collection remains compact.
 */
const revokedTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    expiresAt: { type: Date, required: true },
    reason: { type: String, default: "logout" },
  },
  { timestamps: true }
);

// Automatic TTL eviction once the access token's natural lifespan has passed
revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RevokedToken = mongoose.model("RevokedToken", revokedTokenSchema);
export default RevokedToken;
