import { Schema, model } from "mongoose";
import { MAX_EMOJI_LENGTH } from "../utils/reactions.js";

/**
 * MessageReaction — one row per (message, user).
 * Replaces Message.reactions Map.
 * The cached Message.reactionSummary holds top-3 for fast list rendering.
 */
const messageReactionSchema = new Schema(
  {
    message:  { type: Schema.Types.ObjectId, ref: "Message", required: true },
    user:     { type: Schema.Types.ObjectId, ref: "User",    required: true },
    /*
     * `maxlength` as a floor under the real check.
     *
     * The value that belongs here is one emoji grapheme, which
     * utils/reactions.js enforces on the way in. The schema cap exists so that a
     * write reaching this collection by some route that skipped that parser
     * still can't store a megabyte — this string is copied into the message's
     * cached reactionSummary and rebroadcast to the whole room.
     */
    emoji:    { type: String, required: true, maxlength: MAX_EMOJI_LENGTH },
    skinTone: { type: Number, default: 1, min: 1, max: 6 },
  },
  { timestamps: true }
);

// One reaction per (message, user) — to "change" a reaction, replace it
messageReactionSchema.index({ message: 1, user: 1 }, { unique: true });

/*
 * {message, emoji} is gone — the comment claimed "users who reacted with X" and
 * no such query exists. _refreshReactionSummary reads every reaction for a
 * message, which the unique compound above already serves as a prefix.
 */

export default model("MessageReaction", messageReactionSchema);
