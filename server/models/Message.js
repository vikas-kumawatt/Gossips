import { Schema, model } from "mongoose";
import { parseReactionEmoji, parseSkinTone } from "../utils/reactions.js";
import { touchConversationActivity } from "../utils/conversationActivity.js";

/**
 * Message — the central chat message document.
 *
 * Key changes from old schema:
 *   - conversation key: sorted "smallerId:largerId" for DMs, "g:groupId" for groups.
 *     This single index handles both conversation types.
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
    conversation: { type: String, required: true },

    /*
     * The client's own id for this send, when it supplied one.
     *
     * There was no idempotency at all: a client that retried a send it hadn't
     * heard back from — which is the correct thing for a client to do, since there
     * was no ack either — produced a second message. Together with the unique
     * index below, a retry now finds the row the first attempt created instead of
     * writing another.
     *
     * Optional, because /share, forwards, polls and call logs are not client sends
     * and have nothing to deduplicate against.
     */
    clientId: { type: String },

    sender:   { type: Schema.Types.ObjectId, ref: "User",  required: true },
    receiver: { type: Schema.Types.ObjectId, ref: "User" }, // DMs only
    group:    { type: Schema.Types.ObjectId, ref: "Group" }, // Group messages only
    isGroupMessage: { type: Boolean, default: false },

    // ── Content ───────────────────────────────────────────────
    content: { type: String, maxlength: 10000 },
    messageType: {
      type: String,
      /*
       * The enum describes what can *exist* in the collection, which includes
       * history. What a client may *ask for* is a much shorter list, and that lives
       * in utils/messageContent.js as CLIENT_MESSAGE_TYPES.
       *
       * `contact`, `payment`, `reply` and `forward` used to be here and are gone.
       * Nothing wrote them — replies are `replyTo`, forwards are `isForwarded`, and
       * the contact/payment payloads were deleted in R4 — but they could not simply
       * be removed, because Mongoose validates unmodified paths on `save()`: a stored
       * message carrying one would have thrown on the next edit, unsend or pin. R4
       * removed them, hit exactly that, and put them back (CF14).
       *
       * `file` is gone for the same reason and with the same care. Documents were
       * removed from the product, and `scripts/purgeDocumentMessages.js` retypes every
       * stored one to "text" as a tombstone. **Run it before deploying this**, in every
       * environment: its dry run (`npm run docs:purge:check`) counts what is left, and
       * while that count is above zero, an edit, unsend, pin or reaction on one of those
       * messages will throw a validation error on save.
       */
      enum: [
        "text", "media", "voice", "location",
        "poll", "sticker", "gif", "system",
        "story_reply", "call", "post_share",
      ],
      default: "text",
    },

    // ── Ephemerality ──────────────────────────────────────────
    expiresAt:          { type: Date },
    selfDestructSeconds: { type: Number },
    isEphemeral:        { type: Boolean, default: false },

    /*
     * ── Status (sender-facing tick; per-user read state is ConversationRead) ─
     *
     * `"read"` used to be here and is gone. It was a single field shared by every
     * recipient, so one member of a group opening the thread marked the message read
     * for all of them — which is why read state became a per-user watermark. Nothing
     * had written it since; 32 stored rows still carried it, and
     * `npm run chat:types` retyped them to "delivered" before this narrowing (CF12).
     *
     * Same caution as the messageType enum above: run `npm run chat:types:verify`
     * against any environment that hasn't had the migration.
     */
    status: {
      type: String,
      enum: ["sending", "sent", "delivered", "failed"],
      default: "sent",
    },

    /*
     * ── Media ─────────────────────────────────────────────────
     *
     * `_id: false` on every embedded schema in this file, matching Post.js, which
     * does it on all of its. Mongoose gives each subdocument an ObjectId by
     * default, and nothing here addresses one: media is identified by url, poll
     * options by their own `id`, votes by `userId`, and reaction-summary entries
     * and history versions by position. On the highest-write collection in the app
     * that is twelve bytes plus a key per subdocument, indexed by nothing, on
     * every message — and it is shipped to the client on every read.
     *
     * Capped at MAX_MEDIA_PER_MESSAGE by config/socket.js's parseSendPayload; the
     * cap lives there because the upload path is where a client can grow it.
     */
    media: [{
      _id:        false,
      /*
       * No "document": see the `messageType` note above. The purge script empties the
       * `media` array of every message that had one, so nothing stored carries it.
       */
      type:       { type: String, enum: ["image", "video", "gif", "audio", "voice", "sticker"] },
      url:        { type: String, required: true },
      thumbnail:  String,
      filename:   String,
      fileSize:   Number,
      duration:   Number,
      /*
       * The recorded amplitude envelope of a voice note, 0-1 per sample.
       *
       * This field did not exist, and its absence was invisible: the browser captured
       * real samples, the upload endpoint validated and returned them, and the socket
       * send path carried them all the way to `new Message(...)` — where Mongoose's
       * strict mode silently dropped the unknown path. So every voice note in the
       * database has no waveform, and the bubble falls back to a synthetic sine
       * strip, which is why they all look identical.
       *
       * `default: undefined` rather than `[]`, matching Post.js, so a message with no
       * waveform has no key instead of an empty array every reader has to test.
       */
      waveform:   { type: [Number], default: undefined },
      dimensions: { width: Number, height: Number },
      caption:    String,
      isSpoiler:  { type: Boolean, default: false },
    }],

    // ── Reply / forward ───────────────────────────────────────
    replyTo: { type: Schema.Types.ObjectId, ref: "Message" },

    isForwarded:  { type: Boolean, default: false },

    /*
     * How many times *this* message has been forwarded.
     *
     * Top-level, and separate from `forwardedFrom.forwardCount` below, because the
     * two are different numbers and one field was being made to mean both. The
     * forward path used to `$inc` `forwardedFrom.forwardCount` on the *original*
     * message — a message that was never forwarded from anywhere — which
     * half-populated its `forwardedFrom` block with no `userId` and no
     * `originalMessageId`. Every read path then saw a message that looked like a
     * forward of nothing.
     */
    forwardCount: { type: Number, default: 0, min: 0 },

    forwardedFrom: {
      userId:            { type: Schema.Types.ObjectId, ref: "User" },
      originalMessageId: { type: Schema.Types.ObjectId, ref: "Message" },
      /*
       * How far down a forward chain this copy is: 1 for a forward of an
       * original, 2 for a forward of that, and so on. Copies were created with 0
       * regardless, so a chain never accumulated and "forwarded many times"
       * could never be derived.
       */
      forwardCount:      { type: Number, default: 0, min: 0 },
    },

    // ── Reactions: cached top-3 summary; full data in MessageReaction ─
    reactionSummary: {
      total: { type: Number, default: 0 },
      top:   [{ _id: false, emoji: String, count: Number }],
      /*
       * A monotonic counter for the summary, not a timestamp.
       *
       * The refresh is a read-modify-write across two collections, so two
       * concurrent reactions can interleave and the slower one would persist a
       * snapshot taken before the faster one's write — a count that stays wrong
       * until somebody reacts again. A write only lands if it is at least as recent
       * as the stored one, which makes the last reader the winner regardless of who
       * finishes first.
       *
       * A `Date` was the obvious choice and the wrong one: with more than one Node
       * process the comparison is between two machines' wall clocks, so a process
       * whose clock runs ahead can block the other's writes until real time catches
       * up. `$inc` is monotonic by construction and the database is the only thing
       * counting. See _refreshReactionSummary.
       */
      seq:   { type: Number, default: 0 },
    },

    // ── Mentions / hashtags ───────────────────────────────────
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
    hashtags: [{ type: String, lowercase: true }],

    // ── Specialized payloads ──────────────────────────────────
    /*
     * Poll state, embedded.
     *
     * Post.js moved its poll votes out to their own collection, and the argument
     * for that was unbounded growth: a public post's poll can be voted on by
     * anyone, so the array has no ceiling. A chat poll's does — it can only be
     * voted on by the participants of one conversation, and groups are capped at
     * MAX_GROUP_MEMBERS (512) in groupController. With `allowMultipleAnswers` and
     * ten options that is at most ~5k vote subdocuments of about forty bytes,
     * which is bounded and far under the BSON ceiling.
     *
     * So this stays embedded deliberately, not by omission. What did need fixing
     * was the *concurrency*: voting used to load the document, rewrite every
     * option's array in memory and save the whole thing, so two people voting at
     * the same moment lost one of the two votes. See voteInPoll.
     */
    poll: {
      // Capped, unlike every other string on this schema. Nothing bounded it, so
      // a poll's question could be arbitrarily large — stored once, broadcast to
      // every member, and re-sent in full on every vote.
      question: { type: String, maxlength: 300 },
      options: [{
        _id:       false,
        id:        { type: String, required: true },
        text:      { type: String, required: true, maxlength: 100 },
        votes:     [{ _id: false, userId: { type: Schema.Types.ObjectId, ref: "User" }, votedAt: Date }],
        voteCount: { type: Number, default: 0, min: 0 },
      }],
      allowMultipleAnswers: { type: Boolean, default: false },
      isAnonymous:          { type: Boolean, default: false },
      expiresAt:            Date,
      totalVotes:           { type: Number, default: 0, min: 0 },
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

    call: {
      type:         { type: String, enum: ["voice", "video"] },
      duration:     Number,
      status:       { type: String, enum: ["missed", "answered", "rejected"] },
      participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
      startedAt:    Date,
      endedAt:      Date,
    },

    /**
     * A group event — "Ana changed the group name", "Ben added Cal".
     *
     * `messageType: "system"` has been in the enum from the start and nothing has ever
     * written one. This is the shape that makes it usable.
     *
     * **Structured, not a rendered sentence.** Storing "Ana added Ben" as `content`
     * would be less code and three things worse: the names couldn't link to profiles,
     * the string couldn't be translated, and — the one that actually matters — it bakes
     * one viewer's perspective into a row every member reads. Ben needs to see "Ana
     * added you", and that is not a substitution you can do on a finished sentence.
     *
     * `actor` is who did it; `targets` is who it was done to (several, for an add);
     * `value` carries the new name for a rename or the new role for a role change.
     * `system` messages stay server-only — `CLIENT_MESSAGE_TYPES` excludes the type, so
     * a client cannot forge a notice that renders as an official one.
     */
    system: {
      kind: {
        type: String,
        enum: [
          "group_renamed",
          "group_avatar_changed",
          "members_added",
          "member_removed",
          "member_left",
          "member_joined",
          "role_changed",
        ],
      },
      actor:   { type: Schema.Types.ObjectId, ref: "User" },
      targets: [{ type: Schema.Types.ObjectId, ref: "User" }],
      value:   String,
    },

    /**
     * A post, comment or profile shared into the chat.
     *
     * `post` / `comment` / `profile` is the live reference — the card renders the
     * current version, so edits show up and the tap-through always lands on the
     * real thing. `snapshot` is only a fallback: once the original is deleted the
     * reference resolves to nothing, and without it the bubble would go blank
     * and the conversation would stop making sense.
     *
     * A profile share carries no content of its own, so it reuses the author
     * fields of the snapshot to name the account and nothing else — a shared
     * profile must not freeze a copy of someone's bio or counts in a message
     * document that outlives them.
     *
     * These all still travel as `messageType: "post_share"`. The type is the
     * envelope ("this bubble is a shared-content card") and `kind` says what's
     * inside; splitting the envelope per kind would mean revisiting every
     * bubble, preview, forward and snapshot-stripping path for no behavioural
     * gain. The type's name is now narrower than its meaning.
     */
    sharedContent: {
      kind:    { type: String, enum: ["post", "comment", "profile"] },
      post:    { type: Schema.Types.ObjectId, ref: "Post" },
      comment: { type: Schema.Types.ObjectId, ref: "Comment" },
      profile: { type: Schema.Types.ObjectId, ref: "User" },
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
    /*
     * Previous versions, oldest first — capped and `select: false`, matching
     * Post.js, whose comment explains both.
     *
     * It was neither. Every thread read shipped every prior revision of every
     * message to the client, and the socket edit path had no time window at all
     * before 8a, so a client could grow one message's history without limit —
     * 10,000 characters per entry on the app's highest-write collection.
     *
     * Anything that wants it asks for it: `.select("+editHistory")`.
     */
    editHistory: {
      type: [{ _id: false, content: String, editedAt: Date }],
      default: [],
      select: false,
    },

    isPinned: { type: Boolean, default: false },
    pinnedAt: Date,
    pinnedBy: { type: Schema.Types.ObjectId, ref: "User" },

  },
  { timestamps: true }
);

