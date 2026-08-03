import { Server } from "socket.io";
import Message from "../models/Message.js";
import User from "../models/User.js";
import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import UserSettings from "../models/UserSettings.js";
import mongoose from "mongoose";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { JWT_VERIFY_OPTIONS } from "./jwt.js";
import { ALLOWED_ORIGINS } from "./origins.js";
import { getSettings } from "../utils/settings.js";
import { parseReactionEmoji, parseSkinTone } from "../utils/reactions.js";
import { recomputeGroupCounts } from "../utils/groupCounts.js";
import {
  CLIENT_MESSAGE_TYPES,
  EDITABLE_MESSAGE_TYPES,
  MAX_CONTENT_LENGTH,
  MAX_MEDIA_PER_MESSAGE,
  MEDIA_TYPES,
} from "../utils/messageContent.js";
import { resolveMessageMentions } from "../utils/mentions.js";
import { parseHashtags } from "../utils/richText.js";
import { scrub } from "../middleware/sanitizeMongo.js";
import { isAllowedGif, stripMediaToken, verifyMedia } from "../utils/mediaToken.js";
import {
  ACTIVE_ACCOUNT,
  MAX_RECIPIENTS,
  audienceAllows,
  blockedIdSet,
  canReadConversation,
  cleanIds,
  conversationRoom,
  MAX_TTL_SECONDS,
  conversationTtlSeconds,
  isConversationMuted,
  isGroupMember,
  isMessageParticipant,
  messageableIdSet,
  privacyOf,
  resolveGroupSend,
  resolveReplyTo,
} from "../utils/chatAccess.js";
import { pollFor } from "../utils/pollView.js";
import { sendPushNotification } from "../utils/pushNotifications.js";
import {
  chatIdForConversation,
  markConversationRead,
  notifyConversationRead,
  seedConversationRead,
} from "../utils/readState.js";

/**
 * Mentions and hashtags inside a direct or group message.
 *
 * Resolved from the text, not taken from the payload — the client used to send
 * a `mentions` array that nothing verified, which meant anyone could have
 * written any user id into any message.
 *
 * No permission check and no notification, unlike a post. A mention in a
 * message is a link to a profile between two people already talking, not a way
 * to pull a stranger into a conversation, so there's nothing to gate. Blocked
 * tags aren't filtered either: a private message isn't a discovery surface, and
 * the tag is only ever rendered as text here.
 */
const messageEntities = async (content) => ({
  mentions: (await resolveMessageMentions(content || "")).map((u) => u._id),
  hashtags: parseHashtags(content || ""),
});

/**
 * The admin kill-switches, for every path that creates a message.
 *
 * These have to be applied here because messages are created over the socket,
 * so the Express middleware that enforces them on HTTP routes never sees this
 * traffic. They were applied inline in the DM handler only, which meant
 * maintenance mode stopped direct messages and left every group in the app
 * running. `directMessagesEnabled` covers groups too, matching HTTP: /share
 * sits behind `requireMessagingEnabled` and can target a group.
 *
 * Staff bypass content flags, as they do in middleware/featureGate.js —
 * otherwise disabling messaging would also stop a moderator checking the fix.
 *
 * Returns a reason to refuse, or null to proceed.
 */
const messagingBlockedReason = async (socket) => {
  if (["admin", "super_admin"].includes(socket.userRole)) return null;
  const settings = await getSettings();
  // The fallback matters: maintenanceMessage is an admin-editable string with
  // no minimum length, and callers treat the return value as truthy-or-proceed.
  // An empty message would otherwise switch maintenance mode off entirely.
  if (settings.maintenanceMode) {
    return settings.maintenanceMessage || "Gossips is down for maintenance.";
  }
  // Named for DMs but it gates group sends too, matching HTTP — /share sits
  // behind requireMessagingEnabled and can target a group. The copy is generic
  // because this handler serves both.
  if (!settings.directMessagesEnabled) return "Messaging is temporarily disabled.";
  return null;
};

/**
 * Validate the parts of a send payload both handlers share.
 *
 * Nothing previously required content *or* media, so an empty bubble was a
 * valid message — and at socket speed, a flood primitive.
 *
 * Returns `{ error }` or the cleaned fields.
 */
const parseSendPayload = ({ content, media, messageType }) => {
  const text = typeof content === "string" ? content.trim() : "";
  const items = Array.isArray(media) ? media : [];

  if (!text && !items.length) return { error: "Write something first" };
  if (text.length > MAX_CONTENT_LENGTH) {
    // Caught here rather than by the schema, which would surface as a generic
    // "failed to send" from the catch block.
    return { error: "That message is too long" };
  }
  if (items.length > MAX_MEDIA_PER_MESSAGE) {
    return { error: `Up to ${MAX_MEDIA_PER_MESSAGE} attachments per message` };
  }
  const verified = [];
  for (const item of items) {
    if (!item || typeof item.url !== "string" || !item.url.startsWith("https://")) {
      return { error: "That attachment isn't valid" };
    }
    if (item.type !== undefined && !MEDIA_TYPES.has(item.type)) {
      return { error: "That attachment isn't valid" };
    }
    // The upload endpoint derives `type` from the file it received and signs
    // the result. Checking that signature is what stops a document being
    // relabelled as an image to slip past a group's fileSharing rule, and stops
    // an arbitrary URL being passed off as an upload at all.
    //
    // GIFs are the exception: they're hotlinked from the picker and never
    // uploaded, so there's nothing to have signed. The host allow-list does
    // that job instead.
    if (!isAllowedGif(item) && !verifyMedia(item)) {
      return { error: "That attachment couldn't be verified — try uploading it again" };
    }
    verified.push(stripMediaToken(item));
  }

  if (!CLIENT_MESSAGE_TYPES.has(messageType)) {
    return { error: "Unsupported message type" };
  }
  return { content: text, media: verified, messageType };
};

// Group send permissions — mute, media, slow mode — live in
// chatAccess.resolveGroupSend so that /share, /polls and forwarding apply the
// same rules. See the comment there.

/**
 * Answer the client, whether or not it asked for an answer.
 *
 * Roughly twenty handlers used to `return` on a refusal having emitted nothing —
 * a message the server rejected left the client's optimistic bubble at "sending"
 * forever, with no correction and no way to distinguish "refused" from "slow".
 * Socket.io's ack callback is the right channel for that: it correlates
 * automatically, so a client doesn't have to match an `error` event back to a
 * request by `tempId`.
 *
 * The `error` event is still emitted alongside it, because the existing client
 * listens for that and older builds have no callback to call.
 */
const fail = (socket, message, { tempId, ack } = {}) => {
  socket.emit("error", { message, ...(tempId ? { tempId } : {}) });
  if (typeof ack === "function") ack({ ok: false, error: message, tempId });
};

const succeed = (ack, payload) => {
  if (typeof ack === "function") ack({ ok: true, ...payload });
};

/*
 * One send at a time per user.
 *
 * Each send awaits about six database round trips, so two emitted back to back
 * raced each other and could commit out of order — and the client appends in
 * arrival order without sorting, so the thread showed them reversed. Serialising
 * per user makes arrival order match emit order. Per user rather than per socket,
 * or two tabs would still interleave.
 */
const sendChains = new Map(); // userId -> Promise

const inSendOrder = (userId, task) => {
  const previous = sendChains.get(userId) ?? Promise.resolve();
  // `.then(task, task)` so one failed send doesn't stall everything behind it.
  const settled = previous.then(task, task);
  const chained = settled.then(
    () => {},
    () => {}
  );
  sendChains.set(userId, chained);
  // Drop the entry once this user's queue is empty, so the map tracks people who
  // are currently sending rather than everyone who ever has.
  chained.then(() => {
    if (sendChains.get(userId) === chained) sendChains.delete(userId);
  });
  return settled;
};

let io;
const userSockets = new Map(); // userId -> Set<socketId>
const typingUsers = new Map(); // conversationId -> Set of userIds

// Two maps rather than one. These used to share a single map keyed by both
// callId and userId, so a second concurrent call overwrote the per-user entry
// and orphaned the first callId forever.
const activeCalls = new Map(); // callId -> call data
const callByUser = new Map(); // userId -> callId
const callTimers = new Map(); // callId -> Timeout

// Ceiling on one presence broadcast — see notifyContactsStatus.
const MAX_PRESENCE_FANOUT = 500;

// A ringing call nobody answers and nobody rejects was never removed from the
// map, and each entry holds an SDP blob.
const RING_TIMEOUT_MS = 45_000;
// Backstop for an answered call whose teardown never fires — a refresh
// reconnects inside the disconnect grace, so neither party's disconnect
// handler runs and both stay marked in-call.
const MAX_CALL_MS = 4 * 60 * 60 * 1000;

/**
 * Per-user budgets for socket events.
 *
 * `messageRoutes.js` caps message creation at 60/min and its own comment points
 * here for the real gate — but the gate it meant was the feature flag, not a
 * limit, so nothing counted socket events at all. One client could loop
 * `sendMessage` (about six database round trips each) or `initiateCall` for as
 * long as it liked.
 *
 * Budgets are per user rather than per socket, or opening five tabs would buy
 * five times the allowance.
 */
