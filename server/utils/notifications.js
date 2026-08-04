import Notification from "../models/Notification.js";
import { getIO, isUserOnline } from "../config/socket.js";

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
  /*
   * The recipient's room, not this process's socket list.
   *
   * `getUserSocket` only knew about sockets attached to the instance handling the
   * request, so with more than one a notification reached the user only when they
   * happened to be on the same node. The `isUserOnline` check is kept purely to avoid the
   * populate below when nobody is listening — the emit itself is safe either way.
   */
  if (await isUserOnline(recipientId)) {
    const populated = await Notification.findById(notification._id)
      .populate("sender", "username profilePic")
      .populate("entity");
    io.to(recipientId.toString()).emit("newNotification", populated);
  }

  return notification;
}
