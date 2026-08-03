import mongoose from "mongoose";
import ConversationRead from "../models/ConversationRead.js";
import Message from "../models/Message.js";
import UserRelation from "../models/UserRelation.js";
import { audienceAllows, privacyOf } from "./chatAccess.js";

/**
 * Reading and advancing the per-conversation read watermark.
 *
 * Everything that used to be spread across `Message.status`, a per-message
 * receipt collection and two arrays of chat ids in `UserSettings` lives here
 * instead. See models/ConversationRead.js for why it's a watermark.
 */

export const EPOCH = new Date(0);

/** Messages that count toward someone's unread: not theirs, not deleted. */
const unreadableBy = (userId) => ({
  sender: { $ne: userId },
  isDeleted: { $ne: true },
  deletedFor: { $ne: userId },
});

/**
 * `{ conversation -> { lastReadAt } }` from rows already in hand.
 *
 * This replaced `readWatermarks`, which took a user id and ran its own query. Since
 * CF23/CF24 both callers — the chat list and the unread badge — select the rows for other
 * reasons and already hold them, so re-reading them was a second round trip on the app's
 * hottest endpoint for data sitting in a local variable. They each built this Map inline
 * instead, which is two copies of one shape: the map is consumed by `lastReadAt` below and
 * by `unreadCountsByConversation` through it, so its key name is a contract between three
 * files.
 *
 * `lastDeliveredAt` is deliberately not here. The old version carried it and nothing ever
 * read it off the map — delivery is advanced and stored, never compared through a
 * watermark map — so including it would mean writing an epoch for a field the callers
 * don't select, which is a value that looks like data and isn't.
 */
export const watermarksFromRows = (rows = []) =>
  new Map(rows.map((row) => [row.conversation, { lastReadAt: row.lastReadAt || EPOCH }]));

export const lastReadAt = (watermarks, conversation) =>
  watermarks.get(conversation)?.lastReadAt || EPOCH;

/**
 * Move the watermark forward. Returns the timestamp now in effect.
 *
 * `$max` rather than `$set`: two tabs marking the same thread read race each
 * other, and the older one must not drag the watermark backwards and resurrect
 * messages the user has already seen.
 */
const advance = async (userId, conversation, field, at) => {
  const update = { $max: { [field]: at }, $setOnInsert: { user: userId, conversation } };
  try {
    return await ConversationRead.findOneAndUpdate({ user: userId, conversation }, update, {
      new: true,
      upsert: true,
      projection: { lastReadAt: 1 },
    }).lean();
  } catch (error) {
    // Two tabs opening a never-before-read conversation at the same instant
    // both take the insert path and one loses the unique index. Retrying finds
    // the row the other one created.
    if (error?.code !== 11000) throw error;
    return ConversationRead.findOneAndUpdate({ user: userId, conversation }, update, {
      new: true,
      projection: { lastReadAt: 1 },
    }).lean();
  }
};

export const markConversationRead = async (userId, conversation, at = new Date()) => {
  const row = await advance(userId, conversation, "lastReadAt", at);
  return row?.lastReadAt || at;
};

/** Same, for delivery. Cheap enough to fire on every thread fetch. */
export const markConversationDelivered = async (userId, conversation, at = new Date()) => {
  await advance(userId, conversation, "lastDeliveredAt", at);
};

/**
 * Start these users' watermarks at "now" for a conversation.
 *
 * Called when people are added to a group. A conversation with no row reads as
 * all-unread from the epoch, which is right for a DM — you have genuinely never
 * read it — but wrong for a group you were just added to: every message posted
 * before you arrived would land in your badge. Seeding at join time means you
 * start from what happens next.
 *
 * `$setOnInsert` only, so re-adding somebody who was in the group before
 * doesn't rewind or advance a watermark they already have.
 */