const RATE_LIMITS = {
  sendMessage: { points: 60, windowMs: 60_000 },
  sendGroupMessage: { points: 60, windowMs: 60_000 },
  createGroup: { points: 5, windowMs: 60_000 },
  initiateCall: { points: 10, windowMs: 60_000 },
  editMessage: { points: 60, windowMs: 60_000 },
  addReaction: { points: 120, windowMs: 60_000 },
  removeReaction: { points: 120, windowMs: 60_000 },
  voteInPoll: { points: 60, windowMs: 60_000 },
  typing: { points: 120, windowMs: 60_000 },
  // The client re-emits this on every change to the message array, so an
  // ordinary busy conversation produces roughly one per message in each
  // direction. Sized well above that — tripping it would toast the user about
  // something they never did.
  markConversationAsRead: { points: 300, windowMs: 60_000 },
  updatePresence: { points: 20, windowMs: 60_000 },
  // Trickle ICE emits dozens of candidates per negotiation. Signalling gets its
  // own bucket so it can't starve the control events below it — running out
  // mid-call would leave a user unable to hang up.
  iceCandidate: { points: 400, windowMs: 60_000 },
  rtcOffer: { points: 60, windowMs: 60_000 },
  rtcAnswer: { points: 60, windowMs: 60_000 },
  answerCall: { points: 30, windowMs: 60_000 },
  rejectCall: { points: 30, windowMs: 60_000 },
  endCall: { points: 30, windowMs: 60_000 },
  // Everything not named above shares one bucket, so a handler added later is
  // limited by default rather than unlimited by default.
  _default: { points: 300, windowMs: 60_000 },
};

const rateBuckets = new Map(); // userId -> Map<ruleKey, { count, resetAt }>

function withinBudget(userId, event) {
  const key = Object.prototype.hasOwnProperty.call(RATE_LIMITS, event) ? event : "_default";
  const rule = RATE_LIMITS[key];

  let buckets = rateBuckets.get(userId);
  if (!buckets) {
    buckets = new Map();
    rateBuckets.set(userId, buckets);
  }

  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return true;
  }
  if (bucket.count >= rule.points) return false;
  bucket.count += 1;
  return true;
}

