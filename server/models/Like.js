import { Schema, model } from "mongoose";

/**
 * Like — one row per (user, target).
 * Replaces Post.likes[], Comment.likes[], User.likedPosts[].
 */
const likeSchema = new Schema(
  {
    user:       { type: Schema.Types.ObjectId, ref: "User",   required: true, index: true },
    targetType: { type: String, enum: ["Post", "Comment"],   required: true },
    target:     { type: Schema.Types.ObjectId, required: true, refPath: "targetType" },
  },
  { timestamps: true }
);

// Idempotent — one like per (user, target)
likeSchema.index({ user: 1, targetType: 1, target: 1 }, { unique: true });

// "Who liked this post/comment, recently first"
likeSchema.index({ targetType: 1, target: 1, createdAt: -1 });

// "Posts I liked"
likeSchema.index({ user: 1, targetType: 1, createdAt: -1 });

export default model("Like", likeSchema);
