import { Schema, model } from "mongoose";

/**
 * MessageReceipt — one row per (message, user, kind).
 * Replaces Message.deliveryReceipts[] and Message.readReceipts[].
 */
const messageReceiptSchema = new Schema(
  {
    message:      { type: Schema.Types.ObjectId, ref: "Message", required: true, index: true },
    conversation: { type: String, required: true, index: true }, // copied from Message
    user:         { type: Schema.Types.ObjectId, ref: "User",    required: true, index: true },
    kind:         { type: String, enum: ["delivered", "read"],   required: true },
    at:           { type: Date, default: Date.now },
    device:       { type: String },
  },
  { timestamps: false }
);

// Idempotent
messageReceiptSchema.index({ message: 1, user: 1, kind: 1 }, { unique: true });

// "Mark everything in this conversation as read for me up to T"
messageReceiptSchema.index({ conversation: 1, user: 1, kind: 1 });

export default model("MessageReceipt", messageReceiptSchema);
