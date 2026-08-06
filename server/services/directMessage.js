import User from "../models/User.js";
import Message from "../models/Message.js";
import UserRelation from "../models/UserRelation.js";
import { getIO } from "../config/socket.js";
import { getSettings } from "../utils/settings.js";
import { DM_SENT, announce } from "../utils/appEvents.js";
import { parseSendPayload } from "../utils/messageContent.js";
import { messageEntities } from "../utils/mentions.js";
import { sendPushNotification } from "../utils/pushNotifications.js";
import {
  ACTIVE_ACCOUNT,
  MAX_TTL_SECONDS,
  conversationTtlSeconds,
  isConversationMuted,
  messageableIdSet,
  resolveReplyTo,
} from "../utils/chatAccess.js";

/**
 * Send a direct message. The only path that creates one.
 *
 * ── Why this is the most important extraction in the phase ──────────────────
 *
 * There is no HTTP route that sends a DM. The only way to create one was the
 * `socket.on("sendMessage")` handler, so anything that wasn't a websocket client — a bot,
 * a scheduled job, an admin tool — simply could not. `writeGroupEvent` already reimplements
 * a slice of this for system notices, which is what a missing abstraction looks like just
 * before it becomes two.
 *
 * Everything here is the handler's own logic, moved verbatim and in the same order. The
 * comments came with it, because each one records a bug that was found the hard way: the
 * canonical-id conversation key, the self-note double delivery, the ephemeral TTL that a
 * negative payload turned into an instant unsend, the clientId idempotency, the populated
 * `replyTo` that stopped a reply preview collapsing a second after send. Losing any of them
 * in the move would reintroduce a fixed bug with no trace of why.
 *
 * ── What stays in the socket handler ────────────────────────────────────────
 *
 * Only what is genuinely about sockets: proving `senderId` matches the authenticated
 * socket, `inSendOrder` serialisation, and turning the result into `fail`/`ack`. Everything
 * else — validation, permissions, persistence, delivery, push, chat-list updates — is here,
 * so a bot goes through the same gates in the same sequence.
 *
 * @returns `{ ok: true, message, messageObject, receiverOnline }`
 *          or `{ ok: false, error }`
 */
