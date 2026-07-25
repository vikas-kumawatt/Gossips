import Notification from "../models/Notification.js";
import { getIO, getUserSocket } from "../config/socket.js";

/**
 * Create, save, and socket-emit a notification.
 *
 * @param {string|ObjectId} recipientId  - user who receives the notification
 * @param {string|ObjectId} senderId     - user who triggered it
 * @param {string}          type         - notification type (follow, like, reply, quote, …)
 * @param {object}          extra        - additional Notification fields (entity, entityType, …)
 */
export async function sendNotification(recipientId, senderId, type, extra = {}) {
  const notification = new Notification({
    recipient: recipientId,
    sender: senderId,
    type,
    isRead: false,
    createdAt: new Date(),
    ...extra,
  });
  await notification.save();

  const io = getIO();
  const socketIds = getUserSocket(recipientId.toString());
  if (socketIds && socketIds.size > 0) {
    const populated = await Notification.findById(notification._id)
      .populate("sender", "username profilePic")
      .populate("entity");
    socketIds.forEach((id) => io.to(id).emit("newNotification", populated));
  }

  return notification;
}
