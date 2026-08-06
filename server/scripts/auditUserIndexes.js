/**
 * Find indexes on `users` that no longer earn their keep, and optionally drop them.
 *
 *   node scripts/auditUserIndexes.js            # dry run — reports, changes nothing
 *   node scripts/auditUserIndexes.js --apply    # drops the ones classified `drop`
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `users` is the most-read collection in the app and every index on it is also a write
 * cost: an insert writes all of them, and an update writes each one whose key it touches.
 * Schema evolution leaves indexes behind — Mongoose creates what the schema declares and
 * never removes what it doesn't — so a collection accumulates indexes on fields that no
 * longer exist. Those can never serve a query. They are pure overhead.
 *
 * ── The rules, and what this deliberately won't decide ──────────────────────
 *
 * Dropping an index on a live collection is not reversible in the sense that matters: the
 * rebuild is expensive and, if the index was enforcing a constraint, the window without it
 * can admit data that then prevents the rebuild. So this script only drops what it can
 * *prove* is redundant, and reports everything else for a person to decide.
 *
 *   drop   — the indexed field is not in the schema at all, so no query can use it.
 *   drop   — a single-field index duplicated at the opposite direction, where the schema
 *            declares the other one. Mongo traverses a single-key index in both
 *            directions, so `{createdAt: 1}` and `{createdAt: -1}` are interchangeable and
 *            keeping both is keeping one twice.
 *   drop   — a compound index whose leading field is *itself* a unique index. A unique
 *            index on the prefix already resolves to at most one document, so the extra
 *            keys can never narrow the search further.
 *   keep   — declared by the current schema.
 *   review — everything else. Not declared, but the fields exist: it may be serving a
 *            query written before the schema declared its indexes, and only someone who
 *            knows the query patterns can say.
 *
 * `_id_` is never a candidate; MongoDB will not drop it.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import User from "../models/User.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");

/** `{ a: 1, b: -1 }` → `"a_1_b_-1"`, which is how Mongo names an index by default. */
export const indexSignature = (spec) =>
  Object.entries(spec)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");

/** The same, ignoring direction, so opposite-direction twins compare equal. */
const directionlessSignature = (spec) => Object.keys(spec).join("|");

/**
 * Decide what to do with each live index.
 *
 * Pure, and exported, so the classification can be tested against a real index list without
 * a database — which is the only way to be confident before running it against one.
 *
 * @param live      `[{ name, key, unique }]` as returned by `collection.indexes()`
 * @param declared  `[[spec, options]]` as returned by `schema.indexes()`
 * @param schemaPaths a Set of every path the schema declares
 */
