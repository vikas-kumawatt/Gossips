import { Schema, model } from "mongoose";

/**
 * NotInterested — per-user negative feedback on a post ("Not interested").
 *
 * Drives two behaviours in the home feed:
 *   1. Hard-hide  — the exact dismissed post is removed from the user's feed.
 *   2. Soft down-rank — the post's author and hashtags are recorded as negative
 *      signals; future feed posts matching them are pushed lower (not removed).
 *
 * One row per (user, post). Undo simply deletes the row.
 */
const notInterestedSchema = new Schema(
  {
    user:   { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    post:   { type: Schema.Types.ObjectId, ref: "Post", required: true },
    author: { type: Schema.Types.ObjectId, ref: "User" }, // post's author — signal source
    hashtags: { type: [String], default: [] },            // lowercased tags from the post content
  },
  { timestamps: true }
);

// One feedback row per user/post; also the lookup path for "what has this user dismissed".
notInterestedSchema.index({ user: 1, post: 1 }, { unique: true });
notInterestedSchema.index({ user: 1, createdAt: -1 });

export default model("NotInterested", notInterestedSchema);
