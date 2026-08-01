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
    /*
     * 200, not 50. The real limit is 50 characters *as a person counts them*,
     * enforced in setupProfile with Intl.Segmenter — because `maxlength` counts
     * UTF-16 code units, where one emoji is 2 and a flag can be 4. A 50-emoji
     * name is 50 characters to its owner and up to ~200 units here.
     */
    name: { type: String, default: "", trim: true, maxlength: 200 },
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

    /*
     * Every username this account has left behind.
     *
     * Two jobs. It's what "changed their username N times, last in April 2026"
     * is counted from, and it's what holds a released handle for a cooldown so
     * the owner can undo a mistake and a squatter can't pounce.
     *
     * select:false is load-bearing, not tidiness: the earlier names must never
     * leave the server, and `.lean()` skips the toJSON transform below, so a
     * transform alone would leak them from every lean read. Routes that need
     * the count ask for it explicitly and send only the count.
     */
    usernameHistory: {
      type: [
        {
          _id: false,
          username: { type: String, lowercase: true, trim: true },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      select: false,
      default: [],
    },
    usernameChangedAt: { type: Date },
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
    /*
     * Accounts @mentioned in the bio who permit it, resolved when the bio is
     * saved. Same contract as Post.mentions: a handle not in here renders as
     * plain text, which is what "doesn't allow @mentions" looks like.
     */
    bioMentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
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
    // When the badge was granted, for "Verified since April 2026". Accounts
    // verified before this field existed have no date, and the profile just
    // omits the line rather than inventing one.
    verifiedAt: { type: Date },
    /*
      * Only "none" or "blue". This was a four-colour enum, but nothing in the
      * product ever distinguished the colours — every read is
      * `verificationBadge !== "none"` — so it's a boolean wearing a string.
      * Kept as a string rather than folded into `isVerified` because ~20 query
      * projections name it.
      */
    verificationBadge: {
      type: String,
      enum: ["none", "blue"],
      default: "none",
    },
    isPrivate: { type: Boolean, default: false },

    /*
     * Where the account is based — ISO 3166-1 alpha-2, shown as "Based in
     * India" on the profile.
     *
     * Resolved on sign-in from the CDN's geo header, then an IP lookup, then
     * the device's time zone and locale — see utils/geo.js. Never from
     * anything the user types. That's the entire point: a self-declared
     * country is a bio field, whereas this one is evidence you can weigh when
     * an account claims to be a local news outlet. Latest sign-in wins, so a
     * trip abroad or a VPN moves it; smoothing that over several sign-ins is
     * worth doing only if it turns out to matter.
     */
    country: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
      maxlength: 2,
    },
    /*
     * Which signal produced it, strongest first: "cdn" and "ip" are observed
     * from the connection, "timezone" and "locale" are whatever the device
     * claimed. Internal only — not sent to any client. It's here so that when a
     * country looks wrong you can tell whether we measured it or were told it.
     */
    countrySource: {
      type: String,
      enum: ["", "cdn", "ip", "timezone", "locale"],
      default: "",
    },
    countryUpdatedAt: { type: Date },

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
        // Belt and braces: select:false already keeps this out of most reads,
        // but a route that explicitly asks for it must not serialise it by
        // accident. Only the count is ever public.
        delete ret.usernameHistory;
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
// Every availability check asks "has anyone released this handle recently?",
// which without this is a collection scan on the hottest keystroke path there
// is. Sparse: only accounts that have ever renamed carry the array.
userSchema.index({ "usernameHistory.username": 1 }, { sparse: true });
/*
 * The Verified activity tab resolves "who is verified" on every page it loads.
 * Without this that's a collection scan; partial, because the false rows are
 * the overwhelming majority and indexing them would buy nothing.
 */
userSchema.index({ isVerified: 1 }, { partialFilterExpression: { isVerified: true } });

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

/*
 * verificationBadge used to be a four-colour enum. Narrowing it to
 * none|blue would make any save() on a document still holding "gold" or "gray"
 * throw a ValidationError — Mongoose validates every *selected* path, not just
 * the modified ones, so a password reset or a suspension on such an account
 * would fail for a reason that has nothing to do with either. Normalising here
 * fixes those rows the next time they're written, with no migration to run and
 * no loss: nothing ever distinguished the colours.
 */
const ALLOWED_BADGES = new Set(["none", "blue"]);
userSchema.pre("validate", function (next) {
  if (this.verificationBadge && !ALLOWED_BADGES.has(this.verificationBadge)) {
    this.verificationBadge = "blue";
  }
  next();
});

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
