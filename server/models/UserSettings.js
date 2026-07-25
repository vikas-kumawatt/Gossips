import { Schema, model } from "mongoose";

/**
 * UserSettings — 1:1 with User.
 * Moved out of User so the hot-cached User doc stays small.
 * Lookup: UserSettings.findOne({ user: req.user._id })
 * Create on signup; never let it be missing for an active user.
 */

const audienceEnum       = ["everyone", "followers", "followers_following", "none"];
const profileAudienceEnum = ["everyone", "followers", "followers_following"];

const userSettingsSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // ── Notifications ─────────────────────────────────────────
    notifications: {
      messages:          { type: Boolean, default: true },
      messageSound:      { type: Boolean, default: true },
      messageVibration:  { type: Boolean, default: true },
      messagePreview:    { type: Boolean, default: true },
      messageReactions:  { type: Boolean, default: true },

      likes:        { type: Boolean, default: true },
      comments:     { type: Boolean, default: true },
      follows:      { type: Boolean, default: true },
      mentions:     { type: Boolean, default: true },
      storyReplies: { type: Boolean, default: true },

      groupMessages:  { type: Boolean, default: true },
      groupInvites:   { type: Boolean, default: true },
      groupReactions: { type: Boolean, default: true },

      voiceCalls: { type: Boolean, default: true },
      videoCalls: { type: Boolean, default: true },

      emailDigest:   { type: Boolean, default: false },
      emailMessages: { type: Boolean, default: false },

      quietHours: {
        enabled:    { type: Boolean, default: false },
        startTime:  String,
        endTime:    String,
        exceptions: [{ type: Schema.Types.ObjectId, ref: "User" }],
      },
    },

    // ── Privacy ───────────────────────────────────────────────
    privacy: {
      whoCanMessage:          { type: String, enum: audienceEnum,        default: "everyone" },
      whoCanCall:             { type: String, enum: audienceEnum,        default: "everyone" },
      whoCanSeeOnlineStatus:  { type: String, enum: audienceEnum,        default: "everyone" },
      whoCanSeeLastSeen:      { type: String, enum: audienceEnum,        default: "everyone" },
      whoCanSeeReadReceipts:  { type: String, enum: audienceEnum,        default: "everyone" },
      whoCanSeeProfile:       { type: String, enum: profileAudienceEnum, default: "everyone" },
      whoCanSeeFollowers:     { type: String, enum: profileAudienceEnum, default: "everyone" },
      whoCanSeeFollowing:     { type: String, enum: profileAudienceEnum, default: "everyone" },
      whoCanSeeStories: {
        type: String,
        enum: ["everyone", "followers", "close_friends", "custom"],
        default: "everyone",
      },
      storyCustomAudience: [{ type: Schema.Types.ObjectId, ref: "User" }],

      readReceipts:                 { type: Boolean, default: true },
      typingIndicator:              { type: Boolean, default: true },
      screenshotNotifications:      { type: Boolean, default: false },
      screenRecordingNotifications: { type: Boolean, default: false },
    },

    // ── Chat ──────────────────────────────────────────────────
    chat: {
      theme:    { type: String, default: "system" },
      fontSize: { type: String, enum: ["small", "medium", "large"], default: "medium" },
      enterToSend: { type: Boolean, default: true },
      mediaDownloadQuality: {
        type: String,
        enum: ["auto", "high", "medium", "low"],
        default: "auto",
      },
      autoPlayMedia: { type: Boolean, default: true },
      autoDownloadMedia: {
        wifi:     { type: Boolean, default: true },
        cellular: { type: Boolean, default: false },
        roaming:  { type: Boolean, default: false },
      },

      favoriteChats:      { type: [String], default: [] },
      pinnedChats:        { type: [String], default: [] },
      mutedChats:         { type: [String], default: [] },
      hiddenChats:        { type: [String], default: [] },
      lockedChats:        { type: [String], default: [] },
      manualUnreadChats:  { type: [String], default: [] },
      forcedReadChats:    { type: [String], default: [] },

      chatLockPinHash: { type: String, default: "", select: false },

      customCategories: {
        type: [{
          id:    { type: String, required: true },
          name:  { type: String, required: true, trim: true, maxlength: 30 },
          order: { type: Number, required: true, default: 0 },
        }],
        default: [],
      },
      categoryAssignments: {
        type: [{
          chatId:     { type: String, required: true },
          categoryId: { type: String, required: true },
        }],
        default: [],
      },
      disappearingByChat: {
        type: [{
          chatId:  { type: String, required: true },
          seconds: { type: Number, default: null },
        }],
        default: [],
      },
      archivedChats: {
        type: [{
          chatId:     { type: String, required: true },
          archivedAt: { type: Date, default: Date.now },
        }],
        default: [],
      },
    },

    // ── Security ──────────────────────────────────────────────
    security: {
      loginAlerts:               { type: Boolean, default: true },
      unrecognizedDeviceAlerts:  { type: Boolean, default: true },
      endToEndEncryption:        { type: Boolean, default: true },
      messageBackup:             { type: Boolean, default: false },
      autoLockMinutes:           { type: Number,  default: 0 },
    },

    // ── AI ────────────────────────────────────────────────────
    ai: {
      smartReplies:      { type: Boolean, default: true },
      autoTranslation:   { type: Boolean, default: false },
      suggestedStickers: { type: Boolean, default: true },
      messageSummaries:  { type: Boolean, default: false },
      typingAssistance:  { type: Boolean, default: false },
    },

    // ── Customization ─────────────────────────────────────────
    customization: {
      chatWallpaper:      { type: String, default: "" },
      accentColor:        { type: String, default: "#007AFF" },
      appIcon:            { type: String, default: "default" },
      messageBubbleStyle: {
        type: String,
        enum: ["default", "rounded", "square"],
        default: "default",
      },
    },
  },
  { timestamps: true }
);

userSettingsSchema.methods.isInQuietHours = function () {
  const qh = this.notifications?.quietHours;
  if (!qh?.enabled || !qh.startTime || !qh.endTime) return false;
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return qh.startTime < qh.endTime
    ? cur >= qh.startTime && cur < qh.endTime
    : cur >= qh.startTime || cur < qh.endTime;
};

export default model("UserSettings", userSettingsSchema);
