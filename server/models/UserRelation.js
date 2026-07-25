import { Schema, model } from "mongoose";

/**
 * UserRelation — block / mute / restrict edges.
 * Replaces User.blocked[], User.blockedBy[], User.restricted[], User.mutedUsers[], User.hiddenStories[].
 */
const userRelationSchema = new Schema(
  {
    from: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    to:   { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: {
      type: String,
      // hide_suggestion: "don't offer this person when I'm picking someone to
      // message". Weaker than mute — it only affects suggestion lists.
      enum: ["block", "mute", "restrict", "hide_stories", "hide_suggestion"],
      required: true,
      index: true,
    },
    expiresAt: { type: Date, default: null }, // mutes only; null = indefinite
    reason:    { type: String, maxlength: 200 },
  },
  { timestamps: true }
);

// One row per (from, to, kind)
userRelationSchema.index({ from: 1, to: 1, kind: 1 }, { unique: true });

// Auto-expire muted relations
userRelationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

userRelationSchema.statics.isBlocked = async function (fromId, toId) {
  const doc = await this.findOne({ from: fromId, to: toId, kind: "block" }).lean();
  return !!doc;
};

userRelationSchema.statics.eitherBlocks = async function (a, b) {
  const count = await this.countDocuments({
    kind: "block",
    $or: [
      { from: a, to: b },
      { from: b, to: a },
    ],
  });
  return count > 0;
};

export default model("UserRelation", userRelationSchema);
