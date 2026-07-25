import { Schema, model } from "mongoose";
import bcrypt from "bcrypt";
import { escapeRegex } from "../utils/respond.js";

const BCRYPT_COST = 10;

/**
 * User — Core identity, profile, and auth only.
 *
 * What moved out:
 *   followers/following/closeFriends → Follow collection
 *   blocked/restricted/mutedUsers/hiddenStories → UserRelation collection
 *   likedPosts/savedPosts → Like / Saved collections
 *   refreshTokens/activeSessions/deviceTokens → UserSession collection
 *   notificationSettings/privacySettings/chatSettings/aiPreferences/customization/securitySettings → UserSettings (1:1)
 *   socketId/isOnline → Redis presence (removed from Mongo)
 *   metrics.totalFollowers/Following → User.counts.{followers,following}
 *
 * Sensitive fields use select:false and are stripped by toJSON transform.
 */
const userSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    name: { type: String, default: "", trim: true, maxlength: 50 },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: [/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers and underscores"],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    // ── Auth ──────────────────────────────────────────────────
    password:   { type: String, select: false, minlength: 6 },
    googleId:   { type: String, unique: true, sparse: true, select: false },
    appleId:    { type: String, unique: true, sparse: true, select: false },
    facebookId: { type: String, unique: true, sparse: true, select: false },

    resetPasswordToken:   { type: String, select: false },
    resetPasswordExpires: { type: Date,   select: false },

    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret:  { type: String, select: false },
    twoFactorBackupCodes: {
      type: [{ codeHash: String, used: { type: Boolean, default: false } }],
      select: false,
      default: [],
    },

    // ── Profile ───────────────────────────────────────────────
    bio:        { type: String, default: "", maxlength: 250 },
    link: {
      type: String,
      default: "",
      maxlength: 200,
      validate: {
        validator: (v) => v === "" || /^https?:\/\/.+\..+/.test(v),
        message: "Please provide a valid URL",
      },
    },
    profilePic:  { type: String, default: "/default-avatar.png" },
    coverPhoto:  { type: String, default: "" },
    pronouns:    { type: String, default: "" },
    birthday:    { type: Date },

    phoneNumber:      { type: String, sparse: true, index: true },
    isPhoneVerified:  { type: Boolean, default: false },
    isEmailVerified:  { type: Boolean, default: false },

    // ── Verification & visibility ─────────────────────────────
    isVerified: { type: Boolean, default: false },
    verificationBadge: {
      type: String,
      enum: ["none", "blue", "gold", "gray"],
      default: "none",
    },
    isPrivate: { type: Boolean, default: false },

    // ── Staff role ────────────────────────────────────────────
    // Never settable through any public route — only scripts/makeAdmin.js and
    // a super_admin acting through the admin panel can change it.
    role: {
      type: String,
      enum: ["user", "admin", "super_admin"],
      default: "user",
      index: true,
    },

    // ── Account state ─────────────────────────────────────────
    accountStatus: {
      type: String,
      enum: ["active", "suspended", "deactivated", "deleted", "locked"],
      default: "active",
      index: true,
    },
    deactivatedAt:   Date,
    deletedAt:       Date,
    suspensionReason: String,
    suspensionEndsAt: Date,

    // ── Presence (last-seen only; real-time presence in Redis) ─
    lastActiveAt: { type: Date, default: Date.now },

    // ── Cached counts (kept in sync by write paths via $inc) ──
    counts: {
      followers: { type: Number, default: 0, min: 0 },
      following: { type: Number, default: 0, min: 0 },
      posts:     { type: Number, default: 0, min: 0 },
    },

    // ── Subscription ──────────────────────────────────────────
    subscription: {
      tier:      { type: String, enum: ["free", "premium", "business"], default: "free" },
      expiresAt: Date,
    },

    // ── Business profile (optional) ───────────────────────────
    isBusiness: { type: Boolean, default: false },
    businessInfo: {
      category:    String,
      description: String,
      website:     String,
      address: {
        street:  String,
        city:    String,
        state:   String,
        zipCode: String,
        country: String,
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.password;
        delete ret.twoFactorSecret;
        delete ret.twoFactorBackupCodes;
        delete ret.resetPasswordToken;
        delete ret.resetPasswordExpires;
        delete ret.googleId;
        delete ret.appleId;
        delete ret.facebookId;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────
userSchema.index({ createdAt: -1 });
userSchema.index({ username: "text", name: "text", bio: "text" });

// ── Virtuals ──────────────────────────────────────────────────
userSchema.virtual("age").get(function () {
  if (!this.birthday) return null;
  const today = new Date();
  const b = new Date(this.birthday);
  let age = today.getFullYear() - b.getFullYear();
  const m = today.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < b.getDate())) age--;
  return age;
});

// ── Hooks ─────────────────────────────────────────────────────
userSchema.pre("save", async function (next) {
  if (this.isModified("password") && this.password) {
    const salt = await bcrypt.genSalt(BCRYPT_COST);
    this.password = await bcrypt.hash(this.password, salt);
  }
  next();
});

// ── Methods ───────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

// ── Statics ───────────────────────────────────────────────────
userSchema.statics.searchUsers = function (query, currentUserId, limit = 20) {
  const safe = escapeRegex(query);
  const rx = new RegExp(safe, "i");
  return this.find({
    $or: [{ username: rx }, { name: rx }],
    _id: { $ne: currentUserId },
    accountStatus: "active",
  })
    .select("username name profilePic isVerified verificationBadge bio counts")
    .limit(limit)
    .lean();
};

userSchema.statics.findByPhoneNumber = function (phoneNumber) {
  return this.findOne({ phoneNumber, accountStatus: "active" }).select(
    "username name profilePic isVerified"
  );
};

export default model("User", userSchema);
