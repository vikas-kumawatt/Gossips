import { Schema, model } from "mongoose";

/**
 * MessageReaction — one row per (message, user).
 * Replaces Message.reactions Map.
 * The cached Message.reactionSummary holds top-3 for fast list rendering.
 */
const messageReactionSchema = new Schema(
  {
    message:  { type: Schema.Types.ObjectId, ref: "Message", required: true, index: true },
    user:     { type: Schema.Types.ObjectId, ref: "User",    required: true, index: true },
    emoji:    { type: String, required: true },
    skinTone: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// One reaction per (message, user) — to "change" a reaction, replace it
messageReactionSchema.index({ message: 1, user: 1 }, { unique: true });

// "All reactions for this message" / "users who reacted with X"
messageReactionSchema.index({ message: 1, emoji: 1 });

export default model("MessageReaction", messageReactionSchema);
