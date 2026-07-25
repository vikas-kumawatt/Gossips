import { Server } from "socket.io";
import Message from "../models/Message.js";
import User from "../models/User.js";
import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import UserSettings from "../models/UserSettings.js";
import jwt from "jsonwebtoken";
import { getSettings } from "../utils/settings.js";

let io;
const userSockets = new Map(); // userId -> Set<socketId>
const typingUsers = new Map(); // conversationId -> Set of userIds
const callRooms = new Map(); // roomId -> call data
const activeCalls = new Map(); // userId -> call data

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:5173",
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8, // 100MB for large files
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token ||
                   socket.handshake.headers.authorization?.split(" ")[1];

      if (!token) {
        return next(new Error("Authentication error"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

    // Store socket connection
    if (!userSockets.has(socket.userId)) {
      userSockets.set(socket.userId, new Set());
    }
    userSockets.get(socket.userId).add(socket.id);

    // Update lastActiveAt (presence/online state lives in userSockets map only)
    updateUserStatus(socket.userId);

    // Join user's personal room
    socket.join(socket.userId);

    // Join group rooms user is member of
    joinUserGroups(socket.userId, socket);

    // Send success confirmation
    socket.emit("joined", {
      success: true,
      userId: socket.userId,
      timestamp: new Date()
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
    socket.on("sendMessage", async (data) => {
      try {
        const {
          senderId,
          receiverId,
          content,
          media,
          replyTo,
          messageType = "text",
          tempId,
          isEphemeral = false,
          selfDestructTimer,
          mentions = []
        } = data;

        // Validate sender
        if (senderId !== socket.userId) {
          socket.emit("error", { message: "Unauthorized", tempId });
          return;
        }

        // Messages are created here rather than over HTTP, so the admin flags
        // and maintenance mode have to be applied at this point too — the
        // Express middleware never sees this path. Staff bypass, as elsewhere.
        const isStaffSocket = ["admin", "super_admin"].includes(socket.userRole);
        if (!isStaffSocket) {
          const settings = await getSettings();
          if (settings.maintenanceMode) {
            socket.emit("error", { message: settings.maintenanceMessage, tempId });
            return;
          }
          if (!settings.directMessagesEnabled) {
            socket.emit("error", {
              message: "Direct messages are temporarily disabled.",
              tempId,
            });
            return;
          }
        }

        if (!senderId || !receiverId) {
          throw new Error("Invalid senderId or receiverId");
        }

        // Fetch sender and receiver (minimal fields for notification/broadcast)
        const [sender, receiver] = await Promise.all([
          User.findById(senderId).select("username name profilePic isVerified").lean(),
          User.findById(receiverId).select("username name profilePic isVerified").lean(),
        ]);

        if (!sender || !receiver) {
          socket.emit("error", { message: "User not found", tempId });
          return;
        }

        // Block check via UserRelation
        const blocked = await UserRelation.eitherBlocks(senderId, receiverId);
        if (blocked) {
          socket.emit("error", { message: "Cannot send message to blocked user", tempId });
          return;
        }

        // Receiver's message privacy via UserSettings
        const receiverSettings = await UserSettings.findOne({ user: receiverId }).lean();
        const whoCanMessage = receiverSettings?.privacy?.whoCanMessage ?? "everyone";
        if (whoCanMessage === "none") {
          socket.emit("error", { message: "User does not accept messages", tempId });
          return;
        } else if (whoCanMessage === "followers") {
          const follows = await Follow.isFollowing(receiverId, senderId);
          if (!follows) {
            socket.emit("error", { message: "User only accepts messages from people they follow", tempId });
            return;
          }
        } else if (whoCanMessage === "followers_following") {
          const [isFollowing, isFollower] = await Promise.all([
            Follow.isFollowing(senderId, receiverId),
            Follow.isFollowing(receiverId, senderId),
          ]);
          if (!isFollowing && !isFollower) {
            socket.emit("error", { message: "User does not accept messages from you", tempId });
            return;
          }
        }

        // Build message doc using new schema
        const messageData = {
          sender: senderId,
          receiver: receiverId,
          conversation: Message.dmConversationKey(senderId, receiverId),
          content: content?.trim() || "",
          media: media || [],
          replyTo: replyTo || null,
          messageType,
          mentions,
          isEphemeral,
          selfDestructSeconds: selfDestructTimer || null,
          status: "sent",
        };

        if (isEphemeral && selfDestructTimer) {
          messageData.expiresAt = new Date(Date.now() + selfDestructTimer * 1000);
        }

        const message = new Message(messageData);
        await message.save();

        await message.populate([
          { path: "sender",   select: "username name profilePic isVerified" },
          { path: "receiver", select: "username name profilePic isVerified" },
        ]);

        const messageObject = message.toObject();

        // Emit to receiver if online
        const receiverSockets = userSockets.get(receiverId);
        if (receiverSockets && receiverSockets.size > 0) {
          receiverSockets.forEach(socketId => {
            io.to(socketId).emit("receiveMessage", { ...messageObject, tempId, isOwn: false });
          });

          // Record delivery receipt
          await message.markAsDelivered(receiverId);
        }

        // Emit confirmation back to sender
        socket.emit("receiveMessage", { ...messageObject, tempId, isOwn: true });

        // Push notification when receiver is offline
        if (!receiverSockets || receiverSockets.size === 0) {
          await sendPushNotification(receiver, {
            title: sender.name || sender.username,
            body: content || (media?.length ? "Sent a media" : "Sent a message"),
            data: { messageId: message._id, senderId }
          });
        }

        // Chat list update for both users
        const chatUpdateForReceiver = {
          user: sender,
          latestMessage: messageObject,
          unreadCount: 1
        };
        const chatUpdateForSender = {
          user: receiver,
          latestMessage: messageObject,
          unreadCount: 0
        };

        socket.emit("chatUpdated", chatUpdateForSender);
        if (receiverSockets) {
          receiverSockets.forEach(socketId => {
            io.to(socketId).emit("chatUpdated", chatUpdateForReceiver);
          });
        }

        console.log(`Message sent from ${senderId} to ${receiverId}`);

      } catch (error) {
        console.error("Error sending message:", error);
        socket.emit("error", { message: "Failed to send message", tempId: data?.tempId });
      }
    });

    // Send group message
    socket.on("sendGroupMessage", async (data) => {
      try {
        const {
          groupId,
          content,
          media,
          replyTo,
          messageType = "text",
          tempId
        } = data;

        // Membership check via GroupMember collection
        const member = await GroupMember.findOne({
          group: groupId,
          user: socket.userId,
          isBanned: false,
        });

        if (!member) {
          throw new Error("Not a member of this group");
        }

        const perms = member.getPermissions();
        if (!perms.sendMessages) {
          throw new Error("No permission to send messages in this group");
        }

        const group = await Group.findById(groupId).select("name isActive isDeleted").lean();
        if (!group || !group.isActive || group.isDeleted) {
          throw new Error("Group not found");
        }

        const message = new Message({
          sender: socket.userId,
          group: groupId,
          isGroupMessage: true,
          conversation: Message.groupConversationKey(groupId),
          content: content?.trim() || "",
          media: media || [],
          replyTo: replyTo || null,
          messageType,
          status: "sent",
        });

        await message.save();
        await message.populate("sender", "username name profilePic isVerified");

        const messageObject = message.toObject();

        // Broadcast to group room; socket.to() excludes the sender
        socket.to(groupId).emit("receiveGroupMessage", { ...messageObject, tempId, isOwn: false });
        // Confirmation to sender
        socket.emit("receiveGroupMessage", { ...messageObject, tempId, isOwn: true });

        // Increment cached message count on Group
        await Group.updateOne({ _id: groupId }, { $inc: { "counts.messagesTotal": 1 } });

      } catch (error) {
        console.error("Error sending group message:", error);
        socket.emit("error", { message: "Failed to send group message", tempId: data?.tempId });
      }
    });

    // Get user online status (presence from socket map; lastActiveAt from DB)
    socket.on("getUserStatus", async ({ userId }) => {
      try {
        const isOnline = userSockets.has(userId);
        let lastSeen = isOnline ? new Date() : null;
        if (!isOnline) {
          const user = await User.findById(userId).select("lastActiveAt").lean();
          lastSeen = user?.lastActiveAt ?? null;
        }
        socket.emit("userStatus", { userId, isOnline, lastSeen });
      } catch (error) {
        console.error("Error getting user status:", error);
      }
    });

    // Mark all messages in a DM conversation as read
    socket.on("markConversationAsRead", async ({ senderId }) => {
      try {
        const conversation = Message.dmConversationKey(senderId, socket.userId);
        const messages = await Message.find({
          conversation,
          sender: senderId,
          status: { $in: ["sent", "delivered"] },
        });

        await Promise.all(messages.map(msg => msg.markAsRead(socket.userId)));

        // Notify sender
        const senderSockets = userSockets.get(senderId);
        if (senderSockets) {
          senderSockets.forEach(socketId => {
            io.to(socketId).emit("conversationRead", {
              readBy: socket.userId,
              count: messages.length
            });
          });
        }
      } catch (error) {
        console.error("Error marking conversation as read:", error);
      }
    });

    // Mark single message as read
    socket.on("markAsRead", async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return;

        // Verify participant
        const isParticipant =
          message.sender.toString() === socket.userId ||
          message.receiver?.toString() === socket.userId ||
          (message.isGroupMessage && await isGroupMember(message.group, socket.userId));

        if (!isParticipant) return;

        await message.markAsRead(socket.userId);

        // Notify sender for DMs
        if (!message.isGroupMessage && message.sender.toString() !== socket.userId) {
          const senderSockets = userSockets.get(message.sender.toString());
          if (senderSockets) {
            senderSockets.forEach(socketId => {
              io.to(socketId).emit("messageRead", {
                messageId,
                readBy: socket.userId,
                readAt: new Date()
              });
            });
          }
        }

      } catch (error) {
        console.error("Error marking message as read:", error);
      }
    });

    // Typing indicator
    socket.on("typing", async ({ receiverId, isTyping }) => {
      try {
        const typingKey = `user:${receiverId}`;

        if (isTyping) {
          if (!typingUsers.has(typingKey)) {
            typingUsers.set(typingKey, new Set());
          }
          typingUsers.get(typingKey).add(socket.userId);

          // Auto-clear after 3 seconds
          setTimeout(() => {
            if (typingUsers.has(typingKey)) {
              typingUsers.get(typingKey).delete(socket.userId);
              if (typingUsers.get(typingKey).size === 0) {
                typingUsers.delete(typingKey);
              }
            }
          }, 3000);
        } else {
          if (typingUsers.has(typingKey)) {
            typingUsers.get(typingKey).delete(socket.userId);
            if (typingUsers.get(typingKey).size === 0) {
              typingUsers.delete(typingKey);
            }
          }
        }

        // Notify receiver
        const receiverSockets = userSockets.get(receiverId);
        if (receiverSockets) {
          receiverSockets.forEach(socketId => {
            io.to(socketId).emit("userTyping", { userId: socket.userId, isTyping });
          });
        }

      } catch (error) {
        console.error("Error handling typing:", error);
      }
    });

    // Add reaction — delegates to Message method which writes to MessageReaction
    socket.on("addReaction", async ({ messageId, emoji, skinTone = 1 }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return;

        const isParticipant =
          message.sender.toString() === socket.userId ||
          message.receiver?.toString() === socket.userId ||
          (message.isGroupMessage && await isGroupMember(message.group, socket.userId));

        if (!isParticipant) return;

        await message.addReaction(socket.userId, emoji, skinTone);

        // message.reactionSummary is refreshed inside addReaction()
        const room = message.isGroupMessage
          ? message.group.toString()
          : [message.sender.toString(), message.receiver.toString()];

        io.to(room).emit("messageReaction", {
          messageId,
          userId: socket.userId,
          emoji,
          skinTone,
          reactionSummary: message.reactionSummary,
        });

      } catch (error) {
        console.error("Error adding reaction:", error);
      }
    });

    // Remove reaction
    socket.on("removeReaction", async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return;

        await message.removeReaction(socket.userId);

        const room = message.isGroupMessage
          ? message.group.toString()
          : [message.sender.toString(), message.receiver.toString()];

        io.to(room).emit("messageReaction", {
          messageId,
          userId: socket.userId,
          emoji: null,
          reactionSummary: message.reactionSummary,
        });

      } catch (error) {
        console.error("Error removing reaction:", error);
      }
    });

    // Edit message
    socket.on("editMessage", async ({ messageId, content }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message || message.sender.toString() !== socket.userId) {
          throw new Error("Message not found or unauthorized");
        }

        await message.editContent(content);

        const room = message.isGroupMessage
          ? message.group.toString()
          : [message.sender.toString(), message.receiver.toString()];

        io.to(room).emit("messageEdited", {
          messageId,
          content: message.content,
          editedAt: message.editedAt,
          editHistory: message.editHistory,
        });

      } catch (error) {
        console.error("Error editing message:", error);
        socket.emit("error", { message: "Failed to edit message" });
      }
    });

    // Delete message for everyone (soft delete)
    socket.on("deleteMessage", async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message || message.sender.toString() !== socket.userId) {
          throw new Error("Message not found or unauthorized");
        }

        message.isDeleted = true;
        message.content = "This message was deleted";
        message.media = [];
        await message.save();

        const room = message.isGroupMessage
          ? message.group.toString()
          : [message.sender.toString(), message.receiver.toString()];

        io.to(room).emit("messageDeleted", { messageId });

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
          receiver: receiverId,
          callType,
          offer,
          status: "ringing",
          participants: [socket.userId],
          createdAt: new Date()
        };

        activeCalls.set(callData.callId, callData);
        activeCalls.set(socket.userId, callData);

        const receiverSockets = userSockets.get(receiverId);
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

    socket.on("answerCall", ({ callId, answer }) => {
      const callData = activeCalls.get(callId);
      if (!callData) return;

      callData.status = "active";
      callData.answer = answer;
      callData.answeredAt = new Date();
      callData.participants.push(socket.userId);

      const callerSockets = userSockets.get(callData.caller);
      if (callerSockets) {
        callerSockets.forEach(socketId => {
          io.to(socketId).emit("callAnswered", { callId, answer, answeredBy: socket.userId });
        });
      }

      socket.join(callId);
      const callerSocket = Array.from(userSockets.get(callData.caller) || [])[0];
      if (callerSocket) {
        io.sockets.sockets.get(callerSocket)?.join(callId);
      }

      activeCalls.set(socket.userId, callData);
    });

    socket.on("rejectCall", ({ callId }) => {
      const callData = activeCalls.get(callId);
      if (!callData) return;

      callData.status = "rejected";
      callData.rejectedAt = new Date();

      const callerSockets = userSockets.get(callData.caller);
      if (callerSockets) {
        callerSockets.forEach(socketId => {
          io.to(socketId).emit("callRejected", { callId, rejectedBy: socket.userId });
        });
      }

      cleanupCall(callId);
    });

    socket.on("endCall", ({ callId }) => {
      const callData = activeCalls.get(callId);
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

    // WebRTC signaling
    socket.on("iceCandidate", ({ callId, candidate }) => {
      socket.to(callId).emit("iceCandidate", { candidate, from: socket.userId });
    });

    socket.on("rtcOffer", ({ callId, offer }) => {
      socket.to(callId).emit("rtcOffer", { offer, from: socket.userId });
    });

    socket.on("rtcAnswer", ({ callId, answer }) => {
      socket.to(callId).emit("rtcAnswer", { answer, from: socket.userId });
    });

    // Create group — Group doc + GroupMember docs (no embedded members[])
    socket.on("createGroup", async (groupData) => {
      try {
        const group = new Group({
          name: groupData.name,
          description: groupData.description || "",
          type: groupData.type || "private",
          avatar: groupData.avatar,
          createdBy: socket.userId,
        });
        await group.save();

        // Creator always gets super_admin role
        const memberDocs = [
          { group: group._id, user: socket.userId, role: "super_admin", addedBy: socket.userId }
        ];
        if (Array.isArray(groupData.members)) {
          for (const memberId of groupData.members) {
            if (memberId.toString() !== socket.userId) {
              memberDocs.push({ group: group._id, user: memberId, role: "member", addedBy: socket.userId });
            }
          }
        }
        await GroupMember.insertMany(memberDocs);
        await Group.updateOne({ _id: group._id }, { $set: { "counts.members": memberDocs.length } });

        // Add all members to the socket room
        for (const doc of memberDocs) {
          const memberSocketSet = userSockets.get(doc.user.toString());
          if (memberSocketSet) {
            memberSocketSet.forEach(socketId => {
              io.sockets.sockets.get(socketId)?.join(group._id.toString());
            });
          }
        }

        const populatedGroup = await Group.findById(group._id)
          .populate("createdBy", "username name profilePic")
          .lean();

        socket.emit("groupCreated", populatedGroup);

        // Notify added members (not the creator)
        for (const doc of memberDocs) {
          if (doc.user.toString() !== socket.userId) {
            const memberSocketSet = userSockets.get(doc.user.toString());
            if (memberSocketSet) {
              memberSocketSet.forEach(socketId => {
                io.to(socketId).emit("addedToGroup", { group: populatedGroup, addedBy: socket.userId });
              });
            }
          }
        }

      } catch (error) {
        console.error("Error creating group:", error);
        socket.emit("error", { message: "Failed to create group" });
      }
    });

    // Presence update — only refreshes lastActiveAt in DB
    socket.on("updatePresence", async (status) => {
      try {
        await User.findByIdAndUpdate(socket.userId, { lastActiveAt: new Date() });
        notifyContactsStatus(socket.userId, status.isOnline !== false);
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

        await message.voteInPoll(socket.userId, optionIds);

        const room = message.isGroupMessage
          ? message.group.toString()
          : [message.sender.toString(), message.receiver.toString()];

        io.to(room).emit("pollUpdated", { messageId, poll: message.poll });

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

          // Delay status update to handle quick reconnects
          setTimeout(async () => {
            const stillConnected = userSockets.has(socket.userId);
            if (!stillConnected) {
              // Record last seen
              await updateUserStatus(socket.userId);
              await notifyContactsStatus(socket.userId, false);

              // End any active call
              const userCall = activeCalls.get(socket.userId);
              if (userCall) {
                io.to(userCall.callId).emit("callEnded", {
                  callId: userCall.callId,
                  endedBy: socket.userId,
                  reason: "user_disconnected"
                });
                cleanupCall(userCall.callId);
              }
            }
          }, 5000);
        }
      }

      // Clear typing indicators
      for (const [key, users] of typingUsers.entries()) {
        if (users.has(socket.userId)) {
          users.delete(socket.userId);
          if (users.size === 0) typingUsers.delete(key);
        }
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

/**
 * Broadcast online/offline status to all accepted followers and following.
 * Queries the Follow collection instead of User.followers[]/following[].
 */
async function notifyContactsStatus(userId, isOnline) {
  try {
    const edges = await Follow.find({
      $or: [{ follower: userId }, { following: userId }],
      status: "accepted",
    }).select("follower following").lean();

    const contactIds = new Set();
    for (const e of edges) {
      const other = e.follower.toString() === userId.toString()
        ? e.following.toString()
        : e.follower.toString();
      contactIds.add(other);
    }

    contactIds.forEach(contactId => {
      const contactSockets = userSockets.get(contactId);
      if (contactSockets) {
        contactSockets.forEach(socketId => {
          io.to(socketId).emit("userStatus", {
            userId,
            isOnline,
            lastSeen: new Date()
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
 * Uses GroupMember collection (not Group.members[]).
 */
async function joinUserGroups(userId, socket) {
  try {
    const memberships = await GroupMember.find({ user: userId, isBanned: false })
      .select("group")
      .lean();
    memberships.forEach(m => socket.join(m.group.toString()));
  } catch (error) {
    console.error("Error joining user groups:", error);
  }
}

/**
 * Check if userId is a non-banned member of groupId.
 * Uses GroupMember collection (not Group.members[]).
 */
async function isGroupMember(groupId, userId) {
  try {
    const member = await GroupMember.findOne({
      group: groupId,
      user: userId,
      isBanned: false,
    }).lean();
    return !!member;
  } catch (error) {
    console.error("Error checking group membership:", error);
    return false;
  }
}

function generateCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function cleanupCall(callId) {
  const callData = activeCalls.get(callId);
  if (callData) {
    activeCalls.delete(callId);
    activeCalls.delete(callData.caller);
    activeCalls.delete(callData.receiver);
  }
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

async function sendPushNotification(user, notification) {
  // Integrate with FCM / APNS push service here
  console.log("Sending push notification to:", user._id, notification);
}

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

export const getUserSocket = (userId) => userSockets.get(userId);

export const isUserOnline = (userId) => userSockets.has(userId);
