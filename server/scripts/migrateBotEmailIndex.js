/**
 * Make `users.email` unique among humans only, so a bot can share its owner's address.
 *
 *   node scripts/migrateBotEmailIndex.js            # dry run — reports, changes nothing
 *   node scripts/migrateBotEmailIndex.js --apply    # does it
 *
 * **Run this before creating any bot.** Until it has, the old global unique index is still
 * in place and the second account on an address — which is what a bot is — fails with
 * E11000.
 *
 * ── What it does, and why in this order ─────────────────────────────────────
 *
 *   1. Backfill `isBot: false` onto every account that predates the field.
 *   2. Create the new partial unique index on `{ email: 1 }`, filtered to `isBot: false`.
 *   3. Drop the old global `email_1`.
 *
 * The backfill is first because the new index depends on it. `partialFilterExpression`
 * accepts equality but not `$ne`, so the filter has to be `{ isBot: false }` — and an
 * account with no `isBot` field at all falls outside it. Skipping the backfill would leave
 * every pre-existing user unindexed and therefore *not* subject to email uniqueness, which
 * is an account-takeover vector rather than a cosmetic gap.
 *
 * The drop is last because of what an interruption leaves behind. Stopping after step 2
 * leaves both indexes present — stricter than intended, so bots can't be created yet, but
 * nothing is broken and re-running finishes the job. Stopping after a drop-first version
 * would leave a window with *no* uniqueness on email at all, during which two humans could
 * register the same address, and no amount of re-running would undo that.
 *
 * Idempotent throughout: an existing index is left alone, a missing one is not an error.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import User from "../models/User.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");

/** The name Mongo gave the original `unique: true` on the field. */
const OLD_INDEX = "email_1";
const NEW_INDEX = "email_1_humans";

export const NEW_INDEX_SPEC = { email: 1 };
export const NEW_INDEX_OPTIONS = {
  name: NEW_INDEX,
  unique: true,
  partialFilterExpression: { isBot: false },
};

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set — nothing to connect to.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const collection = User.collection;
  const indexes = await collection.indexes();
  const byName = new Map(indexes.map((index) => [index.name, index]));

  const missingFlag = await User.countDocuments({ isBot: { $exists: false } });
  const total = await User.estimatedDocumentCount();

  console.log(`Accounts: ${total}`);
  console.log(`Missing the isBot field: ${missingFlag}`);
  console.log(`Old global index "${OLD_INDEX}": ${byName.has(OLD_INDEX) ? "present" : "absent"}`);
  console.log(`New partial index "${NEW_INDEX}": ${byName.has(NEW_INDEX) ? "present" : "absent"}`);

  /*
   * Duplicate addresses among humans are checked *before* anything is created, because the
   * new unique index cannot be built while any exist — and the failure would come from the
   * index build rather than from here, which is a far worse place to learn about it.
   *
   * There should be none: the old index has been enforcing exactly this. But a database
   * restored from a dump, or one where the index was ever dropped, can carry them, and the
   * only safe response is to stop and let a person decide which account keeps the address.
   */
  const duplicates = await User.aggregate([
    { $match: { isBot: { $ne: true } } },
    { $group: { _id: "$email", count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]);

  if (duplicates.length) {
    console.error(`\nSTOP: ${duplicates.length} email address(es) are shared by human accounts.`);
    for (const dup of duplicates) {
      console.error(`  ${dup._id} → ${dup.ids.join(", ")}`);
    }
    console.error("\nThe new unique index cannot be built until each address belongs to one");
    console.error("human account. Resolve these first; nothing has been changed.");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nWould:");
    if (missingFlag) console.log(`  · set isBot: false on ${missingFlag} account(s)`);
    if (!byName.has(NEW_INDEX)) console.log(`  · create ${NEW_INDEX} (unique, partial on isBot: false)`);
    if (byName.has(OLD_INDEX)) console.log(`  · drop ${OLD_INDEX}`);
    if (!missingFlag && byName.has(NEW_INDEX) && !byName.has(OLD_INDEX)) {
      console.log("  · nothing — this migration has already run");
    }
    console.log("\nDry run. Re-run with --apply to proceed.");
    await mongoose.disconnect();
    return;
  }

  // 1. Backfill.
  if (missingFlag) {
    const result = await User.updateMany(
      { isBot: { $exists: false } },
      { $set: { isBot: false } }
    );
    console.log(`\nBackfilled isBot: false on ${result.modifiedCount} account(s).`);
  } else {
    console.log("\nNo backfill needed.");
  }

  // 2. Create the new index.
  if (byName.has(NEW_INDEX)) {
    console.log(`${NEW_INDEX} already exists.`);
  } else {
    await collection.createIndex(NEW_INDEX_SPEC, NEW_INDEX_OPTIONS);
    console.log(`Created ${NEW_INDEX}.`);
  }

  // 3. Drop the old one, now that its guarantee is covered.
  if (byName.has(OLD_INDEX)) {
    await collection.dropIndex(OLD_INDEX);
    console.log(`Dropped ${OLD_INDEX}.`);
  } else {
    console.log(`${OLD_INDEX} was already absent.`);
  }

  const after = (await collection.indexes()).map((index) => index.name);
  console.log(`\nIndexes now: ${after.join(", ")}`);
  console.log(
    after.includes(NEW_INDEX) && !after.includes(OLD_INDEX)
      ? "Done. Bots may now share their owner's email address."
      : "Unexpected final state — inspect before creating bots."
  );

  await mongoose.disconnect();
};

/* Only when run directly, so a test can import the index spec without connecting. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(async (error) => {
    console.error("Migration failed:", error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
