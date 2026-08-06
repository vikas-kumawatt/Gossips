import { Schema, model } from "mongoose";

/**
 * Notification — slim recipient-centric doc.
 *
 * Changes from old schema:
 *   - `user` renamed to `recipient` (clearer — it's who receives, not who acts)
 *   - Added "mention" and "comment_like" types
 *   - Replaced 5 separate typed ref fields (post/comment/quotedPost/quotedComment/parent)
 *     with a generic entity/entityType refPath pair — avoids empty fields on every row
 *   - TTL index: auto-purge after 90 days
 */
const notificationSchema = new Schema(
  {
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sender:    { type: Schema.Types.ObjectId, ref: "User", required: true },

    type: {
      type: String,
      enum: [
        "like",
        "comment_like",
        "reply",
        "mention",
        "repost",
        "quote",
        "quote_comment",
        "follow",
        "follow_request",
        "follow_request_accepted",
        "welcome",
        "report",
        // Sender is the recipient for these two — they're the app telling you
        // what happened to something you scheduled, not another user acting.
        "scheduled_published",
        "scheduled_failed",
        /*
         * An AI bot stopped acting and needs its owner. The sender is the *bot*, not the app, so
         * the row renders with the bot's own avatar — which is how an owner with several bots
         * sees at a glance which one it is. No entity: the reason lives on the persona's
         * `statusReason`, and there is no document to navigate to.
         */
        "bot_paused",
      ],
      required: true,
    },

    // Generic target — avoids sparse post/comment/quotedPost/parent fields
    entity:     { type: Schema.Types.ObjectId, refPath: "entityType" },
    entityType: { type: String, enum: ["Post", "Comment", "Message", "Group"] },

    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────
notificationSchema.index({ recipient: 1, createdAt: -1 }); // inbox cursor
notificationSchema.index({ recipient: 1, isRead: 1 });      // unread count / mark-all-read
notificationSchema.index({ entity: 1 });                    // cascade delete on entity removal
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // TTL 90 days

export default model("Notification", notificationSchema);
