import { Schema, model } from "mongoose";
import { MEDIA_TYPES } from "../utils/mediaTypes.js";

/**
 * A single attachment. Typed rather than a bare URL string, because audio
 * can't be recognised from its extension reliably and needs a duration and a
 * waveform to render a scrubber before the file has loaded.
 *
 * Legacy rows still hold plain strings; `normalizeMedia` upgrades them on read,
 * so nothing had to be migrated. `strict: false` isn't needed — Mongoose casts
 * a stored string to `{}` and drops it, which is why every read path must go
 * through the normaliser rather than trusting the hydrated document.
 */
const mediaItemSchema = new Schema(
  {
    url:       { type: String, required: true },
    type:      { type: String, enum: MEDIA_TYPES, default: "image" },
    thumbnail: { type: String },
    // Seconds. Audio and video only.
    duration:  { type: Number, min: 0 },
    // Normalised 0-1 amplitude samples, captured while recording. Lets the
    // player draw the waveform immediately instead of decoding the file first.
    waveform:  { type: [Number], default: undefined },
    width:     { type: Number, min: 0 },
    height:    { type: Number, min: 0 },
  },
  { _id: false }
);

/**
 * A poll attached to a post or comment. X's rules: 2-4 options, one choice,
 * 5 minutes to 7 days.
 *
 * Only the counts live here. Who voted for what is a separate PollVote
 * collection, for the same reason likes and reposts were moved out of Post: an
 * embedded voter array on something that goes viral grows without bound, ships
 * every voter to every reader, and eventually hits the 16MB document ceiling.
 */
const pollSchema = new Schema(
  {
    question: { type: String, required: true, maxlength: 200, trim: true },
    options: {
      type: [
        {
          _id: false,
          // Stable across edits and reorderings — votes reference this, not
          // the array index.
          id:    { type: String, required: true },
          text:  { type: String, required: true, maxlength: 60, trim: true },
          votes: { type: Number, default: 0, min: 0 },
        },
      ],
      validate: {
        validator: (v) => v.length >= 2 && v.length <= 4,
        message: "A poll needs between 2 and 4 options",
      },
    },
    totalVotes: { type: Number, default: 0, min: 0 },
    // Set when the post goes public, not when it's composed — a poll scheduled
    // for tomorrow shouldn't have been running overnight. See the scheduler.
    closesAt:   { type: Date, default: null },
    // The chosen length, kept so the publisher can start the clock later.
    durationMinutes: { type: Number, required: true, min: 5, max: 7 * 24 * 60 },
  },
  { _id: false }
);

/**
 * Where a post was tagged. Coordinates come from Nominatim (OpenStreetMap) or
 * the device, and are stored as plain numbers rather than GeoJSON because
 * nothing queries by proximity — this is a label, not a search index. If
 * "posts near me" ever ships, this wants to become a 2dsphere point.
 */
const locationSchema = new Schema(
  {
    name:    { type: String, required: true, maxlength: 120, trim: true },
    address: { type: String, maxlength: 300, trim: true },
    lat:     { type: Number, min: -90,  max: 90 },
    lng:     { type: Number, min: -180, max: 180 },
    // Nominatim's id for the place, so repeat picks dedupe.
    placeId: { type: String },
  },
  { _id: false }
);

export { mediaItemSchema, pollSchema, locationSchema };

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
    // Typed since the GIF/audio work; legacy rows hold bare URL strings and are
    // upgraded on read by normalizeMedia. Never render this field directly.
    media:   { type: [mediaItemSchema], default: [] },

    // At most one of poll / media is set — see ATTACHMENT_KINDS. Location is
    // independent and can accompany either.
    poll:     { type: pollSchema,     default: null },
    location: { type: locationSchema, default: null },

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
    /*
     * Accounts @mentioned here, resolved and permission-checked at write time.
     *
     * Only the ones who *allow* the mention are stored, which makes this list
     * do double duty: it enforces whoCanReply === "mentioned", and it's what
     * the renderer links. A handle in the text that isn't in this list renders
     * as plain grey text — that's how "this person doesn't allow @mentions"
     * looks, rather than a link that goes somewhere they didn't consent to.
     */
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],

    /*
     * Hashtags, lowercased, blocked ones already removed. Denormalised out of
     * the content so the tag page is an index lookup rather than a regex scan
     * of every post ever written.
     */
    hashtags: { type: [String], default: [], lowercase: true },

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
// The hashtag page: newest first within one tag.
postSchema.index({ hashtags: 1, createdAt: -1 });
// The publisher polls this: due, still pending.
postSchema.index({ scheduleStatus: 1, scheduledFor: 1 });

/*
 * Full-text, for the relevance ranking in `GET /search/content?sort=relevance`.
 *
 * A collection may hold only one text index, so this deliberately covers
 * `content` alone rather than being widened later to include, say, hashtags —
 * adding a field means dropping and rebuilding, which on a large collection is
 * not free.
 *
 * It does not replace the regex path and is not meant to. A text index matches
 * whole stemmed words, so it finds "running" for "run" and nothing at all for
 * "runn" — while search-as-you-type is mostly partial words. Both exist because
 * they answer different questions; see utils/contentSearch.js.
 *
 * `default_language: "none"` disables stemming and stop-word removal. Stemming
 * is English-only here and this app's content is not: with the default, a Hindi
 * or Spanish post is tokenised by an English stemmer, and common English words
 * are dropped from queries entirely — so searching "the office" would drop "the"
 * and quietly change the query. Without stemming, matching is exact-word, which
 * is predictable across languages.
 */
postSchema.index(
  { content: "text" },
  { name: "content_text", default_language: "none", background: true }
);

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
postSchema.methods.editContent = async function (newContent, mentions, hashtags) {
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
  // Undefined means "caller didn't recompute them", which would be a bug —
  // an edit that changes the text has to change the index with it.
  if (Array.isArray(hashtags)) this.hashtags = hashtags;
  this.isEdited = true;
  this.editedAt = new Date();
  await this.save();
};

export default model("Post", postSchema);
// whoCanReply audience control enabled