/*
 * Exactly one of `receiver` and `group`.
 *
 * Both are optional on the schema, so a row with neither — or with both — was
 * perfectly valid, and five socket handlers plus two controllers dereference
 * `message.receiver.toString()` to decide who to notify. Round 1 guarded those
 * derefs (see chatAccess.conversationRoom), which stopped the 500s; the schema
 * still permitted the row that caused them, so nothing prevented one being
 * written tomorrow by a path nobody has looked at.
 *
 * A `validate` on the document rather than on either path, because the rule is
 * about the pair. `isGroupMessage` is checked with it: it is what every read
 * filter branches on, so a group message flagged as a DM is invisible in one
 * half of the app and present in the other.
 */
messageSchema.pre("validate", function (next) {
  /*
   * Only for a new document, or one where the routing itself is being changed.
   *
   * Mongoose validates unmodified paths on save(), so an unconditional check here
   * would 500 every unsend, edit and pin of any stored row that already violates
   * it — the exact trap CF14 describes for narrowing an enum. The point of this
   * hook is to stop such a row being *written*; retiring the ones that exist is a
   * migration, not a validator.
   */
  if (
    !this.isNew &&
    !this.isModified("receiver") &&
    !this.isModified("group") &&
    !this.isModified("isGroupMessage")
  ) {
    return next();
  }

  const hasReceiver = Boolean(this.receiver);
  const hasGroup = Boolean(this.group);

  if (hasReceiver === hasGroup) {
    return next(
      new Error(
        hasReceiver
          ? "A message cannot have both a receiver and a group"
          : "A message needs either a receiver or a group"
      )
    );
  }
  if (hasGroup !== Boolean(this.isGroupMessage)) {
    return next(new Error("isGroupMessage must agree with whether a group is set"));
  }
  next();
});

