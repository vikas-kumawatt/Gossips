import { Schema, model } from "mongoose";

/**
 * Follow — single source of truth for the follow graph.
 *
 * Replaces:
 *   - User.followers[]
 *   - User.following[]
 *   - FollowRequest collection
 *
 * status:
 *   "pending"  : private account follow request awaiting approval
 *   "accepted" : active follow
 *   "rejected" : user denied the request (briefly kept for UX, then purgeable)
 */
const followSchema = new Schema(
  {
    follower:  { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    following: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "accepted",
      index: true,
    },

    isCloseFriend:          { type: Boolean, default: false },
    notificationsEnabled:   { type: Boolean, default: false },

    acceptedAt: Date,
    rejectedAt: Date,
  },
  { timestamps: true }
);

// One edge per pair regardless of status
followSchema.index({ follower: 1, following: 1 }, { unique: true });

// Hot read paths
followSchema.index({ following: 1, status: 1, createdAt: -1 }); // "who follows X"
followSchema.index({ follower:  1, status: 1, createdAt: -1 }); // "who X follows"

followSchema.statics.isFollowing = async function (followerId, followingId) {
  const doc = await this.findOne({
    follower: followerId,
    following: followingId,
    status: "accepted",
  }).lean();
  return !!doc;
};

followSchema.statics.areMutual = async function (a, b) {
  const count = await this.countDocuments({
    status: "accepted",
    $or: [
      { follower: a, following: b },
      { follower: b, following: a },
    ],
  });
  return count === 2;
};

export default model("Follow", followSchema);
