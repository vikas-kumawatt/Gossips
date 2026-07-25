import { Schema, model } from "mongoose";

/**
 * Hashtag — tag registry, count-cached.
 *
 * Removed posts[] array (unbounded, redundant — query Post.hashtags instead).
 * postCount kept as a cheap counter for trending queries; bump via $inc on Post create/delete.
 * lastUsedAt lets you sort by recency cheaply.
 */
const hashtagSchema = new Schema(
  {
    tag:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    postCount:  { type: Number, default: 0, min: 0 },
    lastUsedAt: { type: Date,   default: Date.now },
  },
  { timestamps: true }
);

// Trending: most-used tags recently active
hashtagSchema.index({ postCount: -1, lastUsedAt: -1 });

export default model("Hashtag", hashtagSchema);
