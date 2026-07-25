import { Schema, model } from "mongoose";

/**
 * Post — slim, count-cached.
 *
 * Removed (now in their own collections):
 *   likes[]   → Like   (targetType: "Post")
 *   reposts[] → Repost (targetType: "Post")
 *   views[]   → PostView
 *   replies[] → Comment (reverse-lookup: Comment.post = this._id)
 *
 * Counts are denormalized here for cheap reads.
 * Keep them fresh with atomic $inc in the controller alongside Like/Repost/PostView/Comment row ops.
 */
/**
 * What the quoted post/comment said at the moment it was quoted. Quotes render
 * this frozen copy rather than the live document, so editing an original can't
 * silently rewrite what a quoter appears to be responding to. `versionAt` is
 * the original's `editedAt || createdAt` at quote time — comparing it against
 * the original's current value is how we detect "a newer version exists".
 */
const quotedSnapshotSchema = new Schema(
  {
    content:   { type: String, default: "" },
    versionAt: { type: Date,   required: true },
  },
  { _id: false }
);

const postSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },

    content: { type: String, maxlength: 500 },
    icon:    { type: String, default: "" },
    media:   { type: [String], default: [] },

    // Quote / reply relationships
    parentGossip:   { type: Schema.Types.ObjectId, ref: "Post",    default: null },
    quotedPost:     { type: Schema.Types.ObjectId, ref: "Post",    default: null },
    quotedComment:  { type: Schema.Types.ObjectId, ref: "Comment", default: null },
    isQuoteRepost:  { type: Boolean, default: false },
    isQuoteComment: { type: Boolean, default: false },
    quotedSnapshot: { type: quotedSnapshotSchema, default: null },

    // Cached counts — keep in sync with Like/Repost/PostView/Comment rows
    counts: {
      likes:   { type: Number, default: 0, min: 0 },
      reposts: { type: Number, default: 0, min: 0 },
      replies: { type: Number, default: 0, min: 0 },
      views:   { type: Number, default: 0, min: 0 },
      quotes:  { type: Number, default: 0, min: 0 },
    },

    // Audience control — who can reply to / quote this post
    whoCanReply: {
      type: String,
      enum: ["anyone", "followers", "following", "mentioned"],
      default: "anyone",
    },
    // Users @mentioned in the content (resolved at create time).
    // Used to enforce whoCanReply === "mentioned".
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],

    isDraft:            { type: Boolean, default: false },
    hideLikeShareCount: { type: Boolean, default: false },

    /**
     * Scheduling. A pending post is stored as a draft, so every feed and
     * profile query — all of which already filter `isDraft` — hides it without
     * needing a new exclusion anywhere. Publishing just flips isDraft off.
     */
    scheduledFor:    { type: Date, default: null },
    scheduleStatus:  {
      type: String,
      // "publishing" is a short-lived claim so two server instances can't
      // publish the same post twice.
      enum: ["pending", "publishing", "published", "failed", null],
      default: null,
    },
    scheduleError:   { type: String, default: null },
    scheduleAttempts: { type: Number, default: 0 },


    // Author's own disclosure that this was made with AI. Shown to everyone who
    // can see the post — it's a disclosure, not a private preference.
    isAiGenerated: { type: Boolean, default: false },

    // Content edits — text only; media is fixed at creation.
    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date,    default: null },
    // Previous versions, oldest first. `select: false` because it would
    // otherwise ride along on every feed response; load it with
    // `.select("+editHistory")`.
    editHistory: {
      type: [{ _id: false, content: String, editedAt: Date }],
      default: [],
      select: false,
    },

    // Soft delete — keeps thread integrity for replies/quotes
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date,    default: null },
  },
  { timestamps: true }
);

// Hot query paths
postSchema.index({ author: 1, isDraft: 1, isDeleted: 1, createdAt: -1 });
postSchema.index({ quotedPost:   1, createdAt: -1 });
postSchema.index({ parentGossip: 1, createdAt: -1 });
postSchema.index({ isDeleted: 1, createdAt: -1 });
// The publisher polls this: due, still pending.
postSchema.index({ scheduleStatus: 1, scheduledFor: 1 });

// An unbounded array of 500-char strings would grow the document without limit,
// so history is capped. The original is always kept — it's the version people
// actually care about when checking what a post used to say — and versions are
// dropped from the middle instead.
export const MAX_EDIT_HISTORY = 20;

/**
 * Replace the text, recording the outgoing version. Unlike Message.editContent,
 * each history entry is stamped with when *that* version came into existence
 * (not when it was replaced), so the viewer can label versions accurately.
 *
 * Requires the document to have been loaded with `.select("+editHistory")`.
 */
postSchema.methods.editContent = async function (newContent, mentions) {
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

export default model("Post", postSchema);
// whoCanReply audience control enabled