/*
 * Was this document new? Captured in pre-save, read in post-save.
 *
 * `this.isNew` is already false by the time a post-save hook runs, and the activity
 * update below must fire for a *new* message and not for an edit, an unsend or a pin —
 * those save the same document again and would otherwise re-stamp the conversation as
 * freshly active, floating an edited old message to the top of everyone's chat list.
 *
 * A symbol rather than a field, so it can never be mistaken for schema state or
 * serialised into a response.
 */
const WAS_NEW = Symbol("wasNew");

messageSchema.pre("save", function (next) {
  this[WAS_NEW] = this.isNew;
  next();
});

/*
 * Keep each participant's chat-list ordering current.
 *
 * A hook, rather than a call at each of the eight places that create a Message: a
 * denormalised field maintained by eight callers is one that will be correct in seven of
 * them. This is the same reasoning as utils/groupCounts.js, arrived at the same way.
 *
 * Deliberately not awaited, and it swallows its own errors. The message is already
 * written and broadcast by the time this runs; failing the send because a cache of list
 * ordering could not be updated would be trading the product for the index of it. The
 * backfill script is the repair for anything this drops.
 */
messageSchema.post("save", function (doc) {
  if (!this[WAS_NEW]) return;
  // `touchConversationActivity` never rejects — it logs and swallows — so there is no
  // catch here to add. A static import is safe because that module reaches only
  // ConversationRead and GroupMember, neither of which imports this one.
  touchConversationActivity(doc);
});

