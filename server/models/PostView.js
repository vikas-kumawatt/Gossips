import { Schema, model } from "mongoose";

/**
 * PostView — one row per (user, post) view.
 * Replaces Post.views[].
 * TTL of 90 days keeps the collection bounded.
 */
const postViewSchema = new Schema(
  {
    user:     { type: Schema.Types.ObjectId, ref: "User", required: true },
    post:     { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    viewedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// One view per user per post (idempotent)
postViewSchema.index({ post: 1, user: 1 }, { unique: true });

// "How many distinct viewers in the last X days"
postViewSchema.index({ post: 1, viewedAt: -1 });

// Auto-prune after 90 days
postViewSchema.index({ viewedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

/**
 * recordView(userId, postId) → true if this was a new view, false if already viewed.
 * Uses upsert so it's safe to call concurrently.
 */
postViewSchema.statics.recordView = async function (userId, postId) {
  const result = await this.updateOne(
    { user: userId, post: postId },
    { $setOnInsert: { user: userId, post: postId, viewedAt: new Date() } },
    { upsert: true }
  );
  return result.upsertedCount > 0;
};

export default model("PostView", postViewSchema);
