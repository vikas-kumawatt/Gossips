import BotMemory, { SUMMARY_MAX_LENGTH } from "../models/BotMemory.js";

/**
 * What a bot remembers, and how it stops growing.
 *
 * ── Summaries, not transcripts ──────────────────────────────────────────────
 *
 * A transcript grows without bound and would be re-sent on every cycle, so the cost of a
 * conversation would rise linearly with its length until it stopped fitting at all. A summary
 * is fixed-size, lossy and rewritable: the model folds what happened into the existing
 * summary and the old one is replaced.
 *
 * That is also a privacy property, not only an efficiency one. The bot's lasting record of a
 * person is a paragraph about them, not a copy of everything they said.
 *
 * ── The compaction problem ──────────────────────────────────────────────────
 *
 * The model is asked for a summary "under 1000 characters" and will sometimes return 1400.
 * Storing that means the cap is a suggestion, and a suggestion compounds: each cycle's summary
 * is the input to the next, so a summariser that drifts 20% long grows unboundedly across a
 * few hundred cycles. `compactSummary` below is the deterministic backstop — it always
 * returns something within the cap, whatever it was handed.
 */

/** The characters a compacted summary is guaranteed to fit within. */
export const MEMORY_CAP = SUMMARY_MAX_LENGTH;

/**
 * Force a summary within the cap, preserving whole sentences where possible.
 *
 * Pure and deterministic, so it is testable and so the same input always yields the same
 * stored text — which matters because this output becomes the next cycle's input.
 *
 * Sentence-aware rather than a hard slice: cutting mid-sentence leaves a fragment that reads
 * as a complete thought and can invert its meaning. "She said she would never" is a different
 * claim from "She said she would never mind if I replied later".
 */
export const compactSummary = (text, cap = MEMORY_CAP) => {
  if (typeof text !== "string") return "";
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= cap) return trimmed;

  /*
   * Keep whole sentences from the start until the next one wouldn't fit.
   *
   * From the start, not the end: a summary's opening states who this is and what the
   * relationship is, and the tail is the most recent detail. Losing recent detail degrades
   * gracefully; losing the subject's identity does not.
   */
  const sentences = trimmed.match(/[^.!?]+[.!?]*/g) ?? [];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).length > cap) break;
    out += sentence;
  }
  out = out.trim();

  /*
   * A single sentence longer than the whole cap — one run-on with no punctuation — leaves the
   * loop above with nothing. Fall back to a hard clip so the function's guarantee holds
   * regardless of input.
   */
  if (!out) return `${trimmed.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
  return out;
};

/**
 * Load a bot's memories for a set of subjects, plus its memory of itself.
 *
 * One query, not one per subject. A cycle typically wants the self-memory and a handful of
 * per-person ones, and issuing them separately would be a query per conversation on every
 * cycle for every bot.
 *
 * @returns `{ self: string, bySubject: Map<string, string> }`
 */
export const loadMemories = async (botId, subjectIds = []) => {
  const ids = [...new Set(subjectIds.map(String).filter(Boolean))];

  const rows = await BotMemory.find({
    bot: botId,
    // `null` is the self-memory; the rest are per-person. Both in one round trip.
    $or: [{ subject: null }, { subject: { $in: ids } }],
  })
    .select("subject summary")
    .lean();

  let self = "";
  const bySubject = new Map();

  for (const row of rows) {
    if (!row.subject) self = row.summary || "";
    else bySubject.set(String(row.subject), row.summary || "");
  }

  return { self, bySubject };
};

/**
 * Write a memory, compacted, bumping its revision.
 *
 * An upsert rather than a read-modify-write: two cycles for one bot should not be able to
 * interleave and have one clobber the other's summary with a stale base. `$inc` on `revisions`
 * is atomic for the same reason, and a memory being rewritten every single cycle is the signal
 * that a summarisation prompt is restating rather than accumulating.
 *
 * `subject: null` writes the bot's memory of itself.
 */
export const rememberAbout = async (botId, subjectId, summary) => {
  const compacted = compactSummary(summary);
  if (!compacted) return null;

  return BotMemory.findOneAndUpdate(
    { bot: botId, subject: subjectId ?? null },
    {
      $set: { summary: compacted },
      $inc: { revisions: 1 },
      $setOnInsert: { bot: botId, subject: subjectId ?? null },
    },
    { new: true, upsert: true }
  ).lean();
};

/**
 * Forget everything a bot knows about one person.
 *
 * Exists because someone who blocks a bot has withdrawn consent to be remembered by it, and
 * because an owner may reasonably want to reset a relationship that has gone wrong. Called
 * with the subject alone, so it cannot accidentally clear the self-memory.
 */
export const forgetAbout = async (botId, subjectId) => {
  if (!subjectId) return { deletedCount: 0 };
  return BotMemory.deleteOne({ bot: botId, subject: subjectId });
};
