import { Schema, model } from "mongoose";

/**
 * Repost — one row per (user, target).
 * Replaces Post.reposts[], Comment.reposts[].
 * Quote reposts remain as Post documents with quotedPost/quotedComment set.
 */
const repostSchema = new Schema(
  {
    user:       { type: Schema.Types.ObjectId, ref: "User",  required: true, index: true },
    targetType: { type: String, enum: ["Post", "Comment"],  required: true },
    target:     { type: Schema.Types.ObjectId, required: true, refPath: "targetType" },
  },
  { timestamps: true }
);

// Idempotent
repostSchema.index({ user: 1, targetType: 1, target: 1 }, { unique: true });

// "User's reposts" feed
repostSchema.index({ user: 1, createdAt: -1 });

// "Who reposted this"
repostSchema.index({ targetType: 1, target: 1, createdAt: -1 });

export default model("Repost", repostSchema);