/*
 * ── Indexes ───────────────────────────────────────────────────
 *
 * One per query shape this collection actually serves. Every index is paid for
 * on every insert, and this is the highest-write collection in the app, so an
 * index nothing reads is a permanent tax.
 *
 * Removed, with the query that would have justified each: a text index on
 * content/caption/question (both search endpoints use $regex, never $text, and
 * Mongo allows only one text index per collection while charging the most to
 * maintain it); {mentions} and {hashtags} (write-only fields — nothing filters
 * messages by either); the field-level index:true on conversation and sender
 * (strict prefixes of the compounds below); and single-field indexes on the
 * messageType and status enums, which are near-zero cardinality and are only
 * ever queried alongside a conversation.
 */

// Primary read path: conversation history newest-first. Also serves the unread
// count (conversation + createdAt range) and slow mode (conversation + sender).
messageSchema.index({ conversation: 1, createdAt: -1 });

// "Messages I sent" / "messages sent to me". The receiver half was missing
// entirely, and in an $or MongoDB will collection-scan unless *every* clause is
// indexed — so the chat list, the unread count and the share-target ranking
// were each scanning the whole collection. The old compound
// {sender, receiver, createdAt} could never serve a receiver-led query, since
// receiver was its second key.
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ receiver: 1, createdAt: -1 });

