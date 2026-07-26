import { Schema, model } from "mongoose";

/**
 * One row per person per poll.
 *
 * Kept out of the Post document for the same reason Like and Repost were: an
 * embedded voter array grows without bound on anything popular, ships every
 * voter's id to every reader, and eventually hits Mongo's 16MB ceiling. The
 * post keeps only the counts.
 *
 * The unique index on (targetType, target, user) is what actually enforces
 * one-vote-per-person — not an application-level check, which two concurrent
 * requests would both pass.
 */
const pollVoteSchema = new Schema(
  {
    targetType: { type: String, enum: ["Post", "Comment"], required: true },
    target:     { type: Schema.Types.ObjectId, required: true, refPath: "targetType" },
    user:       { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Matches poll.options[].id — a stable string, not an array index.
    optionId:   { type: String, required: true },
  },
  { timestamps: true }
);

// The one-vote rule. A duplicate insert throws E11000, which the controller
// turns into "you've already voted".
pollVoteSchema.index({ targetType: 1, target: 1, user: 1 }, { unique: true });

// "What did I vote for?" across a feed page, in one query.
pollVoteSchema.index({ user: 1, target: 1 });

export default model("PollVote", pollVoteSchema);
