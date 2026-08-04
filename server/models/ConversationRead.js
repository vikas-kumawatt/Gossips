import { Schema, model } from "mongoose";

/**
 * ConversationRead — one user's view of one conversation.
 *
 * Two things live here, on one row per (user, conversation): how far through it they
 * have read, and when it last had activity.
 *
 * The second is what makes the chat list a paged query instead of a scan (CF23/CF24).
 * `getChats` used to `$group` every message the caller had ever sent or received to
 * find the newest per conversation — bounded in what it *returned*, by capping at 500,
 * but not in the work it did: `$group` consumes every match, and past a couple of
 * hundred groups the planner stops being able to explode-for-sort and falls back to a
 * blocking sort that spills to disk. On the app's most-called endpoint, marked
 * `no-store`. Sorting rows that already say when each conversation last moved is
 * O(page), and it gives the list a real cursor rather than a silent truncation.
 *
 * It is deliberately *this* collection rather than a new one. The key would have been
 * identical — {user, conversation} — and two collections on one key means two writes,
 * two indexes and two chances to disagree about which conversations a user is in.
 *
 * The cost is write fan-out: a group message touches one row per member, capped at
 * MAX_GROUP_MEMBERS (512) and issued as a single bulkWrite. That is the right side to
 * pay on. The chat list is polled and uncached, so reads outnumber sends by orders of
 * magnitude, and a bounded write beats an unbounded read.
 *
 * Why a watermark:
 *
 *   This replaced a receipt collection holding one row per user *per message*.
 *   A thousand-member group wrote a thousand rows for every message sent,
 *   forever, and answering "how many unread do I have" from it would have been
 *   an anti-join over that set. It was never actually read — so unread came
 *   from `Message.status` instead, a single field shared by every recipient.
 *   That was the group bug: one member opening the thread marked the message
 *   read for all two hundred, and it vanished from everyone's badge at once.
 *
 *   A watermark is one row per conversation, written once when you open a chat.
 *   Unread is `createdAt > lastReadAt`, which the existing
 *   {conversation, createdAt} index already serves. Per-user by construction,
 *   so the group case is right for free. It also answers the sender's side:
 *   "have they seen this?" is `theirLastReadAt >= message.createdAt`, with no
 *   per-message write at all.
 *
 * The tradeoff is that read state is a point in time, not a set. You cannot ask
 * "which specific messages did they skip", and marking one message read marks
 * everything before it read too. That matches how the product behaves anyway —
 * opening a thread reads all of it.
 */
const conversationReadSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // "smallerId:largerId" for a DM, "g:<groupId>" for a group.
    // Matches Message.conversation exactly.
    conversation: { type: String, required: true },

    // Epoch default rather than null: it keeps every comparison a date
    // comparison, so a conversation with no row yet is simply all-unread
    // instead of a special case at each call site.
    lastReadAt: { type: Date, default: () => new Date(0) },

    // Advanced when the thread is fetched. Drives the sender's single tick.
    lastDeliveredAt: { type: Date, default: () => new Date(0) },

    /*
     * ── Activity, for ordering and paging the chat list ───────────────────────
     *
     * `lastMessageAt` is the newest message's `createdAt`, not the time the row was
     * written: the two differ for a backfill and for a forward, and the list has to sort
     * by when the message happened.
     *
     * Kept as a pair with `lastMessageId` by a single pipeline update, so they can never
     * describe different messages — see utils/conversationActivity.js.
     *
     * No default. Absent means "this row predates the activity fields", which the
     * backfill looks for; a default of epoch would make those rows indistinguishable
     * from conversations that genuinely have no messages.
     */
    lastMessageAt: { type: Date },
    lastMessageId: { type: Schema.Types.ObjectId, ref: "Message" },

    /*
     * Whether this conversation is a group, denormalised.
     *
     * Derivable from the `g:` prefix on `conversation`, and duplicated anyway so the
     * `view=groups` tab can be a real indexed predicate instead of a prefix regex — an
     * unanchored one can't use an index at all, and `^g:` would still leave the sort
     * unindexed. One boolean written once per row, never updated: a conversation cannot
     * change kind.
     */
    isGroup: { type: Boolean, default: false },

    /*
     * When this user last deleted the conversation, or absent if they never have.
     *
     * The chat list is built from these rows, while `deleteChat` marks messages
     * `deletedFor` on `Message` — so a delete emptied the thread but did nothing to
     * the row, and the conversation came back on the next fetch with no preview. The
     * old `Message` `$group` aggregation hid it as a side effect of every message
     * being deleted; moving the list onto this collection lost that without
     * replacing it.
     *
     * A watermark rather than a flag, so the row is hidden only while nothing newer
     * than the delete exists. A conversation you deleted *should* return when the
     * other person writes again — the alternative is silently dropping their message.
     * `getChats` compares it against `lastMessageAt`.
     *
     * No default: absent means never deleted, and `$ifNull` treats it as epoch.
     */
    clearedAt: { type: Date },
  },
  { timestamps: true }
);

// One row per (user, conversation), and the lookup for "my watermarks".
conversationReadSchema.index({ user: 1, conversation: 1 }, { unique: true });

// "Who in this conversation has read up to when" — the sender's Seen state.
conversationReadSchema.index({ conversation: 1, lastReadAt: -1 });

/*
 * The chat list: one user's conversations, newest activity first.
 *
 * `_id` is in the key because the cursor pages on (lastMessageAt, _id) — two
 * conversations can share a millisecond, and without the tiebreak in the index the
 * boundary comparison sorts in memory.
 */
conversationReadSchema.index({ user: 1, lastMessageAt: -1, _id: -1 });

/*
 * The Groups tab, same ordering.
 *
 * A separate index rather than filtering the one above, because `isGroup` sits between
 * the equality key and the sort key — a compound index can only serve a sort if the
 * fields before it are all equality matches, so `{user, lastMessageAt}` cannot answer
 * "my groups, newest first" without sorting the result.
 */
conversationReadSchema.index({ user: 1, isGroup: 1, lastMessageAt: -1, _id: -1 });

export default model("ConversationRead", conversationReadSchema);