export const sendDirectMessage = async ({
  senderId,
  receiverId,
  content,
  media,
  messageType = "text",
  replyTo,
  /** The client's own id, for idempotency. `tempId` at the socket layer. */
  clientId,
  isEphemeral = false,
  selfDestructTimer,
  /**
   * The sender's role, for the maintenance and feature-flag gate below.
   *
   * Passed in rather than looked up, so the gate can run *first* — before payload
   * validation and before any query, exactly where the handler had it. Looking the role up
   * here would mean loading the sender first and reordering the checks, which changes which
   * error a caller sees when two conditions are wrong at once.
   *
   * Undefined is treated as a non-admin, so a caller that forgets to pass it gets the
   * stricter behaviour rather than an accidental bypass.
   */
  actorRole,
}) => {
  /*
   * Maintenance mode and the messaging feature flag, admins exempt.
   *
   * Moved from `messagingBlockedReason(socket)`, which only ever read `socket.userRole` and
   * the app settings. Bots are ordinary `role: "user"` accounts, so a platform-wide
   * messaging pause stops them too — which is the point of having the switch.
   */
  if (!["admin", "super_admin"].includes(actorRole)) {
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      // The fallback matters: `maintenanceMessage` is admin-editable with no minimum
      // length, and an empty one would switch maintenance mode off entirely here.
      return { ok: false, error: settings.maintenanceMessage || "Gossips is down for maintenance." };
    }
    if (!settings.directMessagesEnabled) {
      return { ok: false, error: "Messaging is temporarily disabled." };
    }
  }

  const payload = parseSendPayload({ content, media, messageType });
  if (payload.error) return { ok: false, error: payload.error };

  if (!receiverId) return { ok: false, error: "No recipient" };

  /*
   * `ACTIVE_ACCOUNT` on the receiver: `/share` has always filtered deleted and suspended
   * accounts and this path didn't, so a DM to a deleted account succeeded over the socket
   * and was stored forever.
   */
  const [sender, receiver] = await Promise.all([
    User.findById(senderId).select("username name profilePic isVerified").lean(),
    User.findOne({ _id: receiverId, ...ACTIVE_ACCOUNT })
      .select("username name profilePic isVerified")
      .lean(),
  ]);

  if (!sender || !receiver) return { ok: false, error: "User not found" };

  if (await UserRelation.eitherBlocks(senderId, receiver._id)) {
    return { ok: false, error: "Cannot send message to blocked user" };
  }

  // whoCanMessage, through the same helper /share and forwarding use.
  const messageable = await messageableIdSet(senderId, [receiver._id]);
  if (!messageable.has(receiver._id.toString())) {
    return { ok: false, error: "They don't accept messages from you" };
  }

  /*
   * Everything below uses the id the database returned, not the string the caller sent.
   * `dmConversationKey` sorts raw strings, so an uppercase-hex receiverId produces a
   * different key and the message lands in a conversation neither party's thread query will
   * ever match — and the delivery emit would miss too.
   */
  const receiverKey = receiver._id.toString();
  const conversation = Message.dmConversationKey(senderId, receiverKey);

  const messageData = {
    sender: senderId,
    receiver: receiver._id,
    conversation,
    content: payload.content,
    media: payload.media,
    replyTo: await resolveReplyTo(replyTo, { conversation, userId: senderId }),
    messageType: payload.messageType,
    ...(await messageEntities(payload.content)),
    // The caller's own id, so a retry finds this row rather than writing a second one —
    // see the {sender, clientId} unique index on Message.
    ...(typeof clientId === "string" && clientId ? { clientId } : {}),
    status: "sent",
  };

  /*
   * Disappearing messages.
   *
   * The conversation's stored setting decides this, not the payload. The client used to send
   * `selfDestructTimer` and the server applied it verbatim with no validation — so a
   * negative value produced an `expiresAt` in the past and the TTL index removed the message
   * within the minute, which is an unsend with no time limit. A caller may still shorten the
   * life of its own message, but only within a sane range and never below whatever the
   * conversation already agreed.
   */
  const ttlSeconds = await conversationTtlSeconds(conversation, [senderId, receiver._id]);
  const requested = Number(selfDestructTimer);
  const clientTtl =
    isEphemeral && Number.isInteger(requested) && requested > 0 && requested <= MAX_TTL_SECONDS
      ? requested
      : null;
  const effectiveTtl =
    ttlSeconds && clientTtl ? Math.min(ttlSeconds, clientTtl) : ttlSeconds ?? clientTtl;

  if (effectiveTtl) {
    messageData.isEphemeral = true;
    messageData.selfDestructSeconds = effectiveTtl;
    messageData.expiresAt = new Date(Date.now() + effectiveTtl * 1000);
  }

  /*
   * A retry finds the first attempt's row instead of writing a second.
   *
   * The unique {sender, clientId} index turns the second attempt into an E11000, and
   * answering it with the existing message means the retry is indistinguishable from a slow
   * first attempt — which is what idempotency means.
   */
  let message;
  try {
    message = new Message(messageData);
    await message.save();
  } catch (saveError) {
    if (saveError?.code !== 11000 || !messageData.clientId) throw saveError;
    const existing = await Message.findOne({
      sender: senderId,
      clientId: messageData.clientId,
    });
    if (!existing) throw saveError;
    message = existing;
  }

  await message.populate([
    { path: "sender", select: "username name profilePic isVerified" },
    { path: "receiver", select: "username name profilePic isVerified" },
    /*
     * `replyTo` was not populated at all, so the echo carried a raw ObjectId. The client
     * merges the echo over its optimistic object, which meant the rich reply preview the
     * sender was already looking at collapsed into an empty box about a second after
     * sending. Same shape as the REST read, so both paths render identically.
     */
    {
      path: "replyTo",
      select: "content messageType media isDeleted sender createdAt",
      populate: { path: "sender", select: "username name" },
    },
  ]);

  const messageObject = message.toObject();
  const io = getIO();

  /*
   * A note to self is one message, not two.
   *
   * When sender and receiver are the same account the "emit to receiver" pass below reaches
   * the sending socket, so the message arrived twice — once as incoming, from yourself, and
   * once as your own. The sender echo alone is the correct delivery for this case.
   */
  const isSelfNote = receiverKey === senderId.toString();

  /*
   * Delivered to the receiver's *room*, and counted through the adapter, so a recipient
   * connected to another instance is still reached.
   */
  const receiverOnline = isSelfNote
    ? false
    : (await io.in(receiverKey).fetchSockets()).length > 0;

  if (receiverOnline) {
    io.to(receiverKey).emit("receiveMessage", { ...messageObject, tempId: clientId, isOwn: false });
    await message.markAsDelivered();
  }

  /*
   * The sender's *room*, not the sending socket, so a second tab or another device learns
   * about a message this account just sent. `tempId` is harmless in the other tabs: they
   * have no optimistic bubble to reconcile, so nothing matches it.
   */
  io.to(senderId.toString()).emit("receiveMessage", {
    ...messageObject,
    tempId: clientId,
    isOwn: true,
  });

  /*
   * Push when the receiver is offline, unless they've muted this conversation. Both skips
   * are logged: silence here is indistinguishable from a broken FCM setup, which is exactly
   * how that gets misdiagnosed.
   */
  if (receiverOnline) {
    console.log("Push: skipped, recipient is connected", { to: receiverKey });
  } else if (isSelfNote) {
    // Nobody to notify. Reached only for a note to self, where `receiverOnline` is forced
    // false above — without this it would push the sender about their own message.
    console.log("Push: skipped, note to self", { to: receiverKey });
  } else {
    const muted = await isConversationMuted(receiver._id, `user_${senderId}`);
    if (muted) {
      console.log("Push: skipped, conversation muted", { to: receiverKey });
    } else {
      await sendPushNotification(receiver, {
        title: sender.name || sender.username,
        body: payload.content || (payload.media.length ? "Sent a media" : "Sent a message"),
        data: {
          kind: "message",
          conversation,
          senderId: senderId.toString(),
          senderUsername: sender.username,
        },
      });
    }
  }

  /*
   * Chat list update for both users.
   *
   * `unreadCount` is omitted for the receiver rather than asserted. It used to be hard-coded
   * to 1, which is only right when they had no unread messages in that thread already — the
   * badge showed "1" over a conversation with thirty unread. The client increments its own
   * count from this event and reconciles against /chats/unread-count.
   */
  const chatUpdateForReceiver = { user: sender, latestMessage: messageObject };
  const chatUpdateForSender = {
    user: receiver,
    latestMessage: messageObject,
    unreadCount: 0,
  };

  io.to(senderId.toString()).emit("chatUpdated", chatUpdateForSender);
  if (receiverOnline) {
    io.to(receiverKey).emit("chatUpdated", chatUpdateForReceiver);
  }

  /*
   * Announce, so a bot recipient can reply quickly.
   *
   * Via the event bus rather than a direct call, because the responder has to send a message and
   * would therefore import this module back — see utils/appEvents.js. `announce` swallows listener
   * errors: the message is already stored and delivered, and nothing a listener does should be
   * able to turn that into a failed send.
   *
   * Every DM passes through here, including bot-to-bot and notes to self. Deciding which of those
   * deserve a reply is the responder's job, not this one's — a service that knows about bots is a
   * service with two audiences.
   */
  announce(DM_SENT, {
    conversation,
    senderId: senderId.toString(),
    receiverId: receiver._id.toString(),
    messageId: message._id.toString(),
  });

  return { ok: true, message, messageObject, receiverOnline };
};
