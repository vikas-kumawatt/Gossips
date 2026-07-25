import { Schema, model } from "mongoose";

/**
 * Comment — slim, count-cached.
 *
 * Removed (now in their own collections):
 *   likes[]   → Like   (targetType: "Comment")
 *   reposts[] → Repost (targetType: "Comment")
 */
const commentSchema = new Schema(
  {
    content: { type: String, maxlength: 500 },
    media:   { type: [String], default: [] },

    post:   { type: Schema.Types.ObjectId, ref: "Post",    required: true },
    author: { type: Schema.Types.ObjectId, ref: "User",    required: true },
    parent: { type: Schema.Types.ObjectId, ref: "Comment", default: null },

    // Cached counts
    counts: {
      likes:   { type: Number, default: 0, min: 0 },
      replies: { type: Number, default: 0, min: 0 },
      reposts: { type: Number, default: 0, min: 0 },
    },

    // Audience control — who can reply to / quote this comment
    whoCanReply: {
      type: String,
      enum: ["anyone", "followers", "following", "mentioned"],
      default: "anyone",
    },
    // Users @mentioned in the content (resolved at create time).
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],

    // Author's own disclosure that this was made with AI. See Post.isAiGenerated.
    isAiGenerated: { type: Boolean, default: false },

    /**
     * Scheduling. Comments have no draft concept, so pending replies are
     * flagged explicitly and every read path filters `isScheduled` — see the
     * LIVE_COMMENT helper in commentController.
     */
    isScheduled:     { type: Boolean, default: false },
    scheduledFor:    { type: Date, default: null },
    scheduleStatus:  {
      type: String,
      enum: ["pending", "publishing", "published", "failed", null],
      default: null,
    },
    scheduleError:   { type: String, default: null },
    scheduleAttempts: { type: Number, default: 0 },


    // Content edits — text only; media is fixed at creation.
    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date,    default: null },
    // Previous versions, oldest first. `select: false` — load it with
    // `.select("+editHistory")`.
    editHistory: {
      type: [{ _id: false, content: String, editedAt: Date }],
      default: [],
      select: false,
    },

    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date,    default: null },
  },
  { timestamps: true }
);

// Top-level comments under a post, newest first
commentSchema.index({ post: 1, parent: 1, createdAt: -1 });

// Replies to a specific comment, oldest first (conversational order)
commentSchema.index({ parent: 1, createdAt: 1 });

// Author's comment history
commentSchema.index({ author: 1, createdAt: -1 });

// The publisher polls this.
commentSchema.index({ scheduleStatus: 1, scheduledFor: 1 });

// Mirrors Post.editContent — see the notes there.
export const MAX_EDIT_HISTORY = 20;

commentSchema.methods.editContent = async function (newContent, mentions) {
  this.editHistory.push({
    content: this.content || "",
    editedAt: this.editedAt || this.createdAt,
  });
  if (this.editHistory.length > MAX_EDIT_HISTORY) {
    const original = this.editHistory[0];
    this.editHistory = [
      original,
      ...this.editHistory.slice(-(MAX_EDIT_HISTORY - 1)),
    ];
  }
  this.content = newContent;
  this.mentions = mentions;
  this.isEdited = true;
  this.editedAt = new Date();
  await this.save();
};

export default model("Comment", commentSchema);
