import mongoose from "mongoose";
import ConversationRead from "../models/ConversationRead.js";
import GroupMember from "../models/GroupMember.js";

/**
 * Keeping `ConversationRead.lastMessageAt` current.
 *
 * This is what turns the chat list from a scan into a paged query — see the model for
 * why. It is one module, called from one hook, for the reason `utils/groupCounts.js`
 * exists: there are eight places in this codebase that create a `Message`, and a
 * denormalised field maintained by eight callers is a field that will be right in seven
 * of them. `Message.create` and `new Message()` both go through `save()`, so a single
 * `post("save")` hook covers every one of them and any future site for free.
 *
 * The fan-out is the cost of the design. A DM touches two rows; a group touches one per
 * member, capped at 512 by groupController and issued as a single `bulkWrite`. Paying on
 * write is right here: the chat list is `no-store` and polled, so reads outnumber sends
 * by orders of magnitude.
 */

/*
 * Never `await`ed by the send path.
 *
 * A failure to update the ordering must not fail a message that has already been
 * written and broadcast — the message is the product, the row is a cache of where it
 * sits in a list. So this logs and swallows, and the backfill script is the repair.
 */
export const touchConversationActivity = async (message) => {
  try {
    const conversation = message.conversation;
    if (!conversation) return;

    const participants = await participantsOf(message);
    if (!participants.length) return;

    await ConversationRead.bulkWrite(
      activityUpdateOps({
        conversation,
        createdAt: message.createdAt ?? new Date(),
        messageId: message._id,
        isGroup: Boolean(message.isGroupMessage),
        participants,
      }),
      // Unordered: one member's row failing must not stop the rest of the group's.
      { ordered: false }
    );
  } catch (error) {
    console.error("Conversation activity update failed:", {
      conversation: message?.conversation,
      messageId: message?._id?.toString(),
      error: error.message,
    });
  }
};

/**
 * The `bulkWrite` ops that advance one conversation's activity for a set of users.
 *
 * Separated from the hook because `scripts/backfillConversationActivity.js` writes the
 * same rows from a different starting point — an aggregation over history rather than a
 * single saved document — and two copies of this update would be two chances to
 * disagree about what a row means.
 */
export const activityUpdateOps = ({ conversation, createdAt, messageId, isGroup, participants }) =>
  participants.map((user) => ({
    updateOne: {
      filter: { user, conversation },
      /*
       * A pipeline update, so the timestamp and the id move together.
       *
       * `$max` alone would advance `lastMessageAt` without touching `lastMessageId`,
       * leaving the row pointing at an older message than the one it claims to be from —
       * the chat list would show the wrong preview. A pipeline can make the second field
       * conditional on the same comparison, so the pair is always consistent.
       *
       * Written as "only move forward" rather than "set": messages do not always arrive
       * in `createdAt` order (a forward copies the original's timestamp, and the backfill
       * walks history), and a late arrival must not drag a conversation back down the
       * list. It is also what makes the backfill safe to run against a live database — it
       * cannot regress a row the hook has already moved past.
       *
       * "Cannot regress" is not "writes nothing": Mongoose stamps `updatedAt` into a
       * pipeline update, so issuing this against an already-current row still counts as a
       * modification. That is why `scripts/backfillConversationActivity.js` decides what
       * to write by comparison instead of trusting `modifiedCount`.
       */
      update: [
        {
          $set: {
            lastMessageAt: {
              $max: [{ $ifNull: ["$lastMessageAt", new Date(0)] }, createdAt],
            },
            lastMessageId: {
              $cond: [
                { $gte: [createdAt, { $ifNull: ["$lastMessageAt", new Date(0)] }] },
                messageId,
                "$lastMessageId",
              ],
            },
            isGroup: Boolean(isGroup),
            // A pipeline update replaces the document, so every field the schema defaults
            // has to be carried through or it is lost on upsert.
            lastReadAt: { $ifNull: ["$lastReadAt", new Date(0)] },
            lastDeliveredAt: { $ifNull: ["$lastDeliveredAt", new Date(0)] },
          },
        },
      ],
      upsert: true,
    },
  }));

/**
 * Everyone whose chat list this message belongs in.
 *
 * For a DM that is both parties — including the sender, whose own list has to reorder
 * too. For a group it is the current membership, read fresh rather than from the socket
 * room: the room only holds members who are online, and this has to reach the people who
 * aren't, which is the whole point of a chat list.
 *
 * Banned members are excluded, matching every other membership query — a banned member
 * has no row in the member list, the counts or the group's rooms, so they should not get
 * the conversation in their list either.
 */
const participantsOf = async (message) => {
  if (message.isGroupMessage) {
    if (!message.group) return [];
    return groupParticipants(message.group);
  }

  return [message.sender, message.receiver].filter(Boolean);
};

const groupParticipants = async (groupId) => {
  const members = await GroupMember.find({ group: groupId, isBanned: { $ne: true } })
    .select("user")
    .lean();
  return members.map((m) => m.user);
};

/**
 * The same set, derived from a conversation key instead of a message.
 *
 * The backfill starts from an aggregation over `conversation`, so it never has a message
 * document in hand — but the key already encodes the participants of a DM, and a group's
 * come from the same membership query the hook uses.
 */
export const participantsOfConversation = async (conversation) => {
  if (typeof conversation !== "string" || !conversation) return [];

  if (conversation.startsWith("g:")) {
    const groupId = conversation.slice(2);
    return mongoose.isValidObjectId(groupId) ? groupParticipants(groupId) : [];
  }

  // Exactly two ids, and deduplicated: a key with any other shape is not a DM this app
  // wrote, and a self-conversation ("id:id") is one participant, not two rows.
  const parts = conversation.split(":");
  if (parts.length !== 2 || !parts.every((id) => mongoose.isValidObjectId(id))) return [];
  return [...new Set(parts)].map((id) => new mongoose.Types.ObjectId(id));
};

/**
 * The cursor predicate for `(lastMessageAt, _id)`, newest first.
 *
 * Not `withCursor` from cursorPagination: that one pages on `createdAt` by default and
 * takes the field name as a string, which would work — but the tiebreak here has to be
 * `_id` *descending* alongside a descending date, and getting that pair wrong silently
 * skips or repeats rows at a page boundary rather than failing. Spelled out once.
 */
export const activityCursorFilter = (cursor) => {
  if (!cursor?.lastMessageAt || !cursor?._id) return {};
  const at = new Date(cursor.lastMessageAt);
  const id = mongoose.isValidObjectId(cursor._id)
    ? new mongoose.Types.ObjectId(cursor._id)
    : cursor._id;

  return {
    $or: [{ lastMessageAt: { $lt: at } }, { lastMessageAt: at, _id: { $lt: id } }],
  };
};

export const encodeActivityCursor = (row) =>
  row?.lastMessageAt && row?._id
    ? Buffer.from(
        JSON.stringify({
          lastMessageAt: new Date(row.lastMessageAt).toISOString(),
          _id: row._id.toString(),
        })
      ).toString("base64url")
    : null;

export const decodeActivityCursor = (cursor) => {
  if (typeof cursor !== "string" || !cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return decoded?.lastMessageAt && decoded?._id ? decoded : null;
  } catch {
    return null;
  }
};
