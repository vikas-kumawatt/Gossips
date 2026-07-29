import { Schema, model } from "mongoose";

/**
 * SearchHistory — one row per thing a viewer searched for.
 *
 * Server-side rather than localStorage so the list follows the account across
 * devices, and so signing out doesn't leave one person's search history
 * readable by the next person to use the browser.
 *
 * Two kinds of entry, matching what the search UI can replay:
 *   "query" → a text search, replayed by re-running it
 *   "user"  → a profile that was opened from results, replayed by navigating
 *
 * `key` exists so both kinds dedupe through one unique index: repeating a
 * search must bump the existing row rather than add a second one. It's derived
 * (see `historyKey`) and never accepted from a client.
 */
const searchHistorySchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    kind: { type: String, enum: ["query", "user"], required: true },

    // The text as it was typed — what gets shown and re-run. Empty for "user".
    query: { type: String, default: "", maxlength: 100, trim: true },

    targetUser: { type: Schema.Types.ObjectId, ref: "User", default: null },

    // Dedupe identity: "q:<lowercased query>" or "u:<user id>".
    key: { type: String, required: true },

    // Recency of the *last* use, not of creation — repeating an old search
    // moves it back to the top.
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One row per (viewer, thing searched). The upsert in the controller relies on
// this to turn a repeat search into a bump.
searchHistorySchema.index({ user: 1, key: 1 }, { unique: true });

// The listing: this viewer's entries, most recent first.
searchHistorySchema.index({ user: 1, lastUsedAt: -1 });

/**
 * How many entries a viewer keeps. Older ones are pruned on write, so the
 * collection can't grow without bound per account and the list stays scannable.
 */
export const MAX_SEARCH_HISTORY = 20;

export const historyKey = ({ kind, query, targetUser }) =>
  kind === "user" ? `u:${targetUser}` : `q:${query.toLowerCase()}`;

export default model("SearchHistory", searchHistorySchema);
