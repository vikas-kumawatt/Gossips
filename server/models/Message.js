import { Schema, model } from "mongoose";

/**
 * Message — the central chat message document.
 *
 * Key changes from old schema:
 *   - conversation key: sorted "smallerId:largerId" for DMs, "g:groupId" for groups.
 *     This single index handles both conversation types.
 *   - deliveryReceipts[]/readReceipts[] → MessageReceipt collection
 *   - reactions Map → MessageReaction collection (+ reactionSummary cached top-3)
 *   - Removed senderUsername/receiverUsername/groupName (populate at read time)
 *   - Removed metadata.ipAddress/userAgent (PII)
 *   - deletedFor now stores plain ObjectIds, not objects with a deletedAt
 *
 * Soft delete strategy:
 *   isDeleted: true  = deleted for everyone (tombstone)
 *   deletedFor: []   = deleted for me only (per-user)
 */
const messageSchema = new Schema(
  {
    // ── Conversation routing ───────────────────────────────────
    // DMs:    sorted "smallerId:largerId"
    // Groups: "g:groupId"
    conversation: { type: String, required: true, index: true },

    sender:   { type: Schema.Types.ObjectId, ref: "User",  required: true, index: true },
    receiver: { type: Schema.Types.ObjectId, ref: "User" }, // DMs only
    group:    { type: Schema.Types.ObjectId, ref: "Group" }, // Group messages only
    isGroupMessage: { type: Boolean, default: false },

    // ── Content ───────────────────────────────────────────────
    content: { type: String, maxlength: 10000 },
    messageType: {
      type: String,
      enum: [
        "text", "media", "voice", "location", "contact",
        "poll", "sticker", "gif", "file", "system", "reply",
        "forward", "story_reply", "payment", "call", "post_share",
      ],
      default: "text",
      index: true,
    },

    // ── Ephemerality ──────────────────────────────────────────
    expiresAt:          { type: Date },
    selfDestructSeconds: { type: Number },
    isEphemeral:        { type: Boolean, default: false },

    // ── Status (overall; per-recipient detail in MessageReceipt) ─
    status: {
      type: String,
      enum: ["sending", "sent", "delivered", "read", "failed"],
      default: "sent",
      index: true,
    },

    // ── Media ─────────────────────────────────────────────────
    media: [{
      type:       { type: String, enum: ["image", "video", "gif", "audio", "document", "voice", "sticker"] },
      url:        { type: String, required: true },
      thumbnail:  String,
      filename:   String,
      fileSize:   Number,
      duration:   Number,
      dimensions: { width: Number, height: Number },
      caption:    String,
      isSpoiler:  { type: Boolean, default: false },
    }],

    voiceNote: {
      url:      String,
      duration: Number,
      waveform: [Number],
    },

    // ── Reply / forward ───────────────────────────────────────
    replyTo: { type: Schema.Types.ObjectId, ref: "Message", index: true },

    isForwarded:  { type: Boolean, default: false },
    forwardedFrom: {
      userId:            { type: Schema.Types.ObjectId, ref: "User" },
      originalMessageId: { type: Schema.Types.ObjectId, ref: "Message" },
      forwardCount:      { type: Number, default: 0 },
    },

    // ── Reactions: cached top-3 summary; full data in MessageReaction ─
    reactionSummary: {
      total: { type: Number, default: 0 },
      top:   [{ emoji: String, count: Number }],
    },

    // ── Mentions / hashtags ───────────────────────────────────
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
    hashtags: [{ type: String, lowercase: true }],

    // ── Specialized payloads ──────────────────────────────────
    poll: {
      question: String,
      options: [{
        id:        { type: String, required: true },
        text:      { type: String, required: true },
        votes:     [{ userId: { type: Schema.Types.ObjectId, ref: "User" }, votedAt: Date }],
        voteCount: { type: Number, default: 0 },
      }],
      allowMultipleAnswers: { type: Boolean, default: false },
      isAnonymous:          { type: Boolean, default: false },
      expiresAt:            Date,
      totalVotes:           { type: Number, default: 0 },
      settings: {
        allowAddingOptions: { type: Boolean, default: false },
        showVoteCount:      { type: Boolean, default: true },
      },
    },

    location: {
      latitude:  Number,
      longitude: Number,
      address:   String,
      name:      String,
      mapUrl:    String,
      accuracy:  Number,
    },

    contact: { name: String, phone: String, email: String, vCard: String },

    payment: {
      amount:    Number,
      currency:  { type: String, default: "USD" },
      status:    { type: String, enum: ["pending", "completed", "failed", "cancelled"] },
      paymentId: String,
      note:      String,
    },

    call: {
      type:         { type: String, enum: ["voice", "video"] },
      duration:     Number,
      status:       { type: String, enum: ["missed", "answered", "rejected"] },
      participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
      startedAt:    Date,
      endedAt:      Date,
    },

    /**
     * A post or comment shared into the chat.
     *
     * `post` / `comment` is the live reference — the card renders the current
     * version, so edits show up and the tap-through always lands on the real
     * thing. `snapshot` is only a fallback: once the original is deleted the
     * reference resolves to nothing, and without it the bubble would go blank
     * and the conversation would stop making sense.
     */
    sharedContent: {
      kind:    { type: String, enum: ["post", "comment"] },
      post:    { type: Schema.Types.ObjectId, ref: "Post" },
      comment: { type: Schema.Types.ObjectId, ref: "Comment" },
      snapshot: {
        authorId:       { type: Schema.Types.ObjectId, ref: "User" },
        authorUsername: String,
        authorName:     String,
        authorPic:      String,
        content:        String,
        // Post.media / Comment.media are plain URL arrays, unlike Message.media.
        media:          [String],
        createdAt:      Date,
      },
    },

    // ── State ─────────────────────────────────────────────────
    isDeleted:  { type: Boolean, default: false },
    deletedFor: [{ type: Schema.Types.ObjectId, ref: "User" }], // delete for me

    isEdited:    { type: Boolean, default: false },
    editedAt:    Date,
    editHistory: [{ content: String, editedAt: Date }],

    isPinned: { type: Boolean, default: false },
    pinnedAt: Date,
    pinnedBy: { type: Schema.Types.ObjectId, ref: "User" },

    isImportant:  { type: Boolean, default: false },
    isEncrypted:  { type: Boolean, default: false },

    aiFeatures: {
      sentiment:      { type: String, enum: ["positive", "negative", "neutral"] },
      sentimentScore: Number,
    },

    isScheduled:  { type: Boolean, default: false },
    scheduledFor: Date,
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────
// Primary read path: conversation history newest-first
messageSchema.index({ conversation: 1, createdAt: -1 });

// Legacy DM / group fallback queries
messageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
messageSchema.index({ group: 1, createdAt: -1 });

// Ephemerality TTL
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Text search
messageSchema.index({ content: "text", "media.caption": "text", "poll.question": "text" });

messageSchema.index({ mentions: 1 });
messageSchema.index({ hashtags: 1 });
messageSchema.index({ conversation: 1, isPinned: 1 });
messageSchema.index({ isScheduled: 1, scheduledFor: 1 });

// ── Helpers ───────────────────────────────────────────────────
messageSchema.statics.dmConversationKey = function (userAId, userBId) {
  const a = userAId.toString();
  const b = userBId.toString();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
};

messageSchema.statics.groupConversationKey = function (groupId) {
  return `g:${groupId.toString()}`;
};

messageSchema.methods.isVisibleFor = function (userId) {
  if (this.isDeleted) return false;
  return !this.deletedFor.some((id) => id.toString() === userId.toString());
};

/**
 * Soft-delete this message for one user (delete-for-me).
 * deletedFor stores plain ObjectIds in the new schema.
 */
messageSchema.methods.softDeleteForUser = async function (userId) {
  await this.model("Message").updateOne(
    { _id: this._id },
    { $addToSet: { deletedFor: userId } }
  );
};

/** Edit message content — saves history, sets isEdited flag. */
messageSchema.methods.editContent = async function (newContent) {
  this.editHistory.push({ content: this.content, editedAt: new Date() });
  this.content = newContent;
  this.isEdited = true;
  this.editedAt = new Date();
  await this.save();
};

/**
 * Add or replace a reaction from userId.
 * Upserts a MessageReaction row and refreshes reactionSummary.
 */
messageSchema.methods.addReaction = async function (userId, emoji, skinTone = 1) {
  const MessageReaction = (await import("./MessageReaction.js")).default;
  await MessageReaction.updateOne(
    { message: this._id, user: userId },
    { $set: { emoji, skinTone } },
    { upsert: true }
  );
  await this._refreshReactionSummary();
};

/** Remove userId's reaction. */
messageSchema.methods.removeReaction = async function (userId) {
  const MessageReaction = (await import("./MessageReaction.js")).default;
  await MessageReaction.deleteOne({ message: this._id, user: userId });
  await this._refreshReactionSummary();
};

/** Recompute and save the reactionSummary cache. */
messageSchema.methods._refreshReactionSummary = async function () {
  const MessageReaction = (await import("./MessageReaction.js")).default;
  const rows = await MessageReaction.find({ message: this._id }).lean();
  const counts = {};
  rows.forEach(({ emoji }) => { counts[emoji] = (counts[emoji] || 0) + 1; });
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([emoji, count]) => ({ emoji, count }));

  await this.model("Message").updateOne(
    { _id: this._id },
    { $set: { "reactionSummary.total": rows.length, "reactionSummary.top": top } }
  );
  this.reactionSummary = { total: rows.length, top };
};

/**
 * Record a delivery receipt for userId.
 * No-ops if already delivered (upsert).
 */
messageSchema.methods.markAsDelivered = async function (userId) {
  const MessageReceipt = (await import("./MessageReceipt.js")).default;
  await MessageReceipt.updateOne(
    { message: this._id, user: userId, kind: "delivered" },
    { $setOnInsert: { message: this._id, user: userId, kind: "delivered", conversation: this.conversation } },
    { upsert: true }
  );
  if (this.status === "sent") {
    await this.model("Message").updateOne({ _id: this._id }, { $set: { status: "delivered" } });
    this.status = "delivered";
  }
};

/**
 * Record a read receipt for userId and advance message status.
 */
messageSchema.methods.markAsRead = async function (userId) {
  const MessageReceipt = (await import("./MessageReceipt.js")).default;
  await MessageReceipt.updateOne(
    { message: this._id, user: userId, kind: "read" },
    { $setOnInsert: { message: this._id, user: userId, kind: "read", conversation: this.conversation } },
    { upsert: true }
  );
  await this.model("Message").updateOne({ _id: this._id }, { $set: { status: "read" } });
  this.status = "read";
};

// Poll voting helper (kept on the doc since poll state is embedded)
messageSchema.methods.voteInPoll = async function (userId, optionIds) {
  if (!this.poll) throw new Error("This message is not a poll");

  const ids = Array.isArray(optionIds) ? optionIds : [optionIds];
  if (!this.poll.allowMultipleAnswers && ids.length > 1) {
    throw new Error("Multiple answers not allowed for this poll");
  }

  this.poll.options.forEach((option) => {
    option.votes = option.votes.filter((v) => v.userId.toString() !== userId.toString());
    option.voteCount = option.votes.length;
  });

  ids.forEach((optionId) => {
    const option = this.poll.options.find((o) => o.id === optionId);
    if (option) {
      option.votes.push({ userId, votedAt: new Date() });
      option.voteCount = option.votes.length;
    }
  });

  this.poll.totalVotes = this.poll.options.reduce((s, o) => s + o.voteCount, 0);
  await this.save();
};

export default model("Message", messageSchema);
