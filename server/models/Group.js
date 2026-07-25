import { Schema, model } from "mongoose";
import { escapeRegex } from "../utils/respond.js";

/**
 * Group — core group/channel document. Members are in GroupMember.
 *
 * Why split members:
 *   The old schema embedded members[] with rich subdocs. At 1000 members a
 *   single doc could be hundreds of KB and rewrite on every membership change.
 *   GroupMember scales linearly and lets us index/query by user (cross-group
 *   lookups) and filter banned users without scanning the array.
 */
const groupSchema = new Schema(
  {
    // Identity
    name:        { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: "", maxlength: 500 },
    avatar:      { type: String, default: "/default-group-avatar.png" },
    coverPhoto:  { type: String, default: "" },

    type: { type: String, enum: ["public", "private", "secret"], default: "private", index: true },

    inviteLink:           { type: String, unique: true, sparse: true },
    inviteLinkExpiresAt:  { type: Date },

    // Settings
    settings: {
      approvalRequired:  { type: Boolean, default: false },
      membersCanInvite:  { type: Boolean, default: true },
      maxMembers:        { type: Number,  default: 1000 },

      slowModeSeconds: { type: Number, default: 0 },
      messageHistory: {
        type: String,
        enum: ["visible", "visible_to_new", "hidden"],
        default: "visible",
      },
      antiSpam: { type: Boolean, default: true },

      mediaSharing:        { type: Boolean, default: true },
      fileSharing:         { type: Boolean, default: true },
      maxFileSizeMB:       { type: Number,  default: 100 },

      profilePhotosVisible: { type: Boolean, default: true },
      memberListVisible:    { type: Boolean, default: true },

      linkedGroups: [{ type: Schema.Types.ObjectId, ref: "Group" }],
    },

    features: {
      polls:      { type: Boolean, default: true },
      events:     { type: Boolean, default: true },
      payments:   { type: Boolean, default: false },
      voiceRooms: { type: Boolean, default: true },
      videoCalls: { type: Boolean, default: true },
      bots:       { type: Boolean, default: true },
    },

    // Pinned messages — bounded list (cap enforced in code, e.g. 5)
    pinnedMessages: [{
      message:  { type: Schema.Types.ObjectId, ref: "Message" },
      pinnedBy: { type: Schema.Types.ObjectId, ref: "User" },
      pinnedAt: { type: Date, default: Date.now },
    }],

    // Group rules — small list, fine to embed
    rules: [{
      title:       { type: String, required: true, maxlength: 100 },
      description: { type: String, maxlength: 500 },
      addedBy:     { type: Schema.Types.ObjectId, ref: "User" },
      addedAt:     { type: Date, default: Date.now },
    }],

    // Cached counts — kept fresh by GroupMember create/delete
    counts: {
      members:       { type: Number, default: 0, min: 0 },
      admins:        { type: Number, default: 0, min: 0 },
      messagesTotal: { type: Number, default: 0, min: 0 },
    },

    isActive:  { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: true }
);

// Search & discovery
groupSchema.index({ name: "text", description: "text" });
groupSchema.index({ type: 1, isActive: 1, isDeleted: 1 });

groupSchema.statics.searchPublic = function (query, limit = 20) {
  const safe = escapeRegex(query);
  const rx = new RegExp(safe, "i");
  return this.find({
    type: "public",
    isActive: true,
    isDeleted: false,
    $or: [{ name: rx }, { description: rx }],
  })
    .limit(limit)
    .lean();
};

export default model("Group", groupSchema);
