import Message from "../models/Message.js";
import { getIO, notifyGroupMembers } from "../config/socket.js";
import { getSettings } from "../utils/settings.js";
import { parseSendPayload } from "../utils/messageContent.js";
import { resolveGroupSend, resolveReplyTo } from "../utils/chatAccess.js";
import { messageEntities } from "../utils/mentions.js";

/**
 * Sending a message to a group.
 *
 * Extracted from `socket.on("sendGroupMessage")` for the same reason
 * `directMessage.js` was extracted from its handler: the logic was reachable
 * only by something holding a socket. That meant no HTTP fallback when the
 * connection drops, no way for a bot to post to a group, and no way to test any
 * of it without standing up a socket server.
 *
 * The code below is the handler's code, in the handler's order, with two
 * substitutions and nothing else:
 *
 *   · `socket.userId`  becomes the `senderId` argument
 *   · `socket.userRole` becomes `actorRole`, so the caller states the role
 *     rather than the function reaching into a connection for it
 *
 * Everything it depends on — `parseSendPayload`, `resolveGroupSend`,
 * `resolveReplyTo`, `messageEntities` — was already shared with `/share`,
 * forwarding and poll creation, which is why this is a move rather than a
 * rewrite.
 *
 * @returns {Promise<{ok: true, message, messageObject, group} | {ok: false, error: string}>}
 *   The same contract the other services use: `ok: false` with a human-readable
 *   reason for a refusal, a throw only for something genuinely unexpected.
 */
export const sendGroupMessage = async ({
  senderId,
  groupId,
  content,
  media,
  messageType = "text",
  replyTo,
  /** The client's own id, for idempotency. `tempId` at the socket layer. */
  clientId,
  /**
   * The sender's role, for the gate below. Passed in rather than looked up so it
   * can run *first* — before validation and before any query — exactly where the
   * handler had it. See the same note in directMessage.js.
   */
  actorRole,
}) => {
  /*
   * Maintenance mode and the messaging flag, admins exempt.
   *
   * `directMessagesEnabled` governs groups too, matching HTTP: `/share` sits
   * behind `requireMessagingEnabled` and can target a group. The handler had no
   * gate at all before it was added there, which meant maintenance mode stopped
   * direct messages and left every group in the app running.
   */
  if (!["admin", "super_admin"].includes(actorRole)) {
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      // The fallback matters: `maintenanceMessage` is admin-editable with no
      // minimum length, and an empty one would switch maintenance mode off here.
      return { ok: false, error: settings.maintenanceMessage || "Gossips is down for maintenance." };
    }
    if (!settings.directMessagesEnabled) {
      return { ok: false, error: "Messaging is temporarily disabled." };
    }
  }

  const payload = parseSendPayload({ content, media, messageType });
  if (payload.error) return { ok: false, error: payload.error };

  // Membership, group liveness, role permissions, mute, media rules and slow
  // mode — all of it, and the same check /share and forwarding use.
  const access = await resolveGroupSend(groupId, senderId, { media: payload.media });
  if (!access.ok) return { ok: false, error: access.reason };

  const { group } = access;

  /*
   * Canonical id: rooms are keyed by the group's own `_id`, so a differently-cased
   * groupId from the client would broadcast to nothing.
   */
  const groupKey = group._id.toString();
  const conversation = Message.groupConversationKey(groupKey);

  const messageData = {
    sender: senderId,
    group: group._id,
    isGroupMessage: true,
    conversation,
    content: payload.content,
    media: payload.media,
    replyTo: await resolveReplyTo(replyTo, { conversation, userId: senderId }),
    messageType: payload.messageType,
    ...(await messageEntities(payload.content)),
    // Same idempotency as the DM path — see the note there.
    ...(typeof clientId === "string" && clientId ? { clientId } : {}),
    status: "sent",
  };

  let message;
  try {
    message = new Message(messageData);
    await message.save();
  } catch (saveError) {
    /*
     * A duplicate key is only an idempotent retry when there is a clientId to
     * have collided on. Anything else is a real error and must not be swallowed.
     */
    if (saveError?.code !== 11000 || !messageData.clientId) throw saveError;
    const existing = await Message.findOne({
      sender: senderId,
      clientId: messageData.clientId,
    });
    if (!existing) throw saveError;
    message = existing;
  }

  // Same shape as the DM echo and the REST read — see the note there.
  await message.populate([
    { path: "sender", select: "username name profilePic isVerified" },
    {
      path: "replyTo",
      select: "content messageType media isDeleted sender createdAt",
      populate: { path: "sender", select: "username name" },
    },
  ]);

  const messageObject = message.toObject();
  const io = getIO();
  const senderKey = senderId.toString();

  /*
   * `io.to(room).except(sender)` rather than the handler's `socket.to(room)`.
   *
   * `socket.to()` broadcasts to a room excluding the socket it is called on, and
   * there is no socket here. Every user joins a room named after their own id on
   * connect, so excluding that room is the same exclusion — and it is better than
   * the original in one respect: it also excludes the sender's *other* tabs from
   * the `isOwn: false` copy, which would otherwise render the message as though
   * somebody else had sent it.
   */
  io.to(groupKey).except(senderKey).emit("receiveGroupMessage", {
    ...messageObject,
    tempId: clientId,
    isOwn: false,
  });

  // The sender's own copy, to every tab they have open.
  io.to(senderKey).emit("receiveGroupMessage", {
    ...messageObject,
    tempId: clientId,
    isOwn: true,
  });

  /*
   * Offline members, minus anyone who muted this group. Best effort: a failed push
   * must not fail a message that is already saved and delivered.
   */
  try {
    await notifyGroupMembers(group._id, senderId, {
      title: group.name,
      body: `${message.sender?.name || message.sender?.username || "Someone"}: ${
        payload.content || (payload.media?.length ? "Sent media" : "Sent a message")
      }`,
      data: { messageId: message._id, groupId: group._id },
    });
  } catch (error) {
    console.error("Group push fan-out failed:", error?.message ?? error);
  }

  return { ok: true, message, messageObject, group };
};