messageSchema.index({ group: 1, createdAt: -1 });

// Ephemerality TTL
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Pinned messages, in pinned order. Without pinnedAt the sort happened in
// memory, which throws a 32MB blocking-sort error on a busy conversation.
messageSchema.index({ conversation: 1, isPinned: 1, pinnedAt: -1 });

/*
 * One message per (sender, clientId) — what makes a retried send idempotent.
 *
 * Partial rather than sparse: sparse skips a *missing* field but not a null one,
 * and `Group.inviteLink` was a latent E11000 for exactly that reason. Only rows
 * that actually carry a string participate, so every server-generated message —
 * shares, forwards, polls, call logs — is unaffected.
 */
messageSchema.index(
  { sender: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: "string" } } }
);

// ── Helpers ───────────────────────────────────────────────────
/*
 * Conversation keys are lowercased before they are compared or joined.
 *
 * An ObjectId's own toString() is already lowercase, but these are also called
 * with raw strings straight off a request, and uppercase hex is a perfectly
 * valid ObjectId string. Two things then went wrong at once: the key literal
 * differed from the one every other write produced, and because 'A' < 'a' the
 * sort order flipped as well, so the two halves of the same pair could order
 * differently. Mongoose still cast `receiver` correctly, so the message was
 * stored and acked to the sender — and was invisible to both parties forever.
 */
const normaliseId = (value) =>
  String(value?._id ?? value ?? "").toLowerCase();

messageSchema.statics.dmConversationKey = function (userAId, userBId) {
  const a = normaliseId(userAId);
  const b = normaliseId(userBId);
  return a < b ? `${a}:${b}` : `${b}:${a}`;
};