export const seedConversationRead = async (userIds, conversation, at = new Date()) => {
  if (!userIds?.length) return;
  await ConversationRead.bulkWrite(
    userIds.map((user) => ({
      updateOne: {
        filter: { user, conversation },
        update: { $setOnInsert: { user, conversation, lastReadAt: at, lastDeliveredAt: at } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
};

/** Unread in one conversation, given the watermark now in effect. */
export const unreadCountFor = async (userId, conversation, readAt) =>
  Message.countDocuments({
    conversation,
    createdAt: { $gt: readAt },
    ...unreadableBy(userId),
  });

/**
 * Deliberately move the watermark *backwards*, to just before the newest
 * message the user didn't send — "mark as unread".
 *
 * This used to be a `manualUnreadChats` array, paired with a `forcedReadChats`
 * array that opening a chat wrote to. The pair was the bug: `forcedReadChats`
 * zeroed the count and was only ever cleared by an explicit mark-as-unread, so
 * once you had opened a conversation it could never show a badge again. With a
 * watermark there is one piece of state and both directions just move it.
 *
 * Returns `null` when there is nothing inbound to mark, or the resulting unread
 * count.
 *
 * The count is returned rather than assumed to be 1, which is what the client
 * optimistically showed. The watermark lands one millisecond before the newest
 * inbound message, so *every* message sharing that millisecond reads as unread —
 * two messages sent in the same tick both count, and the badge said 1 while the
 * next fetch said 2 (CF8). Rather than chase the millisecond, the endpoint now
 * reports the real number and the client renders that.
 */
export const markConversationUnread = async (userId, conversation) => {
  const newest = await Message.findOne({ conversation, ...unreadableBy(userId) })
    .sort({ createdAt: -1 })
    .select("createdAt")
    .lean();

  if (!newest) return null;

  // One millisecond before it, so that message itself reads as unread.
  const readAt = new Date(new Date(newest.createdAt).getTime() - 1);
  await ConversationRead.updateOne(
    { user: userId, conversation },
    {
      $set: { lastReadAt: readAt },
      $setOnInsert: { user: userId, conversation },
    },
    { upsert: true }
  );
  return { readAt, unreadCount: await unreadCountFor(userId, conversation, readAt) };
};

/**
 * Unread counts per conversation, in one query.
 *
 * Each conversation carries its own threshold, so this is an index-OR: every
 * clause is `{conversation, createdAt: {$gt}}`, which the existing
 * `{conversation: 1, createdAt: -1}` index serves as a short range scan.
 * Conversations the user has never opened are matched from the epoch, which is
 * the same shape — no special case.
 */
export const unreadCountsByConversation = async (userId, conversations, watermarks) => {
  if (!conversations.length) return new Map();

  const clauses = conversations.map((conversation) => ({
    conversation,
    createdAt: { $gt: lastReadAt(watermarks, conversation) },
  }));

  const rows = await Message.aggregate([
    { $match: { $or: clauses, ...unreadableBy(userId) } },
    { $group: { _id: "$conversation", count: { $sum: 1 } } },
  ]);

  return new Map(rows.map((r) => [r._id, r.count]));
};

/**
 * Which of `ownerIds` are willing to show `viewerId` their read state.
 *
 * The socket emit path checks this; the two REST paths that expose a peer's
 * watermark have to as well, or turning read receipts off would stop the live
 * event and still leak the exact timestamp on every thread and chat-list load.
 */
const receiptsVisibleTo = async (viewerId, ownerIds) => {
  const allowed = new Set();
  if (!ownerIds.length) return allowed;

  await Promise.all(
    ownerIds.map(async (ownerId) => {
      const privacy = await privacyOf(ownerId);
      if (!privacy.readReceipts) return;
      if (await UserRelation.eitherBlocks(viewerId, ownerId)) return;
      if (!(await audienceAllows(viewerId, ownerId, privacy.whoCanSeeReadReceipts))) return;
      allowed.add(ownerId.toString());
    })
  );
  return allowed;
};

/**
 * How far each *other* participant has read, for the conversations given.
 * This is what turns the sender's tick into "Seen" without writing anything
 * per message.
 */
export const peerReadWatermarks = async (userId, conversations) => {
  if (!conversations.length) return new Map();

  const rows = await ConversationRead.find({
    conversation: { $in: conversations },
    user: { $ne: userId },
  })
    .select("conversation user lastReadAt")
    .lean();

  const visible = await receiptsVisibleTo(userId, [
    ...new Set(rows.map((r) => r.user.toString())),
  ]);

  // Newest read wins: in a group, "seen" means at least one other person has.
  const byConversation = new Map();
  for (const row of rows) {
    if (!visible.has(row.user.toString())) continue;
    const current = byConversation.get(row.conversation);
    if (!current || row.lastReadAt > current) {
      byConversation.set(row.conversation, row.lastReadAt || EPOCH);
    }
  }
  return byConversation;
};

/** The watermark of one specific person, for a DM's Seen state. */
export const peerReadAt = async (viewerId, peerId, conversation) => {
  if (!mongoose.isValidObjectId(peerId)) return EPOCH;

  const visible = await receiptsVisibleTo(viewerId, [peerId]);
  if (!visible.has(peerId.toString())) return EPOCH;

  const row = await ConversationRead.findOne({ user: peerId, conversation })
    .select("lastReadAt")
    .lean();
  return row?.lastReadAt || EPOCH;
};

/**
 * The chat list's id for a conversation key. The two namespaces exist because
 * the list is addressed by peer/group and the messages by conversation; this is
 * the single place that translates, so they can't drift.
 */
export const chatIdForConversation = (conversation, userId) => {
  if (typeof conversation !== "string") return null;
  if (conversation.startsWith("g:")) return `group_${conversation.slice(2)}`;
  const me = userId.toString();
  const peer = conversation.split(":").find((id) => id !== me);
  return peer ? `user_${peer}` : null;
};

/** The other party in a DM conversation key, or null for a group key. */
export const dmPeerId = (conversation, userId) => {
  if (typeof conversation !== "string" || conversation.startsWith("g:")) return null;
  const [a, b] = conversation.split(":");
  const me = userId.toString();
  if (a === me) return b;
  if (b === me) return a;
  return null;
};

/**
 * Tell the other side of a DM that their messages have been read.
 *
 * Takes `io` rather than importing it: `config/socket.js` uses this helper, so
 * reaching back into it for `getIO` would be a cycle.
 *
 * This is where `privacy.readReceipts` and `whoCanSeeReadReceipts` are finally
 * honoured — both have existed in the settings screen since the beginning and
 * were read by nothing. Turning receipts off stops the emit, not the read: the
 * reader's own watermark still advances, so their badge still clears.
 *
 * Group read receipts aren't emitted at all. Nothing renders them, and "seen"
 * in a room of two hundred isn't a single fact.
 */
export const notifyConversationRead = async ({ io, userId, conversation, readAt }) => {
  if (!io) return;
  const peer = dmPeerId(conversation, userId);
  if (!peer) return;

  const [privacy, blocked] = await Promise.all([
    privacyOf(userId),
    UserRelation.eitherBlocks(userId, peer),
  ]);
  if (!privacy.readReceipts || blocked) return;
  if (!(await audienceAllows(peer, userId, privacy.whoCanSeeReadReceipts))) return;

  io.to(peer).emit("conversationRead", { conversation, readBy: userId.toString(), readAt });
};