export const classifyIndexes = (live, declared, schemaPaths) => {
  const declaredSignatures = new Set(declared.map(([spec]) => indexSignature(spec)));
  const declaredDirectionless = new Set(declared.map(([spec]) => directionlessSignature(spec)));

  /*
   * Text indexes are named for their fields but keyed as `_fts`/`_ftsx`, so they never match
   * a declared signature by name. Detected structurally instead.
   */
  const isTextIndex = (key) => Object.values(key).includes("text") || "_fts" in key;

  const uniqueSingleFields = new Set(
    live
      .filter((index) => index.unique && Object.keys(index.key).length === 1)
      .map((index) => Object.keys(index.key)[0])
  );

  const results = [];

  for (const index of live) {
    if (index.name === "_id_") {
      results.push({ ...index, verdict: "keep", reason: "the primary key" });
      continue;
    }

    const fields = Object.keys(index.key);
    const signature = indexSignature(index.key);

    if (isTextIndex(index.key)) {
      results.push({ ...index, verdict: "keep", reason: "text index, declared by the schema" });
      continue;
    }

    if (declaredSignatures.has(signature)) {
      results.push({ ...index, verdict: "keep", reason: "declared by the schema" });
      continue;
    }

    /*
     * A field the schema has never heard of. Checked with `startsWith` for dotted paths so a
     * subdocument index like `usernameHistory.username` is recognised via its parent — the
     * schema registers the array path, not always the leaf.
     */
    const orphaned = fields.filter(
      (field) =>
        !schemaPaths.has(field) &&
        ![...schemaPaths].some((path) => field.startsWith(`${path}.`) || path.startsWith(`${field}.`))
    );
    if (orphaned.length) {
      results.push({
        ...index,
        verdict: "drop",
        reason: `no such field in the schema: ${orphaned.join(", ")}`,
      });
      continue;
    }

    // Same single key, opposite direction, where the schema declares the other one.
    if (fields.length === 1 && declaredDirectionless.has(directionlessSignature(index.key))) {
      results.push({
        ...index,
        verdict: index.unique ? "review" : "drop",
        reason: index.unique
          ? "duplicates a declared index at the opposite direction, but is unique — dropping it would remove a constraint"
          : "duplicates a declared index at the opposite direction; a single-key index is traversable both ways",
      });
      continue;
    }

    // A compound index led by a field that is uniquely indexed on its own.
    if (fields.length > 1 && uniqueSingleFields.has(fields[0])) {
      results.push({
        ...index,
        verdict: "drop",
        reason: `led by "${fields[0]}", which is uniquely indexed alone — the extra keys can never narrow a match past one document`,
      });
      continue;
    }

    results.push({
      ...index,
      verdict: "review",
      reason: "not declared by the schema, but its fields exist — may serve a query this script can't see",
    });
  }

  return results;
};

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set — nothing to connect to.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const collection = User.collection;
  const live = await collection.indexes();
  const results = classifyIndexes(
    live,
    User.schema.indexes(),
    new Set(Object.keys(User.schema.paths))
  );

  /*
   * Index sizes, so the payoff is a number rather than an assertion. Best effort: `$collStats`
   * needs privileges a restricted user may not have, and the audit is still useful without it.
   */
  let sizes = {};
  try {
    const [stats] = await collection
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray();
    sizes = stats?.storageStats?.indexSizes || {};
  } catch {
    console.log("(index sizes unavailable — the database user lacks $collStats)\n");
  }

  const bytes = (n) => (n ? `${(n / 1024).toFixed(0)} KB` : "");

  for (const verdict of ["keep", "review", "drop"]) {
    const group = results.filter((r) => r.verdict === verdict);
    if (!group.length) continue;
    console.log(`${verdict.toUpperCase()} (${group.length})`);
    for (const index of group) {
      const flags = [index.unique && "unique", index.partialFilterExpression && "partial"]
        .filter(Boolean)
        .join(" ");
      console.log(
        `  ${index.name.padEnd(36)} ${bytes(sizes[index.name]).padStart(8)}  ${flags}`
      );
      if (verdict !== "keep") console.log(`      ${index.reason}`);
    }
    console.log("");
  }

  const droppable = results.filter((r) => r.verdict === "drop");
  const reclaimed = droppable.reduce((sum, index) => sum + (sizes[index.name] || 0), 0);

  if (!droppable.length) {
    console.log("Nothing to drop.");
    await mongoose.disconnect();
    return;
  }

  console.log(
    `${droppable.length} index(es) can be dropped${reclaimed ? `, reclaiming ~${bytes(reclaimed)}` : ""}.`
  );
  console.log("Every write to `users` currently maintains all of them.\n");

  if (!APPLY) {
    console.log("Dry run — nothing was changed. Re-run with --apply to drop them.");
    console.log("Anything listed under REVIEW is left alone either way.");
    await mongoose.disconnect();
    return;
  }

  for (const index of droppable) {
    try {
      await collection.dropIndex(index.name);
      console.log(`Dropped ${index.name}`);
    } catch (error) {
      /*
       * Logged and continued rather than thrown. A concurrent drop, or an index that has just
       * been rebuilt under a different name, should not abandon the remaining work — and every
       * drop here is independent of the others.
       */
      console.error(`Could not drop ${index.name}: ${error.message}`);
    }
  }

  const after = await collection.indexes();
  console.log(`\nIndexes now (${after.length}): ${after.map((i) => i.name).join(", ")}`);

  await mongoose.disconnect();
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(async (error) => {
    console.error("Audit failed:", error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