messageSchema.statics.groupConversationKey = function (groupId) {
  return `g:${normaliseId(groupId)}`;
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

/*
 * An unbounded array of 10,000-character strings would grow the document without
 * limit, so history is capped — the same number as Post.js.
 *
 * Unlike Post.js this keeps the most *recent* twenty and drops the oldest, rather
 * than preserving the original and dropping from the middle. Two reasons: a
 * message can only be edited for fifteen minutes after it is sent, so there is no
 * "what did this say last year" case that makes the original special, and the
 * trimming happens inside an atomic `$push`/`$slice` — Post.js's rule needs the
 * whole array in memory, which would mean an extra read on a hot path for a field
 * that is now `select: false`.
 */
export const MAX_EDIT_HISTORY = 20;

/**
 * Edit message content — saves history, sets isEdited flag.
 *
 * `editHistory` is `select: false` now, so a document loaded without it has an
 * empty array here and pushing would silently discard everything already stored.
 * The push is done as an atomic `$push` with `$slice` instead, which needs neither
 * the array in memory nor a length check.
 */
messageSchema.methods.editContent = async function (newContent) {
  const previous = { content: this.content, editedAt: this.editedAt || this.createdAt };
  this.content = newContent;
  this.isEdited = true;
  this.editedAt = new Date();
  await this.save();

  await this.model("Message").updateOne(
    { _id: this._id },
    {
      $push: {
        editHistory: { $each: [previous], $slice: -MAX_EDIT_HISTORY },
      },
    }
  );
};

/**
 * Add or replace a reaction from userId.
 * Upserts a MessageReaction row and refreshes reactionSummary.
 *
 * The emoji is validated here as well as at each entry point. This method is the
 * last thing between an untrusted string and a row that gets cached onto the
 * message and rebroadcast to the room, and it is called from three places — a
 * check at the callers only is a check the fourth caller won't have.
 *
 * `runValidators` matters for the same reason: an upsert doesn't run them by
 * default, so `emoji`'s `required` never fired and omitting the field stored the
 * string "undefined".
 */
messageSchema.methods.addReaction = async function (userId, emoji, skinTone = 1) {
  const reaction = parseReactionEmoji(emoji);
  if (!reaction) throw new Error("That isn't an emoji");

  const MessageReaction = (await import("./MessageReaction.js")).default;
  await MessageReaction.updateOne(
    { message: this._id, user: userId },
    { $set: { emoji: reaction, skinTone: parseSkinTone(skinTone) } },
    { upsert: true, runValidators: true }
  );
  await this._refreshReactionSummary();
};

/** Remove userId's reaction. */
messageSchema.methods.removeReaction = async function (userId) {
  const MessageReaction = (await import("./MessageReaction.js")).default;
  await MessageReaction.deleteOne({ message: this._id, user: userId });
  await this._refreshReactionSummary();
};

/**
 * Recompute and save the reactionSummary cache.
 *
 * Two things were wrong with the old version, and they compound.
 *
 * It loaded *every* reaction row for the message into Node and counted them in
 * JavaScript, on every single add and remove — so a message with a thousand
 * reactions did a thousand-document read per tap, with no rate limit in front of
 * it until 8c. The grouping happens in the database now and only the top three
 * come back, so the work is bounded by the number of *distinct emoji* rather than
 * by the number of reactions.
 *
 * And it was an unguarded read-modify-write across two collections: two people
 * reacting at the same moment could interleave so that the slower request wrote a
 * snapshot taken before the faster one's row existed, leaving a count that stayed
 * wrong until somebody reacted again.
 *
 * The fix is a sequence number claimed *before* the reactions are read. `$inc`
 * returning the new value is atomic, so two concurrent recomputes take two distinct
 * tickets in the order the database handed them out, and each write refuses to land
 * if the stored ticket has moved on. Whoever read last wins, rather than whoever
 * finished last.
 */
messageSchema.methods._refreshReactionSummary = async function () {
  const MessageReaction = (await import("./MessageReaction.js")).default;

  /*
   * The ticket, taken before the read.
   *
   * A timestamp was the obvious choice and the wrong one: across two Node processes
   * it compares two machines' wall clocks, so a process whose clock runs ahead
   * blocks the other's writes until real time catches up. The database is the only
   * thing counting here.
   */
  const claimed = await this.model("Message")
    .findOneAndUpdate(
      { _id: this._id },
      { $inc: { "reactionSummary.seq": 1 } },
      { new: true, projection: { "reactionSummary.seq": 1 } }
    )
    .lean();
  const seq = claimed?.reactionSummary?.seq ?? 0;

  const grouped = await MessageReaction.aggregate([
    { $match: { message: this._id } },
    { $group: { _id: "$emoji", count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    {
      $group: {
        _id: null,
        total: { $sum: "$count" },
        top: { $push: { emoji: "$_id", count: "$count" } },
      },
    },
    { $project: { _id: 0, total: 1, top: { $slice: ["$top", 3] } } },
  ]);

  const summary = grouped[0] ?? { total: 0, top: [] };

  /*
   * Only if nobody has claimed a later ticket since.
   *
   * `$lte`, not `$lt`: this recompute's own `$inc` above left the stored value *at*
   * `seq`, so equality is the ordinary case — a later claim pushes it past `seq` and
   * this write correctly does nothing.
   */
  await this.model("Message").updateOne(
    { _id: this._id, "reactionSummary.seq": { $lte: seq } },
    {
      $set: {
        "reactionSummary.total": summary.total,
        "reactionSummary.top": summary.top,
      },
    }
  );

  this.reactionSummary = { total: summary.total, top: summary.top, seq };
};

/**
 * Drop every reaction on this message and zero the cached summary.
 *
 * Unsend left the reaction rows behind along with a non-zero `reactionSummary`
 * on the tombstone, so "This message was deleted" rendered with three hearts
 * under it and the rows stayed in MessageReaction with nothing pointing at them.
 * Called from both unsend paths, HTTP and socket.
 */
messageSchema.methods.clearReactions = async function () {
  const MessageReaction = (await import("./MessageReaction.js")).default;
  await MessageReaction.deleteMany({ message: this._id });
  /*
   * The ticket is bumped past anything in flight, so a recompute that read the rows
   * a moment before this delete cannot land its old count on the tombstone. The
   * caller's own `save()` persists it — this runs inside unsend, which saves anyway.
   */
  this.reactionSummary = {
    total: 0,
    top: [],
    seq: (this.reactionSummary?.seq ?? 0) + 1,
  };
};

/**
 * Advance the sender-facing single tick.
 *
 * Per-recipient delivery is a watermark (ConversationRead.lastDeliveredAt), not
 * a row per recipient.
 */
messageSchema.methods.markAsDelivered = async function () {
  if (this.status === "sent") {
    await this.model("Message").updateOne({ _id: this._id }, { $set: { status: "delivered" } });
    this.status = "delivered";
  }
};

/*
 * markAsRead is deliberately gone.
 *
 * It set `status: "read"` on the document, which is a single field shared by
 * every recipient — so one member of a group opening the thread marked the
 * message read for all of them, and it dropped out of everyone's unread count
 * at once. Read state is per-user by construction now: see
 * utils/readState.js and models/ConversationRead.js.
 */

/**
 * Record one person's vote, replacing whatever they had chosen before.
 *
 * This used to rewrite every option's `votes` array in memory and `save()` the
 * whole document, so two people voting within the same round trip lost one of the
 * two votes outright — last write wins, and the loser got a success response.
 *
 * Three targeted updates instead. Each is atomic on its own, and none of them
 * carries a copy of anyone else's votes, so concurrent voters can't overwrite each
 * other:
 *
 *   1. Remove this user's votes from every option. `$pull` with `$[]` reaches into
 *      all of them.
 *   2. Add them to the chosen ones. `$pull` and `$push` on the same path can't be
 *      combined in one update — Mongo rejects it as a conflict — hence two.
 *   3. Recompute `voteCount` and `totalVotes` *from the arrays* as an aggregation
 *      pipeline update, so the denormalised counts are derived rather than
 *      incremented and cannot drift from the data they summarise.
 *
 * Between (1) and (2) the voter briefly has no vote recorded. That is visible only
 * as a momentarily lower count, and it self-corrects; the alternative is losing a
 * vote permanently.
 */
messageSchema.methods.voteInPoll = async function (userId, optionIds) {
  if (!this.poll) throw new Error("This message is not a poll");

  // Deduplicated: without this, ["a","a","a"] on a multi-answer poll pushes one
  // vote per repetition from a single user, inflating voteCount and growing the
  // embedded votes[] array without bound.
  const ids = [...new Set(Array.isArray(optionIds) ? optionIds : [optionIds])];
  if (!this.poll.allowMultipleAnswers && ids.length > 1) {
    throw new Error("Multiple answers not allowed for this poll");
  }
  // Only options this poll actually has. An unknown id used to be silently
  // ignored, which reported a vote that was never cast.
  const known = new Set((this.poll.options || []).map((o) => o.id));
  const chosen = ids.filter((id) => known.has(id));
  if (ids.length && !chosen.length) throw new Error("That isn't an option on this poll");

  const Model = this.model("Message");

  await Model.updateOne(
    { _id: this._id },
    { $pull: { "poll.options.$[].votes": { userId } } }
  );

  if (chosen.length) {
    await Model.updateOne(
      { _id: this._id },
      { $push: { "poll.options.$[option].votes": { userId, votedAt: new Date() } } },
      { arrayFilters: [{ "option.id": { $in: chosen } }] }
    );
  }

  await Model.updateOne({ _id: this._id }, [
    {
      $set: {
        "poll.options": {
          $map: {
            input: "$poll.options",
            as: "o",
            in: { $mergeObjects: ["$$o", { voteCount: { $size: "$$o.votes" } }] },
          },
        },
      },
    },
    {
      $set: {
        "poll.totalVotes": { $sum: "$poll.options.voteCount" },
      },
    },
  ]);

  // Refresh the in-memory copy so callers broadcasting from it send the new state
  // rather than the one they loaded.
  const fresh = await Model.findById(this._id).select("poll").lean();
  if (fresh?.poll) this.poll = fresh.poll;
};

export default model("Message", messageSchema);