/** Drop expired buckets so the map tracks live users rather than every user. */
function sweepRateBuckets() {
  const now = Date.now();
  for (const [userId, buckets] of rateBuckets) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    if (buckets.size === 0) rateBuckets.delete(userId);
  }
}

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      /*
       * The same list the HTTP layer uses.
       *
       * This was `process.env.CLIENT_URL || "http://localhost:5173"` — a second
       * copy of the origin policy, and one that fell back to localhost when the
       * variable was unset in production. config/origins.js exists precisely to
       * stop this and says so: one list, because two copies drift.
       */
      origin: ALLOWED_ORIGINS,
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    // The socket.io default. It used to be 1e8 "for large files", but files
    // never travel this way — they go to POST /chats/upload and only the
    // resulting URL is sent here. A 100MB frame budget was purely a way to
    // exhaust the heap.
    maxHttpBufferSize: 1e6,
  });

  // unref'd so it never holds the process open on shutdown.
  setInterval(sweepRateBuckets, 5 * 60 * 1000).unref();

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token ||
                   socket.handshake.headers.authorization?.split(" ")[1];

      if (!token) {
        return next(new Error("Authentication error"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);

      // The socket layer must apply the same rules as HTTP, or a suspended
      // account keeps messaging in real time after being cut off everywhere
      // else. Refresh tokens are rejected for the same reason as in `protect`.
      if (decoded.typ === "refresh") {
        return next(new Error("Authentication error"));
      }

      const user = await User.findById(decoded.id).select(
        "username name profilePic accountStatus role"
      );

      if (!user) {
        return next(new Error("User not found"));
      }
      if (user.accountStatus !== "active") {
        return next(new Error("Account unavailable"));
      }

      socket.userId = user._id.toString();
      socket.username = user.username;
      socket.userRole = user.role;
      next();
    } catch (error) {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.userId}`);

    /**
     * Runs on every inbound packet, before any handler sees it.
     *
     * `server.js` mounts `sanitizeMongo` before every route and its comment
     * says "must run before any route" — but socket.io packets never pass
     * through Express middleware, so none of this traffic was ever scrubbed.
     * `{"messageId": {"$gt": null}}` reaching `findById` returns an arbitrary
     * document. The same scrub runs here, followed by the rate limit that the
     * HTTP layer has and this one didn't.
     */
    socket.use(([event, ...args], next) => {
      args.forEach((arg) => scrub(arg));
      if (!withinBudget(socket.userId, event)) {
        // Emitted rather than handed to next(): socket.io serialises a
        // middleware error as a bare string, and the client reads
        // `payload.message`. Carrying tempId back also lets an optimistic
        // bubble settle as failed instead of sitting at "sending" forever.
        const tempId = args.find((a) => a && typeof a === "object" && a.tempId)?.tempId;
        /*
         * The ack is answered too, not just the error event.
         *
         * Dropping the packet means the handler never runs, so it never calls the
         * callback the sender is awaiting — the send would sit there until the
         * client's own 15-second timeout fired and then report a *connection*
         * problem, overwriting the real reason with a wrong one. The ack is the last
         * argument when the client supplied one.
         */
        const ack = args[args.length - 1];
        socket.emit("error", {
          message: "You're doing that too quickly. Give it a moment.",
          ...(tempId ? { tempId } : {}),
        });
        if (typeof ack === "function") {
          ack({
            ok: false,
            error: "You're doing that too quickly. Give it a moment.",
            ...(tempId ? { tempId } : {}),
          });
        }
        return undefined; // drop the packet
      }
      return next();
    });

    // Store socket connection
    if (!userSockets.has(socket.userId)) {
      userSockets.set(socket.userId, new Set());
    }
    userSockets.get(socket.userId).add(socket.id);

    // Update lastActiveAt (presence/online state lives in userSockets map only)
    updateUserStatus(socket.userId);

    // Join user's personal room
    socket.join(socket.userId);

    /*
     * Awaited before "joined" is emitted.
     *
     * This used to be fire-and-forget with the confirmation sent immediately
     * after, so there was a window in which the client had been told it was
     * ready while its sockets were still outside every group room — messages
     * arriving in it were silently missed.
     */
    joinUserGroups(socket.userId, socket)
      .then(() => {
        socket.emit("joined", {
          success: true,
          userId: socket.userId,
          timestamp: new Date(),
        });

        // A presence snapshot, so the chat list isn't all-grey on load — the
        // server only ever emitted userStatus on a *transition*, so every row
        // showed offline until somebody happened to come or go.
        sendPresenceSnapshot(socket).catch((error) =>
          console.error("presenceSnapshot failed:", error)
        );
      })
      .catch((error) => {
        /*
         * Say so rather than claiming success. A client told `joined` while
         * outside every group room misses every group message for the life of
         * that connection with nothing to indicate it; `joinFailed` lets it
         * reconnect instead of sitting there looking fine.
         */
        console.error("joinUserGroups failed:", error);
        socket.emit("joinFailed", { reason: "Could not join your group rooms" });
      });

    // Notify contacts that user is online
    notifyContactsStatus(socket.userId, true);

    // Handle user joining (for compatibility)
    socket.on("join", async (userId) => {
      if (userId === socket.userId) {
        socket.emit("joined", { success: true, userId });
      }
    });

    // Send private message
    socket.on("sendMessage", (data, ack) =>
      inSendOrder(socket.userId, async () => {
      const tempId = data?.tempId;
      try {
        const {
          senderId,
          receiverId,
          content,
          media,
          replyTo,
          messageType = "text",
          isEphemeral = false,
          selfDestructTimer,
        } = data;

        // Validate sender
        if (senderId !== socket.userId) {
          fail(socket, "Unauthorized", { tempId, ack });
          return;
        }

        const blockedReason = await messagingBlockedReason(socket);
        if (blockedReason) {
          fail(socket, blockedReason, { tempId, ack });
          return;
        }

        const payload = parseSendPayload({ content, media, messageType });
        if (payload.error) {
          fail(socket, payload.error, { tempId, ack });
          return;
        }

        if (!receiverId) {
          fail(socket, "No recipient", { tempId, ack });
          return;
        }

        // Fetch sender and receiver (minimal fields for notification/broadcast).
        // ACTIVE_ACCOUNT on the receiver: /share has always filtered deleted
        // and suspended accounts and this path didn't, so a DM to a deleted
        // account succeeded over the socket and was stored forever.
        const [sender, receiver] = await Promise.all([
          User.findById(senderId).select("username name profilePic isVerified").lean(),
          User.findOne({ _id: receiverId, ...ACTIVE_ACCOUNT })
            .select("username name profilePic isVerified")
            .lean(),
        ]);

        if (!sender || !receiver) {
          fail(socket, "User not found", { tempId, ack });
          return;
        }

        // Block check via UserRelation
        const blocked = await UserRelation.eitherBlocks(senderId, receiver._id);
        if (blocked) {
          fail(socket, "Cannot send message to blocked user", { tempId, ack });
          return;
        }

        // whoCanMessage, through the same helper /share and forwarding use —
        // this was a second inline implementation of one rule.
        const messageable = await messageableIdSet(senderId, [receiver._id]);
        if (!messageable.has(receiver._id.toString())) {
          fail(socket, "They don't accept messages from you", { tempId, ack });
          return;
        }

        // Everything below uses the id the database returned, not the string
        // the client sent. dmConversationKey sorts raw strings, so an
        // uppercase-hex receiverId produces a different key and the message
        // lands in a conversation neither party's thread query will ever match
        // — and userSockets is keyed by canonical id, so the delivery emit
        // would miss too.
        const receiverKey = receiver._id.toString();
        const conversation = Message.dmConversationKey(senderId, receiverKey);

        // Build message doc using new schema
        const messageData = {
          sender: senderId,
          receiver: receiver._id,
          conversation,
          content: payload.content,
          media: payload.media,
          replyTo: await resolveReplyTo(replyTo, { conversation, userId: senderId }),
          messageType: payload.messageType,
          ...(await messageEntities(payload.content)),
          // The client's own id, so a retry finds this row rather than writing a
          // second one — see the {sender, clientId} unique index on Message.
          ...(typeof tempId === "string" && tempId ? { clientId: tempId } : {}),
          status: "sent",
        };

        /*
         * Disappearing messages.
         *
         * The conversation's stored setting decides this, not the payload. The
         * client used to send `selfDestructTimer` and the server applied it
         * verbatim with no validation — so a negative value produced an
         * `expiresAt` in the past and the TTL index removed the message within
         * the minute, which is an unsend with no time limit. Meanwhile the
         * per-chat setting the UI writes was read by nothing.
         *
         * A client may still shorten the life of its own message, but only
         * within a sane range and never below whatever the conversation
         * already agreed.
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
         * There was no idempotency and no ack, so a client that lost the response
         * had no way to tell "refused" from "slow" — and the correct behaviour for
         * it, retrying, duplicated the message. The unique {sender, clientId}
         * index turns the second attempt into an E11000, and answering it with the
         * existing message means the retry is indistinguishable from a slow first
         * attempt, which is what idempotency means.
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
          { path: "sender",   select: "username name profilePic isVerified" },
          { path: "receiver", select: "username name profilePic isVerified" },
          /*
           * replyTo was not populated at all, so the echo carried a raw
           * ObjectId. The client merges the echo over its optimistic object,
           * which meant the rich reply preview the sender was already looking
           * at collapsed into an empty box about a second after sending.
           * Same shape as the REST read, so both paths render identically.
           */
          {
            path: "replyTo",
            select: "content messageType media isDeleted sender createdAt",
            populate: { path: "sender", select: "username name" },
          },
        ]);

        const messageObject = message.toObject();

        /*
         * A note to self is one message, not two.
         *
         * When sender and receiver are the same account the "emit to receiver"
         * pass below reaches this very socket, so the message arrived twice —
         * once as incoming, from yourself, and once as your own. The sender echo
         * alone is the correct delivery for this case.
         */
        const isSelfNote = receiverKey === senderId.toString();

        // Emit to receiver if online
        const receiverSockets = isSelfNote ? null : userSockets.get(receiverKey);
        if (receiverSockets && receiverSockets.size > 0) {
          receiverSockets.forEach(socketId => {
            io.to(socketId).emit("receiveMessage", { ...messageObject, tempId, isOwn: false });
          });

          // Record delivery receipt
          await message.markAsDelivered();
        }

        /*
         * The sender's *room*, not the sending socket.
         *
         * `socket.emit` reaches exactly the one connection that sent the
         * message, so a second tab or another device never learned about a
         * message this account had just sent — the thread was missing it until a
         * reload. shareController gets this right and comments why; the personal
         * room holds every socket this user has open. `tempId` is harmless in the
         * other tabs: they have no optimistic bubble to reconcile, so nothing
         * matches it.
         */
        io.to(senderId.toString()).emit("receiveMessage", { ...messageObject, tempId, isOwn: true });

        /*
         * Push notification when the receiver is offline — unless they've muted this
         * conversation. `mutedChats` was written by the chat menu and read only to draw
         * an icon; muting muted nothing.
         *
         * Both skip conditions are logged. They were silent, and "no notification and
         * nothing in the log" is indistinguishable from a broken FCM setup — which is
         * exactly how it gets misdiagnosed. A recipient who is *online* is the common
         * case and the one people forget: a background tab still holds a socket, so
         * closing the tab is not the same as closing the window.
         */
        if (receiverSockets && receiverSockets.size > 0) {
          console.log("Push: skipped, recipient is connected", {
            to: receiverKey,
            sockets: receiverSockets.size,
          });
        } else {
          const muted = await isConversationMuted(receiver._id, `user_${senderId}`);
          if (muted) {
            console.log("Push: skipped, conversation muted", { to: receiverKey });
          } else {
            await sendPushNotification(receiver, {
              title: sender.name || sender.username,
              body: payload.content || (payload.media.length ? "Sent a media" : "Sent a message"),
              data: { messageId: message._id, senderId },
            });
          }
        }

        /*
         * Chat list update for both users.
         *
         * `unreadCount` is omitted rather than asserted. It used to be
         * hard-coded to 1 for the receiver, which is only right when they had no
         * unread messages in that thread already — the badge showed "1" over a
         * conversation with thirty unread. The client increments its own count
         * from this event and reconciles against /chats/unread-count, which is
         * the one place that knows the real number.
         */
        const chatUpdateForReceiver = { user: sender, latestMessage: messageObject };
        const chatUpdateForSender = {
          user: receiver,
          latestMessage: messageObject,
          unreadCount: 0,
        };

        // Same reasoning as the echo above: every tab this sender has open.
        io.to(senderId.toString()).emit("chatUpdated", chatUpdateForSender);
        if (receiverSockets) {
          receiverSockets.forEach(socketId => {
            io.to(socketId).emit("chatUpdated", chatUpdateForReceiver);
          });
        }

        // The definite answer. A client can now settle its optimistic bubble on
        // this rather than waiting for an echo that may never arrive.
        succeed(ack, { tempId, messageId: message._id.toString() });

      } catch (error) {
        console.error("Error sending message:", error);
        fail(socket, "Failed to send message", { tempId, ack });
      }
      })
    );

    // Send group message
    socket.on("sendGroupMessage", (data, ack) =>
      inSendOrder(socket.userId, async () => {
      const tempId = data?.tempId;
      try {
        const {
          groupId,
          content,
          media,
          replyTo,
          messageType = "text",
        } = data;

        // The same admin gates the DM path applies. This handler had none, so
        // maintenance mode stopped direct messages and left groups running.
        const blockedReason = await messagingBlockedReason(socket);
        if (blockedReason) {
          fail(socket, blockedReason, { tempId, ack });
          return;
        }

        const payload = parseSendPayload({ content, media, messageType });
        if (payload.error) {
          fail(socket, payload.error, { tempId, ack });
          return;
        }

        // Membership, group liveness, role permissions, mute, media rules and
        // slow mode — all of it, and the same check /share and forwarding use.
        const access = await resolveGroupSend(groupId, socket.userId, {
          media: payload.media,
        });
        if (!access.ok) {
          fail(socket, access.reason, { tempId, ack });
          return;
        }
        const { group } = access;

        // Canonical id: rooms are keyed by the group's own _id, so a
        // differently-cased groupId from the client would broadcast to nothing.
        const groupKey = group._id.toString();
        const conversation = Message.groupConversationKey(groupKey);

        const messageData = {
          sender: socket.userId,
          group: group._id,
          isGroupMessage: true,
          conversation,
          content: payload.content,
          media: payload.media,
          replyTo: await resolveReplyTo(replyTo, { conversation, userId: socket.userId }),
          messageType: payload.messageType,
          ...(await messageEntities(payload.content)),
          // Same idempotency as the DM path — see the note there.
          ...(typeof tempId === "string" && tempId ? { clientId: tempId } : {}),
          status: "sent",
        };

        let message;
        try {
          message = new Message(messageData);
          await message.save();
        } catch (saveError) {
          if (saveError?.code !== 11000 || !messageData.clientId) throw saveError;
          const existing = await Message.findOne({
            sender: socket.userId,
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

        // Broadcast to group room; socket.to() excludes the sender
        socket.to(groupKey).emit("receiveGroupMessage", { ...messageObject, tempId, isOwn: false });
        // Confirmation to sender
        socket.emit("receiveGroupMessage", { ...messageObject, tempId, isOwn: true });

        // Offline members, minus anyone who muted this group. The group path
        // notified nobody at all before, which is why muting a group had no
        // observable effect: there was nothing to suppress.
        // The whole group document used to be passed as a third argument and never read.
        await notifyGroupMembers(group._id, socket.userId, {
          title: group.name,
          body: `${message.sender?.name || message.sender?.username || "Someone"}: ${
            payload.content || (payload.media?.length ? "Sent media" : "Sent a message")
          }`,
          data: { messageId: message._id, groupId: group._id },
        });

        succeed(ack, { tempId, messageId: message._id.toString() });

      } catch (error) {
        console.error("Error sending group message:", error);
        fail(socket, "Failed to send group message", { tempId, ack });
      }
      })
    );

    // Get user online status (presence from socket map; lastActiveAt from DB)
    socket.on("getUserStatus", async ({ userId }) => {
      try {
        // This handler used to answer for anybody, to anybody. Presence and
        // last-seen each have their own audience setting, and both were read by
        // nothing at all. A block overrides them.
        //
        // The answer to "you may not see this" is "offline, no last seen"
        // rather than an error, so it isn't an oracle either.
        const hidden = { userId, isOnline: false, lastSeen: null };

        if (await UserRelation.eitherBlocks(socket.userId, userId)) {
          socket.emit("userStatus", hidden);
          return;
        }

        const privacy = await privacyOf(userId);
        const [maySeeOnline, maySeeLastSeen] = await Promise.all([
          audienceAllows(socket.userId, userId, privacy.whoCanSeeOnlineStatus),
          audienceAllows(socket.userId, userId, privacy.whoCanSeeLastSeen),
        ]);

        if (!maySeeOnline && !maySeeLastSeen) {
          socket.emit("userStatus", hidden);
          return;
        }

        const online = userSockets.has(userId);
        let lastSeen = null;
        if (maySeeLastSeen) {
          if (online) lastSeen = new Date();
          else {
            const user = await User.findById(userId).select("lastActiveAt").lean();
            lastSeen = user?.lastActiveAt ?? null;
          }
        }
        socket.emit("userStatus", { userId, isOnline: maySeeOnline && online, lastSeen });
      } catch (error) {
        console.error("Error getting user status:", error);
      }
    });

    /**
     * Mark a conversation read.
     *
     * This used to load every unread message in the thread — no limit, no lean
     * — and fire two writes per message in parallel. Fifty thousand unread
     * meant fifty thousand hydrated documents and a hundred thousand concurrent
     * writes, on demand, from a handler with no rate limit. It's one upsert of
     * one timestamp now.
     *
     * Takes `conversation` directly; `senderId` is still accepted so an older
     * client keeps working.
     */
    socket.on("markConversationAsRead", async ({ senderId, conversation }) => {
      try {
        let key = typeof conversation === "string" ? conversation : null;
        if (!key && senderId) key = Message.dmConversationKey(senderId, socket.userId);
        if (!key) return;

        // Derived keys are self-scoping, but a client-supplied one is not.
        if (conversation && !(await canReadConversation(key, socket.userId))) return;

        const readAt = await markConversationRead(socket.userId, key);
        await notifyConversationRead({ io, userId: socket.userId, conversation: key, readAt });

        // Every tab this user has open, keyed the way the chat list is keyed —
        // making the client re-derive it would put that mapping in two places.
        io.to(socket.userId).emit("conversationReadSelf", {
          conversation: key,
          chatId: chatIdForConversation(key, socket.userId),
          readAt,
        });
      } catch (error) {
        console.error("Error marking conversation as read:", error);
      }
    });

    // Mark read up to one message. Same watermark; a message can't be read
    // without everything before it being read too.
    socket.on("markAsRead", async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return;
        if (!(await isMessageParticipant(message, socket.userId))) return;

        const readAt = await markConversationRead(
          socket.userId,
          message.conversation,
          message.createdAt
        );
        await notifyConversationRead({
          io,
          userId: socket.userId,
          conversation: message.conversation,
          readAt,
        });
      } catch (error) {
        console.error("Error marking message as read:", error);
      }
    });

    // Typing indicator
    socket.on("typing", async ({ receiverId, isTyping }) => {
      try {
        // privacy.typingIndicator, honoured for the first time. A block stops
        // it too — you shouldn't be able to watch someone compose a message
        // they can't send you.
        const [privacy, blocked] = await Promise.all([
          privacyOf(socket.userId),
          UserRelation.eitherBlocks(socket.userId, receiverId),
        ]);
        if (!privacy.typingIndicator || blocked) return;

        setTyping(`user:${receiverId}`, socket.userId, isTyping, (typing) =>
          io.to(receiverId.toString()).emit("userTyping", {
            userId: socket.userId,
            isTyping: typing,
          })
        );
      } catch (error) {
        console.error("Error handling typing:", error);
      }
    });

    /*
     * Group typing, which didn't exist at all — only DMs had it.
     *
     * Broadcast with `socket.to`, so the typist's own tabs don't render "you
     * are typing". The room is the group id, the same room messages use, so
     * membership is already established by joinUserGroups.
     */
    socket.on("typingInGroup", async ({ groupId, isTyping }) => {
      try {
        if (!mongoose.isValidObjectId(groupId)) return;
        const privacy = await privacyOf(socket.userId);
        if (!privacy.typingIndicator) return;
        if (!(await isGroupMember(groupId, socket.userId))) return;

        setTyping(`group:${groupId}`, socket.userId, isTyping, (typing) =>
          socket.to(groupId.toString()).emit("userTyping", {
            userId: socket.userId,
            groupId,
            isTyping: typing,
          })
        );
      } catch (error) {
        console.error("Error handling group typing:", error);
      }
    });

    // Add reaction — delegates to Message method which writes to MessageReaction
    socket.on("addReaction", async ({ messageId, emoji, skinTone = 1 }, ack) => {
      try {
        /*
         * Validated before anything is looked up, let alone written.
         *
         * `emoji` was taken verbatim here and stored, cached into the message's
         * reactionSummary, and then rebroadcast to the room on every subsequent
         * reaction to that message — so a single one-megabyte "emoji" bought
         * unbounded fan-out. See utils/reactions.js.
         */
        const reaction = parseReactionEmoji(emoji);
        if (!reaction) {
          fail(socket, "That isn't an emoji", { ack });
          return;
        }

        const message = await Message.findById(messageId);
        /*
         * Refused, out loud.
         *
         * Both of these used to be a bare `return`: the client had already drawn
         * the reaction optimistically, so a refusal left it on screen permanently
         * with nothing to correct it. 404-shaped wording either way, so this isn't
         * a message-existence oracle.
         */
        if (!message || !(await isMessageParticipant(message, socket.userId))) {
          fail(socket, "That message isn't available", { ack });
          return;
        }

        await message.addReaction(socket.userId, reaction, parseSkinTone(skinTone));

        // message.reactionSummary is refreshed inside addReaction()
        const room = conversationRoom(message);

        io.to(room).emit("messageReaction", {
          messageId,
          userId: socket.userId,
          emoji: reaction,
          skinTone: parseSkinTone(skinTone),
          reactionSummary: message.reactionSummary,
        });
        succeed(ack, { messageId, reactionSummary: message.reactionSummary });

      } catch (error) {
        console.error("Error adding reaction:", error);
        fail(socket, "Couldn't add that reaction", { ack });
      }
    });

    // Remove reaction
    socket.on("removeReaction", async ({ messageId }, ack) => {
      try {
        const message = await Message.findById(messageId);
        // addReaction checked participation and removeReaction didn't, which let
        // an unrelated account probe for message ids and force a full reaction
        // recount on a message they have no relationship with.
        if (!message || !(await isMessageParticipant(message, socket.userId))) {
          fail(socket, "That message isn't available", { ack });
          return;
        }

        await message.removeReaction(socket.userId);

        const room = conversationRoom(message);

        io.to(room).emit("messageReaction", {
          messageId,
          userId: socket.userId,
          emoji: null,
          reactionSummary: message.reactionSummary,
        });
        succeed(ack, { messageId, reactionSummary: message.reactionSummary });

      } catch (error) {
        console.error("Error removing reaction:", error);
        fail(socket, "Couldn't remove that reaction", { ack });
      }
    });

    /**
     * Edit message.
     *
     * The HTTP twin rejects empty content and anything older than fifteen
     * minutes; this checked ownership and nothing else, so it could blank a
     * message, rewrite one of any age, or overwrite an already-unsent
     * tombstone. It also broadcast the whole edit history — every earlier
     * revision — to the other party.
     */
    socket.on("editMessage", async ({ messageId, content }, ack) => {
      /*
       * The reason it refused, not a generic "failed to edit".
       *
       * Every branch here used to throw into one catch that emitted the same
       * string, so a user past the fifteen-minute window and a user editing
       * somebody else's message got identical feedback — and the client had
       * already left edit mode.
       */
      const refuse = (message) => {
        fail(socket, message, { ack });
      };
      try {
        const text = typeof content === "string" ? content.trim() : "";
        if (!text) return refuse("Content cannot be empty");
        if (text.length > MAX_CONTENT_LENGTH) return refuse("That message is too long");

        const message = await Message.findById(messageId);
        if (!message || message.sender.toString() !== socket.userId) {
          return refuse("Message not found or unauthorized");
        }
        if (message.isDeleted) return refuse("This message was deleted");
        // Same rule as the HTTP twin: `content` is a body or a caption, and
        // everything else either has no text or has text the server produced.
        if (!EDITABLE_MESSAGE_TYPES.has(message.messageType)) {
          return refuse("This kind of message can't be edited");
        }

        const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
        if (message.createdAt < fifteenMinutesAgo) {
          return refuse("Cannot edit messages older than 15 minutes");
        }

        await message.editContent(text);

        const room = conversationRoom(message);

        io.to(room).emit("messageEdited", {
          messageId,
          content: message.content,
          editedAt: message.editedAt,
        });
        succeed(ack, { messageId, content: message.content, editedAt: message.editedAt });

      } catch (error) {
        console.error("Error editing message:", error);
        refuse("Failed to edit message");
      }
    });

    // Delete message for everyone (soft delete)
    socket.on("deleteMessage", async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message || message.sender.toString() !== socket.userId) {
          throw new Error("Message not found or unauthorized");
        }
        if (message.isDeleted) return;

        // Same window the HTTP path enforces, so this isn't a way to unsend
        // something the other party acted on months ago.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (message.createdAt < oneHourAgo) {
          throw new Error("Cannot unsend messages older than 1 hour");
        }

        message.isDeleted = true;
        message.content = "This message was deleted";
        message.media = [];
        // Parity with the HTTP unsend — a tombstone must not keep carrying a
        // poll question, its tally, or a shared-post snapshot.
        message.poll = undefined;
        message.sharedContent = undefined;
        // Parity with the HTTP unsend: a tombstone keeps neither its reactions nor
        // its pin — a pinned tombstone occupies a slot nothing can free.
        message.isPinned = false;
        message.pinnedAt = null;
        message.pinnedBy = null;
        await message.clearReactions();
        await message.save();

        const room = conversationRoom(message);

        /*
         * `messageUnsent`, not `messageDeleted`.
         *
         * This handler is unsend-for-everyone and the HTTP path for the same
         * action emits `messageUnsent`. `messageDeleted` is the client's
         * delete-for-*me* event, whose reducer sets `deletedFor` and leaves the
         * body alone — so routing an unsend through it left the original text
         * on screen for everyone in the room. Delete-for-everyone deleted
         * nothing visually until a reload.
         */
        io.to(room).emit("messageUnsent", {
          messageId,
          reactionSummary: message.reactionSummary,
        });

      } catch (error) {
        console.error("Error deleting message:", error);
        socket.emit("error", { message: "Failed to delete message" });
      }
    });

    // Delete message for me only (adds userId to deletedFor plain ObjectId[])
    socket.on("deleteMessageForMe", async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return;
        // `deletedFor` is an uncapped array on a document the busiest query in
        // the app reads, so pushing into arbitrary messages is a way to inflate
        // the collection rather than a way to hide anything.
        if (!(await isMessageParticipant(message, socket.userId))) return;

        await message.softDeleteForUser(socket.userId);
        socket.emit("messageDeleted", { messageId });

      } catch (error) {
        console.error("Error deleting message for me:", error);
      }
    });

    // Voice/video call handlers
    socket.on("initiateCall", async ({ receiverId, callType, offer }) => {
      try {
        const [caller, receiver] = await Promise.all([
          User.findById(socket.userId).select("username name profilePic"),
          User.findById(receiverId).select("username name profilePic"),
        ]);

        if (!caller || !receiver) throw new Error("User not found");

        // Canonical id from the database, not the client's string — userSockets
        // and callByUser are both keyed that way, so a differently-cased id
        // would silently miss every lookup below.
        const receiverKey = receiver._id.toString();

        if (receiverKey === socket.userId) {
          return socket.emit("callError", { error: "You can't call yourself" });
        }
        if (callByUser.has(socket.userId)) {
          return socket.emit("callError", { error: "You're already in a call" });
        }
        // Only an *answered* call makes the callee unavailable. Reserving them
        // while their phone is merely ringing would let one caller hold someone
        // in a rolling 45-second lockout, and would break the ordinary case of
        // two people dialling each other at the same moment.
        const theirCall = activeCalls.get(callByUser.get(receiverKey));
        if (theirCall?.status === "active") {
          throw new Error("They're on another call");
        }

        // Block check
        const blocked = await UserRelation.eitherBlocks(socket.userId, receiverId);
        if (blocked) throw new Error("Cannot call a blocked user");

        // Call privacy check
        const receiverSettings = await UserSettings.findOne({ user: receiverId }).lean();
        const whoCanCall = receiverSettings?.privacy?.whoCanCall ?? "everyone";
        if (whoCanCall === "none") {
          throw new Error("User does not accept calls");
        } else if (whoCanCall === "followers") {
          const follows = await Follow.isFollowing(receiverId, socket.userId);
          if (!follows) throw new Error("User only accepts calls from people they follow");
        } else if (whoCanCall === "followers_following") {
          const [isFollowing, isFollower] = await Promise.all([
            Follow.isFollowing(socket.userId, receiverId),
            Follow.isFollowing(receiverId, socket.userId),
          ]);
          if (!isFollowing && !isFollower) throw new Error("User does not accept calls from you");
        }

        const callData = {
          callId: generateCallId(),
          caller: socket.userId,
          receiver: receiverKey,
          callType,
          offer,
          status: "ringing",
          participants: [socket.userId],
          createdAt: new Date()
        };

        activeCalls.set(callData.callId, callData);
        callByUser.set(callData.caller, callData.callId);

        // Both parties join now rather than on answer. Cancelling a ringing
        // call emits to the room, so a callee who isn't in it yet would keep
        // ringing after the caller hung up.
        joinUserToRoom(callData.caller, callData.callId);
        joinUserToRoom(callData.receiver, callData.callId);

        armCallTimer(callData.callId, RING_TIMEOUT_MS, "no_answer");

        const receiverSockets = userSockets.get(callData.receiver);
        if (receiverSockets) {
          receiverSockets.forEach(socketId => {
            io.to(socketId).emit("incomingCall", {
              ...callData,
              callerInfo: {
                username: caller.username,
                name: caller.name,
                profilePic: caller.profilePic
              }
            });
          });
        }

        socket.emit("callInitiated", callData);

      } catch (error) {
        console.error("Error initiating call:", error);
        socket.emit("callError", { error: "Failed to initiate call" });
      }
    });

    /**
     * The call handlers below take a callId and nothing else, so the id is the
     * only thing standing between a caller and the person who answers. They
     * used to check that the call existed and stop there, which meant anyone
     * holding an id could accept someone else's call — the caller would receive
     * the attacker's SDP and establish media with them — or reject and end
     * arbitrary calls. Each one now checks the authenticated identity against
     * the call's own two parties.
     */
    const callParty = (callId) => {
      if (typeof callId !== "string") return null;
      const callData = activeCalls.get(callId);
      if (!callData) return null;
      if (callData.caller !== socket.userId && callData.receiver !== socket.userId) {
        return null;
      }
      return callData;
    };

    socket.on("answerCall", ({ callId, answer }) => {
      const callData = activeCalls.get(callId);
      if (!callData) return;
      // Only the person being called, and only while it's still ringing.
      if (callData.receiver !== socket.userId) return;
      if (callData.status !== "ringing") return;

      callData.status = "active";
      callData.answer = answer;
      callData.answeredAt = new Date();
      if (!callData.participants.includes(socket.userId)) {
        callData.participants.push(socket.userId);
      }
      // Reserved only now that they've picked up.
      callByUser.set(callData.receiver, callId);
      // Swap the ring timeout for a long backstop. Without one, a party who
      // refreshes mid-call reconnects inside the 5s disconnect grace, so the
      // teardown never runs — and both users stay "already in a call" forever.
      armCallTimer(callId, MAX_CALL_MS, "timeout");

      // The caller's personal room holds every tab they have open, so this
      // reaches all of them rather than whichever socket happened to be first.
      io.to(callData.caller).emit("callAnswered", { callId, answer, answeredBy: socket.userId });
      joinUserToRoom(callData.caller, callId);
      joinUserToRoom(callData.receiver, callId);
    });

    socket.on("rejectCall", ({ callId }) => {
      const callData = activeCalls.get(callId);
      if (!callData) return;
      if (callData.receiver !== socket.userId) return;
      if (callData.status !== "ringing") return;

      callData.status = "rejected";
      callData.rejectedAt = new Date();

      io.to(callData.caller).emit("callRejected", { callId, rejectedBy: socket.userId });

      // Logged, like an answered call. saveCallLog has always had a "rejected"
      // branch and nothing ever reached it, so a declined call left no trace in
      // the thread at all.
      saveCallLog(callData);
      cleanupCall(callId);
    });

    socket.on("endCall", ({ callId }) => {
      const callData = callParty(callId);
      if (!callData) return;

      callData.status = "ended";
      callData.endedAt = new Date();
      callData.duration = (new Date() - callData.createdAt) / 1000;

      io.to(callId).emit("callEnded", {
        callId,
        endedBy: socket.userId,
        duration: callData.duration
      });

      saveCallLog(callData);
      cleanupCall(callId);
    });

    // WebRTC signaling.
    //
    // These relayed whatever arrived into whatever room the payload named, and
    // room names here are not secret — every user's personal room is their
    // public id and group rooms are the raw group id. So an attacker could
    // deliver a forged rtcOffer into any user's or any group's room, stamped
    // with a legitimate `from`. The relay now only works between the two
    // parties of a call that actually exists.
    socket.on("iceCandidate", ({ callId, candidate }) => {
      if (!callParty(callId)) return;
      socket.to(callId).emit("iceCandidate", { candidate, from: socket.userId });
    });

    socket.on("rtcOffer", ({ callId, offer }) => {
      if (!callParty(callId)) return;
      socket.to(callId).emit("rtcOffer", { offer, from: socket.userId });
    });

    socket.on("rtcAnswer", ({ callId, answer }) => {
      if (!callParty(callId)) return;
      socket.to(callId).emit("rtcAnswer", { answer, from: socket.userId });
    });

    /**
     * Create group — Group doc + GroupMember docs (no embedded members[]).
     *
     * Nothing was checked about the ids in `groupData.members`: not that the
     * accounts existed, not that they were active, not blocks, not
     * `whoCanMessage`. Blocking someone and then creating a group containing
     * them was a complete bypass of the DM privacy model, which is the exact
     * hole the share path documents and closes. Duplicate ids also violated the
     * (group, user) unique index, and the throw left the Group behind with no
     * members and no administrator.
     */
    socket.on("createGroup", async (groupData) => {
      try {
        const name = typeof groupData?.name === "string" ? groupData.name.trim() : "";
        if (!name) throw new Error("A group needs a name");

        const memberIds = cleanIds(groupData?.members, { exclude: socket.userId });
        if (!memberIds.length) throw new Error("Pick someone to add to the group");
        if (memberIds.length > MAX_RECIPIENTS) {
          throw new Error(`A group can start with up to ${MAX_RECIPIENTS} people`);
        }

        const objectIds = memberIds.map((id) => new mongoose.Types.ObjectId(id));
        const [existing, blocked, messageable] = await Promise.all([
          User.find({ _id: { $in: objectIds }, ...ACTIVE_ACCOUNT }).select("_id").lean(),
          blockedIdSet(socket.userId, objectIds),
          messageableIdSet(socket.userId, objectIds),
        ]);

        // A group must not become a way around whoCanMessage: someone who won't
        // accept your DM shouldn't be pulled into a thread with you either.
        const usable = existing.filter(
          (u) => !blocked.has(u._id.toString()) && messageable.has(u._id.toString())
        );
        if (!usable.length) throw new Error("Nobody you picked can be added");

        const group = new Group({
          name: name.slice(0, 100),
          description:
            typeof groupData?.description === "string"
              ? groupData.description.trim().slice(0, 500)
              : "",
          type: ["public", "private", "secret"].includes(groupData?.type)
            ? groupData.type
            : "private",
          // No client-supplied avatar: it's rendered by every member and there
          // is no upload path behind it. The schema default applies instead.
          createdBy: socket.userId,
        });
        await group.save();

        // Creator always gets super_admin role
        const memberDocs = [
          { group: group._id, user: socket.userId, role: "super_admin", addedBy: socket.userId },
          ...usable.map((u) => ({
            group: group._id,
            user: u._id,
            role: "member",
            addedBy: socket.userId,
          })),
        ];

        try {
          await GroupMember.insertMany(memberDocs);
          // Start everyone's read watermark here, or the group's history to
          // date would land in their unread badge.
          await seedConversationRead(
            memberDocs.map((doc) => doc.user),
            Message.groupConversationKey(group._id)
          );
        } catch (insertError) {
          // Otherwise the Group survives with nobody in it — invisible to
          // everyone and impossible to clean up from inside the app. insertMany
          // is ordered by default, so rows before the failure did commit and
          // have to go too, or those users hold membership of a group that no
          // longer exists and get joined to a dead room on every connect.
          await GroupMember.deleteMany({ group: group._id });
          await Group.deleteOne({ _id: group._id });
          throw insertError;
        }

        // Derived from the rows that committed, not from the array we asked for —
        // see utils/groupCounts.js.
        await recomputeGroupCounts(group._id);

        // Add all members to the socket room
        for (const doc of memberDocs) {
          joinUserToRoom(doc.user.toString(), group._id.toString());
        }

        const populatedGroup = await Group.findById(group._id)
          .populate("createdBy", "username name profilePic")
          .lean();

        socket.emit("groupCreated", populatedGroup);

        // Notify added members (not the creator)
        for (const u of usable) {
          io.to(u._id.toString()).emit("addedToGroup", {
            group: populatedGroup,
            addedBy: socket.userId,
          });
        }

      } catch (error) {
        console.error("Error creating group:", error);
        socket.emit("error", { message: error.message || "Failed to create group" });
      }
    });

    /**
     * Presence update — refreshes lastActiveAt, and re-announces the *derived*
     * state.
     *
     * The announced value used to come from the payload: `updatePresence({
     * isOnline: false })` told everyone this account was offline while its
     * socket stayed connected and kept receiving normally. Presence is a
     * property of the connection, so it is read from `userSockets` and the
     * client's claim is ignored. A user who wants to be invisible has
     * `privacy.whoCanSeeOnlineStatus`, which is honoured in one place for
     * everybody rather than being a flag any client can assert about itself.
     */
    socket.on("updatePresence", async () => {
      try {
        await User.findByIdAndUpdate(socket.userId, { lastActiveAt: new Date() });
        notifyContactsStatus(socket.userId, userSockets.has(socket.userId));
      } catch (error) {
        console.error("Error updating presence:", error);
      }
    });

    // Poll voting
    socket.on("voteInPoll", async ({ messageId, optionIds }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message || message.messageType !== "poll") {
          throw new Error("Invalid poll message");
        }
        // Every other message handler checks this; this one didn't, so anyone
        // holding a poll's id could vote in it and have the result broadcast to
        // the real conversation as though a member had voted.
        if (!(await isMessageParticipant(message, socket.userId))) {
          throw new Error("Invalid poll message");
        }
        if (message.poll?.expiresAt && message.poll.expiresAt <= new Date()) {
          throw new Error("This poll has closed");
        }

        await message.voteInPoll(socket.userId, optionIds);

        const room = conversationRoom(message);
        const plain = message.toObject().poll;

        /*
         * A poll can't be broadcast as one payload at all.
         *
         * `pollFor` resolves two things per reader: whether they may see the
         * voter list (anonymous polls), and `votedByMe`. Both are properties of
         * the *viewer*, so a single room emit computed for the voter told
         * everyone else that they had voted for whatever the voter picked —
         * their bubble rendered someone else's selection as their own, and
         * clicking then sent a set built from that false state.
         *
         * The room therefore gets the anonymised, viewer-less form — correct
         * counts, no identities, `votedByMe: false` — and every voter in the
         * room gets their own view addressed to their personal room, which
         * covers all of their open tabs rather than just the one that voted.
         */
        io.to(room).emit("pollUpdated", { messageId, poll: pollFor(plain, null) });

        const voterIds = [
          ...new Set(
            (plain.options ?? [])
              .flatMap((o) => o.votes ?? [])
              .map((v) => v.userId?.toString())
              .filter(Boolean)
          ),
        ];
        for (const voterId of voterIds) {
          io.to(voterId).emit("pollUpdated", {
            messageId,
            poll: pollFor(plain, voterId),
          });
        }

      } catch (error) {
        console.error("Error voting in poll:", error);
        socket.emit("error", { message: "Failed to vote in poll" });
      }
    });

    // Handle disconnect
    socket.on("disconnect", async (reason) => {
      console.log(`User disconnected: ${socket.userId}, reason: ${reason}`);

      const userSocketSet = userSockets.get(socket.userId);
      if (userSocketSet) {
        userSocketSet.delete(socket.id);
        if (userSocketSet.size === 0) {
          userSockets.delete(socket.userId);
          // Note: rateBuckets is deliberately *not* cleared here. Dropping a
          // user's counters on disconnect would make the whole limit resettable
          // by reconnecting, which costs one handshake and buys a fresh 60
          // sends. The buckets expire on their own; sweepRateBuckets keeps the
          // map from growing.

          // Delay status update to handle quick reconnects
          setTimeout(async () => {
            const stillConnected = userSockets.has(socket.userId);
            if (!stillConnected) {
              // Record last seen
              await updateUserStatus(socket.userId);
              await notifyContactsStatus(socket.userId, false);

              // End any active call.
              const callId = callByUser.get(socket.userId);
              if (callId) {
                if (activeCalls.has(callId)) {
                  io.to(callId).emit("callEnded", {
                    callId,
                    endedBy: socket.userId,
                    reason: "user_disconnected"
                  });
                  cleanupCall(callId);
                } else {
                  callByUser.delete(socket.userId);
                }
              }

              /*
               * And any call still ringing *at* this user.
               *
               * `callByUser` deliberately doesn't reserve the callee until they
               * answer — reserving them while merely ringing would let one caller
               * hold someone in a rolling 45-second lockout. The cost was that a
               * callee who closed the tab mid-ring was invisible to this teardown,
               * so the caller kept ringing until the 45-second timeout instead of
               * finding out immediately that nobody was there.
               *
               * Scanned rather than tracked in a third map: `activeCalls` holds only
               * calls in flight right now, and a second index of the same facts is
               * one more thing to keep in sync.
               */
              for (const [ringingId, callData] of activeCalls) {
                if (callData.status !== "ringing") continue;
                if (callData.receiver !== socket.userId) continue;
                io.to(ringingId).emit("callEnded", {
                  callId: ringingId,
                  endedBy: socket.userId,
                  reason: "callee_unavailable",
                });
                // A call the callee was never present for is a missed call, and it
                // belongs in the thread like any other.
                callData.status = "missed";
                callData.endedAt = new Date();
                saveCallLog(callData);
                cleanupCall(ringingId);
              }
            }
          }, 5000);
        }
      }

      /*
       * Clear typing indicators — and say so, but only once this user is really
       * gone.
       *
       * Two bugs, one line. It used to delete the entries and emit nothing, so
       * closing a tab mid-sentence left "X is typing…" on the other person's
       * screen until they reloaded — the map it was tidying had no readers.
       *
       * And it ran per *socket*, so closing one tab cleared the typing state the
       * same user had going in another: typing in the desktop app and closing a
       * phone tab made the indicator vanish while they were still typing (CF33).
       * Typing state is per user, like presence, so it is torn down when the last
       * connection goes — which is what the presence teardown above already does.
       */
      if (!userSockets.has(socket.userId)) {
        clearAllTyping(socket.userId, io);
      }
    });

    // Error handling
    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  });

  return io;
};

// ── Helper functions ──────────────────────────────────────────────────────────

/**
 * Update lastActiveAt in User doc.
 * Online/offline presence lives only in the userSockets in-memory map.
 */
async function updateUserStatus(userId) {
  try {
    await User.findByIdAndUpdate(userId, { lastActiveAt: new Date() });
  } catch (error) {
    console.error("Error updating user status:", error);
  }
}

/*
 * The last state each user was announced as.
 *
 * `notifyContactsStatus` is reachable on demand through `updatePresence`, and
 * every call was a fresh Follow scan, a block lookup and an emit to every
 * contact — so a client could spend its 20/min budget making the server fan out
 * twenty times over, all of it saying exactly the same thing. Announcing only
 * transitions makes the repeat calls free, which is what the handler is for:
 * refreshing `lastActiveAt`.
 *
 * Keyed by user rather than by socket, because presence is per account: opening
 * a second tab is not a transition.
 */
const announcedPresence = new Map(); // userId -> boolean

/**
 * Broadcast online/offline status to all accepted followers and following.
 * Queries the Follow collection instead of User.followers[]/following[].
 */
async function notifyContactsStatus(userId, isOnline) {
  try {
    const key = userId.toString();
    if (announcedPresence.get(key) === isOnline) return;
    // Absence means offline, so the map only ever holds the users currently
    // announced as online rather than growing by one per account that has ever
    // connected.
    if (isOnline) announcedPresence.set(key, true);
    else announcedPresence.delete(key);

    // whoCanSeeOnlineStatus, honoured here too. "everyone" and "followers" both
    // include every contact this fan-out reaches, so the audience only has to
    // be resolved per contact when it's narrower than that.
    const privacy = await privacyOf(userId);
    if (privacy.whoCanSeeOnlineStatus === "none") return;

    /*
     * Bounded.
     *
     * An account with a hundred thousand followers produced a hundred thousand
     * emits per transition, and there is no upper limit on a follower count.
     * Presence is best-effort — `getUserStatus` answers for one person on
     * demand and is what every profile and chat header actually calls — so the
     * broadcast is a convenience for the most recent contacts rather than a
     * guarantee for all of them. The rest see the dot update the moment they
     * ask.
     */
    const edges = await Follow.find({
      $or: [{ follower: userId }, { following: userId }],
      status: "accepted",
    })
      .sort({ createdAt: -1 })
      .limit(MAX_PRESENCE_FANOUT)
      .select("follower following").lean();

    const contactIds = new Set();
    for (const e of edges) {
      const other = e.follower.toString() === userId.toString()
        ? e.following.toString()
        : e.follower.toString();
      contactIds.add(other);
    }

    if (privacy.whoCanSeeOnlineStatus === "followers") {
      // Only people who follow *this* user, not people they follow back.
      const followers = new Set(
        edges
          .filter((e) => e.following.toString() === userId.toString())
          .map((e) => e.follower.toString())
      );
      for (const id of contactIds) if (!followers.has(id)) contactIds.delete(id);
    }

    // Blocks override the audience, same as getUserStatus. One query for the
    // whole fan-out rather than one per contact.
    const blocked = await blockedIdSet(userId, [...contactIds]);
    for (const id of blocked) contactIds.delete(id);

    // whoCanSeeLastSeen is a separate setting from online status, so a
    // broadcast that carried a live timestamp regardless was leaking the
    // narrower one through the wider one.
    const shareLastSeen = privacy.whoCanSeeLastSeen !== "none";

    contactIds.forEach(contactId => {
      const contactSockets = userSockets.get(contactId);
      if (contactSockets) {
        contactSockets.forEach(socketId => {
          io.to(socketId).emit("userStatus", {
            userId,
            isOnline,
            lastSeen: shareLastSeen ? new Date() : null
          });
        });
      }
    });
  } catch (error) {
    console.error("Error notifying contacts:", error);
  }
}

/**
 * Join socket to all group rooms the user is an active member of.
 *
 * Filtered on the group being alive, not just on the membership row: a deleted
 * group left every former member sitting in a room for it on every connect.
 */
async function joinUserGroups(userId, socket) {
  // Deliberately not caught here: the caller needs to know, because a socket
  // that has been told "joined" while outside every group room misses messages
  // silently and forever. Swallowing it made the await pointless.
  const memberships = await GroupMember.find({ user: userId, isBanned: { $ne: true } })
    .select("group")
    .lean();
  if (!memberships.length) return;

  const liveGroups = await Group.find({
    _id: { $in: memberships.map((m) => m.group) },
    isActive: { $ne: false },
    isDeleted: { $ne: true },
  })
    .select("_id")
    .lean();

  liveGroups.forEach((g) => socket.join(g._id.toString()));
}

/**
 * Who this socket may be told is online, right now.
 *
 * NOT `[...userSockets.keys()]`. That was every connected account on the
 * platform, handed to anyone who opened a tab — an enumeration of who is on
 * the site, and a bypass of the three gates `getUserStatus` applies one id at
 * a time: `whoCanSeeOnlineStatus`, and blocks in either direction. Someone who
 * had set their status to nobody and blocked you still showed up green.
 *
 * Scoped to the people whose presence you'd see anyway — the peers in your
 * chat list — and each one filtered through the same `audienceAllows` check.
 */
async function sendPresenceSnapshot(socket) {
  const me = socket.userId;

  const conversations = await Message.find({
    $or: [{ sender: me }, { receiver: me }],
    isGroupMessage: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .select("sender receiver")
    .lean();

  const peers = [
    ...new Set(
      conversations
        .flatMap((m) => [m.sender?.toString(), m.receiver?.toString()])
        .filter((id) => id && id !== me)
    ),
  ].filter((id) => userSockets.has(id));

  if (!peers.length) {
    socket.emit("presenceSnapshot", { online: [] });
    return;
  }

  const visible = [];
  await Promise.all(
    peers.map(async (id) => {
      if (await UserRelation.eitherBlocks(me, id)) return;
      const privacy = await privacyOf(id);
      if (await audienceAllows(me, id, privacy.whoCanSeeOnlineStatus)) {
        visible.push(id);
      }
    })
  );

  socket.emit("presenceSnapshot", { online: visible });
}

/*
 * Typing state, and the thing that was missing: telling anyone it stopped.
 *
 * The old code mutated `typingUsers` in three places — on start, on the 3s
 * auto-clear, and on disconnect — and emitted only on the first of them. So
 * "X is typing…" appeared and then stayed forever: the timeout removed the
 * entry from a map nothing read, and closing the tab or dropping the network
 * left the indicator up on the other side until that person reloaded.
 *
 * The timer is stored so a keystroke can reset it rather than stacking a new
 * timeout per event, which is what made the 3s window meaningless under
 * continuous typing.
 */
const typingTimers = new Map(); // `${key}|${userId}` -> Timeout
const TYPING_TIMEOUT_MS = 4000;

const clearTypingTimer = (key, userId) => {
  const id = `${key}|${userId}`;
  const timer = typingTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    typingTimers.delete(id);
  }
};

/**
 * @param emit  Called with the new state whenever it actually changes, so a
 *   burst of keystrokes emits once rather than once per character.
 */
function setTyping(key, userId, isTyping, emit) {
  const current = typingUsers.get(key) ?? new Set();
  const wasTyping = current.has(userId);

  clearTypingTimer(key, userId);

  if (isTyping) {
    current.add(userId);
    typingUsers.set(key, current);
    if (!wasTyping) emit(true);

    typingTimers.set(
      `${key}|${userId}`,
      setTimeout(() => setTyping(key, userId, false, emit), TYPING_TIMEOUT_MS)
    );
    return;
  }

  current.delete(userId);
  if (current.size === 0) typingUsers.delete(key);
  else typingUsers.set(key, current);
  if (wasTyping) emit(false);
}

/** Everything this user was typing into, cleared and announced. Disconnect. */
function clearAllTyping(userId, io) {
  for (const [key, users] of typingUsers.entries()) {
    if (!users.has(userId)) continue;
    const isGroup = key.startsWith("group:");
    const target = key.slice(key.indexOf(":") + 1);
    setTyping(key, userId, false, () =>
      io.to(target).emit("userTyping", {
        userId,
        ...(isGroup ? { groupId: target } : {}),
        isTyping: false,
      })
    );
  }
}

/**
 * Take every socket a user has open out of a room.
 *
 * `socket.leave` appeared nowhere in the repo, which made removal and banning
 * advisory: the row said they were gone, and their open tab kept receiving
 * every message in the group until it happened to disconnect. With
 * `pingTimeout` at 60s and no idle disconnect, that could be indefinite.
 */
export const removeUserFromRoom = (userId, room) => {
  const key = userId?.toString();
  if (!io || !key || !room) return;
  const sockets = userSockets.get(key);
  if (!sockets) return;
  sockets.forEach((socketId) =>
    io.sockets.sockets.get(socketId)?.leave(room.toString())
  );
};

/** The inverse — used when someone is added to a group while already online. */
export const addUserToRoom = (userId, room) => {
  if (!io || !userId || !room) return;
  joinUserToRoom(userId.toString(), room.toString());
};

/**
 * Call ids are bearer tokens: holding one is what lets a socket answer, end or
 * signal into a call. `Math.random` with a known timestamp prefix and six
 * base-36 characters is guessable, so this uses the CSPRNG.
 */
function generateCallId() {
  return `call_${crypto.randomUUID()}`;
}

/** Pull every socket a user has open into a room (a call, or a group). */
function joinUserToRoom(userId, room) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  sockets.forEach((socketId) => io.sockets.sockets.get(socketId)?.join(room));
}

function clearCallTimer(callId) {
  const timer = callTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    callTimers.delete(callId);
  }
}

/**
 * Every call carries exactly one timer: a short one while it rings, a long
 * backstop once it's answered. Held outside the call object because that object
 * is emitted to both clients and a Timeout handle is not serialisable.
 */
function armCallTimer(callId, ms, reason) {
  clearCallTimer(callId);
  callTimers.set(
    callId,
    setTimeout(() => {
      const callData = activeCalls.get(callId);
      if (!callData) return;
      io.to(callId).emit("callEnded", { callId, reason });
      // A call that rang out is a missed call, and it belongs in the thread.
      // saveCallLog's "missed" branch was unreachable before this.
      if (callData.status === "ringing") {
        callData.status = "missed";
        callData.endedAt = new Date();
        saveCallLog(callData);
      }
      cleanupCall(callId);
    }, ms).unref()
  );
}

function cleanupCall(callId) {
  const callData = activeCalls.get(callId);
  if (!callData) return;

  clearCallTimer(callId);
  activeCalls.delete(callId);
  // Only clear a user's pointer if it still points at *this* call, or ending an
  // old call would detach them from a newer one.
  if (callByUser.get(callData.caller) === callId) callByUser.delete(callData.caller);
  if (callByUser.get(callData.receiver) === callId) callByUser.delete(callData.receiver);

  io.in(callId).socketsLeave(callId);
}

/**
 * Persist a call log as a Message document.
 * Includes the conversation key required by the new schema.
 */
async function saveCallLog(callData) {
  try {
    const message = new Message({
      sender: callData.caller,
      receiver: callData.receiver,
      conversation: Message.dmConversationKey(callData.caller, callData.receiver),
      messageType: "call",
      status: "sent",
      call: {
        type: callData.callType,
        duration: callData.duration,
        status: callData.status === "ended" ? "answered"
               : callData.status === "rejected" ? "rejected"
               : "missed",
        participants: callData.participants,
        startedAt: callData.createdAt,
        endedAt: callData.endedAt,
      },
    });

    await message.save();
  } catch (error) {
    console.error("Error saving call log:", error);
  }
}

/**
 * Notify the members of a group who aren't currently connected.
 *
 * The group send path never notified anyone at all — `mutedChats` was checked
 * on the DM path only, so muting a group did nothing because nothing was being
 * suppressed in the first place. Membership is read fresh rather than from the
 * socket room, since the room only contains people who are online and these are
 * precisely the people who are not.
 *
 * Every exit logs, for the reason the DM path's two skip branches do: "no notification and
 * nothing in the log" is indistinguishable from a broken FCM setup, and that is how it
 * gets misdiagnosed — the whole of CF30's debugging was spent on four layers that each
 * report success while delivering nothing.
 *
 * One aggregate line per send rather than one per member, which is the difference from the
 * DM path: this fans out to up to MAX_GROUP_MEMBERS recipients, and a per-member log would
 * put 512 lines in stdout for one message. The counts have to add up — `members` is
 * `connected + muted + targeted` — so a member disappearing between the two is visible
 * rather than absorbed.
 *
 * Ids and counts only, never the notification body: it carries the message text, and
 * stdout on a hosted platform is a persistent searchable copy outside the database.
 */
async function notifyGroupMembers(groupId, senderId, notification) {
  const groupKey = groupId.toString();
  try {
    const members = await GroupMember.find({
      group: groupId,
      user: { $ne: senderId },
      isBanned: { $ne: true },
    })
      .select("user")
      .lean();

    const recipients = members.map((m) => m.user.toString());
    if (!recipients.length) {
      // A group the sender is alone in. Distinguished from "everyone is online" below
      // because they look identical from the outside and mean very different things.
      console.log("Push: group fan-out skipped, no other members", { group: groupKey });
      return;
    }

    const offline = recipients.filter((id) => !userSockets.has(id));
    if (!offline.length) {
      // The case people forget: a background tab still holds a socket, so closing the tab
      // is not the same as closing the window.
      console.log("Push: group fan-out skipped, every member is connected", {
        group: groupKey,
        members: recipients.length,
      });
      return;
    }

    const conversation = Message.groupConversationKey(groupId);
    const muted = await Promise.all(
      offline.map((id) => isConversationMuted(id, `group_${groupId}`))
    );

    const targets = offline.filter((_, i) => !muted[i]);
    const mutedCount = offline.length - targets.length;
    if (!targets.length) {
      console.log("Push: group fan-out skipped, every offline member has it muted", {
        group: groupKey,
        members: recipients.length,
        muted: mutedCount,
      });
      return;
    }

    const results = await Promise.all(
      targets.map((id) =>
        sendPushNotification(id, {
          ...notification,
          data: { ...notification.data, conversation },
        })
      )
    );

    /*
     * "Accepted", not "sent", and the same caveat the per-recipient log carries:
     * `successCount` means FCM took the message, not that any browser drew a banner. A
     * line reading "sent" invites the reader to rule out the server and go looking at the
     * client, when this layer cannot know.
     *
     * `accepted` counts devices, not people — one member with a phone and two browsers
     * contributes three — so it is expected to exceed `targeted`. A zero here with a
     * non-zero `targeted` is the signal worth chasing: it means nobody had a registered
     * device, or credentials are missing, and the per-recipient lines say which.
     */
    const accepted = results.reduce((sum, result) => sum + (result?.sent ?? 0), 0);
    console.log("Push: group fan-out (accepted by FCM, not proof of delivery)", {
      group: groupKey,
      members: recipients.length,
      connected: recipients.length - offline.length,
      muted: mutedCount,
      targeted: targets.length,
      accepted,
    });
  } catch (error) {
    /*
     * Anything thrown above suppresses the whole fan-out — `isConversationMuted` is the
     * one call here that can, and one member's failed lookup takes the notification away
     * from all of them. Left as it is rather than made to fail open, because failing open
     * means notifying people who muted the group; but it is logged with the group so the
     * silence is attributable.
     */
    console.error("Push: group fan-out failed", { group: groupKey, error: error.message });
  }
}

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

export const getUserSocket = (userId) => userSockets.get(userId);

export const isUserOnline = (userId) => userSockets.has(userId);

/**
 * Drop every live socket a user has open.
 *
 * The handshake refuses a non-active account, and the comment there says why:
 * otherwise "a suspended account keeps messaging in real time after being cut
 * off everywhere else." But it only ran once, at connect. `pingTimeout` is 60s
 * and an idle socket lives indefinitely, so suspending someone revoked their
 * sessions and left their open tab sending messages. Every path that changes
 * what an account is allowed to do has to reach this layer too.
 *
 * Returns the number of sockets dropped, for the audit log.
 */
export const disconnectUserSockets = (userId) => {
  const key = userId?.toString();
  if (!io || !key) return 0;
  try {
    const count = userSockets.get(key)?.size ?? 0;
    io.in(key).disconnectSockets(true);
    return count;
  } catch (error) {
    console.error("Error disconnecting user sockets:", error);
    return 0;
  }
};
