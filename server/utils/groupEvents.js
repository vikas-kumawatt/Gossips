import Message from "../models/Message.js";
import { getIO } from "../config/socket.js";

/**
 * Write a group event into the thread, and deliver it live.
 *
 * `messageType: "system"` was in the Message enum from the start with nothing to write
 * it, so a group's history showed messages and nothing else — a rename, an eviction and
 * a new admin all happened invisibly. This is the one writer.
 *
 * Deliberately mirrors `saveCallLog` in config/socket.js, which is the existing
 * precedent for "the server mints a message nobody sent":
 *
 *   save → populate → emit `receiveMessage` → emit `chatUpdated`
 *
 * Skipping the emits would still put the row in the database and still move the
 * conversation up the list (the `post("save")` hook on Message updates
 * `ConversationRead` for every writer), but the open thread wouldn't show it until a
 * refetch — which is exactly the gap call logs had.
 *
 * Never throws. A failed notice must not fail the rename that caused it: the rename is
 * the product, the notice is commentary on it. Callers do not await this.
 *
 * @param {object}   event
 * @param {ObjectId} event.groupId
 * @param {ObjectId} event.actorId  Who performed the action.
 * @param {string}   event.kind     One of Message.system.kind.
 * @param {Array}    [event.targets] Who it was done to.
 * @param {string}   [event.value]  New name, or new role.
 */
export const writeGroupEvent = async ({ groupId, actorId, kind, targets = [], value }) => {
  try {
    if (!groupId || !actorId || !kind) return;

    const message = new Message({
      sender: actorId,
      conversation: Message.groupConversationKey(groupId),
      group: groupId,
      isGroupMessage: true,
      messageType: "system",
      status: "sent",
      system: { kind, actor: actorId, targets, value },
    });

    await message.save();

    /*
     * Populated the way the client reads it: the bubble names people, so `actor` and
     * `targets` have to be documents rather than ids. `sender` too, because the shared
     * MessageList groups by sender and reads `sender._id`.
     */
    await message.populate([
      { path: "sender", select: "username name profilePic isVerified" },
      { path: "system.actor", select: "username name profilePic" },
      { path: "system.targets", select: "username name profilePic" },
    ]);

    const payload = message.toObject();
    const room = groupId.toString();

    /*
     * One emit to the group room, with no `isOwn`.
     *
     * A DM's call log needs a payload per side because `isOwn` decides which row the
     * chat list bumps. A group event is addressed to the room, and the client derives
     * ownership from `sender._id` — so a single emit is correct here and a per-member
     * one would be a lie for everyone but the actor.
     */
    const io = getIO();
    io.to(room).emit("receiveMessage", payload);
    io.to(room).emit("chatUpdated", { groupId, latestMessage: payload });
  } catch (error) {
    console.error("writeGroupEvent failed:", {
      group: groupId?.toString(),
      kind,
      error: error.message,
    });
  }
};

export default writeGroupEvent;
