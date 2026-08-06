import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * What a bot remembers, as prose it wrote about itself.
 *
 * **Summaries, never transcripts.** A transcript grows without bound, and the whole
 * history would be re-sent on every cycle — so the cost of a conversation would rise
 * linearly with its length until it stopped fitting in the context window at all. A
 * summary is a fixed-size, lossy, and rewritable substitute: the model is asked to fold
 * what happened into the existing summary, and the old one is replaced.
 *
 * This is also a privacy property, not only an efficiency one. The bot's persistent record
 * of a person is a paragraph about them, not a copy of everything they said.
 */

/*
 * The ceiling a summary is compacted back down to.
 *
 * ~1000 characters is roughly 250 tokens, which is affordable to send on every cycle for
 * every person the bot is talking to. When a rewrite comes back longer than this the
 * summary is compacted again rather than stored — see the memory service.
 */
export const SUMMARY_MAX_LENGTH = 1000;

const botMemorySchema = new Schema(
  {
    /*
     * No field-level index: the two partial indexes below both start with `bot`, and
     * Mongoose rejects `{bot:1}` declared twice — which is what a field-level `index: true`
     * plus the partial unique `{bot:1}` amounts to.
     */
    bot: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /*
     * Who or what this memory is about.
     *
     * `null` is the bot's memory of itself and of the platform generally — what it has
     * been posting about, what it seems to care about, the through-line that makes an
     * account feel like one continuous person rather than a fresh mind every cycle.
     * A user id is what it remembers about that person.
     */
    subject: { type: Schema.Types.ObjectId, ref: "User", default: null },

    summary: { type: String, required: true, maxlength: SUMMARY_MAX_LENGTH * 2 },

    /*
     * How many times this has been rewritten, and when it last was.
     *
     * Useful for spotting a memory that is churning — being rewritten every cycle usually
     * means the summarisation prompt is restating rather than accumulating, which reads to
     * a user as a bot with no continuity.
     */
    revisions: { type: Number, default: 1 },
  },
  { timestamps: true }
);

/*
 * One memory per (bot, subject).
 *
 * **Partial, not sparse**, for the reason `Message.js` documents: `subject: null` is the
 * bot's memory of itself, and a sparse unique index would index those nulls and collide
 * across every bot. The filter admits only rows where `subject` is an ObjectId, and the
 * self-memory is kept unique by the second index below.
 */
botMemorySchema.index(
  { bot: 1, subject: 1 },
  { unique: true, partialFilterExpression: { subject: { $type: "objectId" } } }
);

/** One self-memory per bot — the row the index above deliberately excludes. */
botMemorySchema.index(
  { bot: 1 },
  { unique: true, partialFilterExpression: { subject: null } }
);

export default model("BotMemory", botMemorySchema);
