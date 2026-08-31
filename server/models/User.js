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
    /*
     * Required of everyone, unique among *humans* only.
     *
     * A bot shares its owner's address: the owner is the accountable contact for it, and
     * anything the platform would ever email about a bot — "your bot was paused", "its key
     * expired" — goes to them. One person may own several bots, so several rows legitimately
     * carry the same address.
     *
     * `unique: true` is therefore gone from this field, replaced by the partial index below.
     * That is an index change on a live collection, not a schema tweak: see
     * `scripts/migrateBotEmailIndex.js`, which must run before a bot can be created.
     */
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    // ── Auth ──────────────────────────────────────────────────
    password:   { type: String, select: false, minlength: 6 },
    googleId:   { type: String, unique: true, sparse: true, select: false },

    resetPasswordToken:   { type: String, select: false },
    resetPasswordExpires: { type: Date,   select: false },

    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret:  { type: String, select: false },
    twoFactorBackupCodes: {
      type: [{ codeHash: String, used: { type: Boolean, default: false } }],
      select: false,
      default: [],
    },

    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockoutUntil:        { type: Date, default: null, select: false },

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

    phoneNumber:      { type: String, sparse: true, index: true },
    isPhoneVerified:  { type: Boolean, default: false },
    /*
     * True for every account created after signup OTP shipped: a row only exists
     * here once its code has been entered. See models/PendingSignup.js for why
     * there is no such thing as an unverified `User`.
     *
     * Still `false` on accounts that predate the feature, where nothing ever
     * wrote it — so the flag is *not* a safe thing to gate on today, and nothing
     * does. Anything that starts reading it needs those rows backfilled first.
     */
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

    // ── AI bot accounts ───────────────────────────────────────
    /*
     * An AI account, owned and operated by a human.
     *
     * A bot is a real row in this collection rather than a separate model, because it has
     * to appear everywhere a person does — in a follower list, a search result, a group,
     * a chat header — and a parallel identity type would mean every one of those queries
     * growing a second branch. What makes it a bot is this flag and the absence of
     * credentials, not a different shape.
     *
     * Bots have no `password`, no verified `email` and no session. `authController` refuses
     * them explicitly rather than relying on the missing password to fail: a passwordless
     * row is also what a fresh OAuth signup looks like, and "there is no password so no
     * password matches" is the kind of reasoning that stops being true after one refactor.
     */
    /*
     * `select: true` — always projected, even into an inclusive `.select(...)`.
     *
     * The disclosure is a legal requirement, not a feature: the badge has to be renderable
     * everywhere a bot appears, and there are 50-odd distinct field projections in this
     * codebase that build a user payload. Adding `isBot` to each by hand is the pattern
     * this repo keeps learning the hard way — a rule that exists fifty times will
     * eventually only be right forty-nine times, and the one that's wrong is an
     * undisclosed AI account.
     *
     * Mongoose merges a schema-level `select: true` into any inclusive projection, so every
     * existing query gains the field with no edit, and every future one inherits it.
     * Verified rather than assumed: `.select("username name isVerified")` resolves to
     * `{username:1, name:1, isVerified:1, isBot:1}`.
     *
     * Aggregation pipelines are the exception — `$project` doesn't consult the schema — so
     * any pipeline that builds a user object names this field explicitly.
     */
    isBot: { type: Boolean, default: false, select: true },

    /*
     * The human accountable for this bot. Required *because* it is a bot — the cap of five
     * bots per owner is enforced on this field, and an unowned bot would be both
     * unattributable and uncapped.
     *
     * Never exposed publicly. Who runs a bot is the owner's business, and disclosing it
     * would deanonymise anyone experimenting under a persona; the compliance requirement
     * is that the account is disclosed as *AI*, not who wrote its prompt.
     */
    owner: { type: Schema.Types.ObjectId, ref: "User", default: null },

    /** Which of the owner's BYOK keys pays for this bot's inference. */
    apiKey: { type: Schema.Types.ObjectId, ref: "ApiKey", default: null },

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
        // Belt and braces: select:false already keeps this out of most reads,
        // but a route that explicitly asks for it must not serialise it by
        // accident. Only the count is ever public.
        delete ret.usernameHistory;
        /*
         * Who owns a bot, and which key pays for it, are never public.
         *
         * Stripped by default rather than filtered per route, so a route that returns a
         * user document — and there are many — cannot deanonymise a persona's author by
         * omission. The owner's own dashboard builds its view explicitly instead of
         * relying on this serialiser; see the bots controller.
         */
        delete ret.owner;
        delete ret.apiKey;
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

/*
 * An owner's bots: the list, and the count the five-per-owner cap is enforced against.
 *
 * Partial on `isBot`, so the index holds only bot rows — a few per owner against a
 * collection of humans. A plain compound index would carry an entry for every user, all of
 * them with `owner: null`, to answer a question only ever asked about bots.
 */
userSchema.index({ owner: 1 }, { partialFilterExpression: { isBot: true } });

/*
 * One human per email address. Bots are excluded, because they share their owner's.
 *
 * `{ isBot: false }` and not `{ isBot: { $ne: true } }`: `partialFilterExpression` accepts
 * only equality, `$exists`, `$type`, the range operators, `$and`, `$or` and `$in` — `$ne` is
 * not in that set, and Mongo rejects the index outright rather than ignoring the clause.
 *
 * Which is why the migration backfills `isBot: false` onto every account created before the
 * field existed. Without that they carry no `isBot` at all, fall outside this filter, and
 * quietly lose uniqueness enforcement on their address — the failure mode being two humans
 * able to register the same email, which is an account-takeover vector rather than an
 * inconvenience. The backfill is what makes this filter total.
 */
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { isBot: false } }
);

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
