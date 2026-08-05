/**
 * Purge the document messages sent before documents were removed from the product.
 *
 *   node scripts/purgeDocumentMessages.js            # dry run — reports, changes nothing
 *   node scripts/purgeDocumentMessages.js --apply    # does it
 *   node scripts/purgeDocumentMessages.js --apply --keep-files   # rows only, leave Cloudinary
 *
 * ── Why tombstones rather than deletes ──────────────────────────────────────
 *
 * Each row becomes the same tombstone an unsend produces — `isDeleted: true`, the
 * standard "This message was deleted" body, no media — instead of being removed.
 * Deleting the documents outright would break things that point at them:
 *
 *   · a reply quoting one resolves `replyTo` against a message that no longer exists
 *   · `ConversationRead` counts were computed including it, so every unread badge in
 *     that thread would be off by one until the next full recount
 *   · a pinned document would hold a pin slot nothing can release
 *
 * A tombstone keeps the thread's shape and the counts honest while removing the
 * content, which is what "purge" actually needs to mean here.
 *
 * `messageType` is rewritten to "text" as part of it. That is what lets the schema
 * drop "file" from its enum and the client drop its document branch: afterwards no
 * row carries either value, so nothing has to keep the code that reads them. It also
 * means `messagePreviewLabel` renders these correctly with no legacy case at all — it
 * checks `isDeleted` before it looks at the type.
 *
 * Idempotent: it selects on `messageType: "file"` or a `document` media item, and
 * leaves neither behind, so a second run finds nothing.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Message from "../models/Message.js";
import MessageReaction from "../models/MessageReaction.js";
import { deleteFromCloudinary } from "../config/cloudinary.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const KEEP_FILES = process.argv.includes("--keep-files");

/*
 * Both shapes, because they can disagree.
 *
 * `messageType: "file"` is what the send path set, and `media[].type: "document"` is
 * what the upload classifier set — but a message could carry a document attachment
 * under a different type, and an old `file` message could have lost its media to an
 * earlier unsend. Matching either catches both without assuming they were always
 * written together.
 */
export const QUERY = {
  $or: [{ messageType: "file" }, { "media.type": "document" }],
};

export const TOMBSTONE_BODY = "This message was deleted";

/**
 * The update that turns a document message into a tombstone.
 *
 * Exported and built by a function so it can be asserted against `unsendMessage`'s
 * behaviour in a test — the two have to agree, and there is no type system here to
 * notice when they stop.
 */
export const buildTombstoneUpdate = () => ({
  $set: {
    messageType: "text",
    content: TOMBSTONE_BODY,
    media: [],
    isDeleted: true,
    /*
     * Unpinned, matching `unsendMessage`.
     *
     * A tombstone that stayed pinned occupies one of the conversation's pin slots while
     * being invisible in the pinned list — five of those and nobody in that conversation
     * can pin anything again, with no way to unpin what they can't see. `false` rather
     * than `$unset`, because the field has a schema default and a lean read of a missing
     * one gives `undefined` instead of it.
     */
    isPinned: false,
    // The cached top-3, zeroed; the rows themselves are deleted separately. Otherwise
    // "This message was deleted" renders with three hearts under it.
    "reactionSummary.total": 0,
    "reactionSummary.top": [],
  },
  /*
   * The ticket, bumped — not part of the `$set` above.
   *
   * `clearReactions` increments `seq` so that a recompute which read the reaction rows a
   * moment before the delete cannot land its old count on the tombstone. Writing the
   * whole `reactionSummary` object in `$set` would both discard the existing `seq` and
   * conflict with this `$inc`, which Mongo rejects outright — the two must address
   * separate paths.
   */
  $inc: { "reactionSummary.seq": 1 },
  $unset: { poll: "", sharedContent: "", pinnedAt: "", pinnedBy: "" },
});

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set — nothing to connect to.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const total = await Message.countDocuments(QUERY);
  if (!total) {
    console.log("No legacy document messages found. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${total} message(s) carrying a document.\n`);

  // Every Cloudinary URL to destroy, gathered before anything is rewritten — once a
  // row is a tombstone its media is gone and the assets would be unreachable.
  const assets = [];
  let alreadyTombstoned = 0;
  const byType = new Map();

  // The ids as well, for the reaction rows below.
  const ids = [];

  const cursor = Message.find(QUERY)
    .select("messageType media isDeleted createdAt")
    .lean()
    .cursor();

  for await (const message of cursor) {
    ids.push(message._id);
    byType.set(message.messageType, (byType.get(message.messageType) || 0) + 1);
    if (message.isDeleted) alreadyTombstoned += 1;
    for (const item of message.media || []) {
      // Only the documents. A `file` message shouldn't hold a photo, but if one does,
      // that photo is not this script's business to delete.
      if (item?.type === "document" && item.url) assets.push(item.url);
    }
  }

  console.log("By messageType:");
  for (const [type, count] of byType) console.log(`  ${type}: ${count}`);
  console.log(`Already tombstoned (content already gone): ${alreadyTombstoned}`);
  console.log(`Cloudinary assets to destroy: ${assets.length}\n`);

  if (!APPLY) {
    console.log("Dry run — nothing was changed. Re-run with --apply to proceed.");
    await mongoose.disconnect();
    return;
  }

  /*
   * Rows first, assets second.
   *
   * If this is interrupted, a tombstoned row with a surviving Cloudinary asset is an
   * orphaned file nobody can reach — wasted storage. The other order would leave a
   * message pointing at an asset that no longer exists, which renders as a broken
   * attachment in someone's thread. Wasted bytes beat a broken thread, and the
   * leftovers can be swept by running this again.
   */
  const result = await Message.updateMany(QUERY, buildTombstoneUpdate());

  console.log(`Rewrote ${result.modifiedCount} row(s) as tombstones.`);

  /*
   * The reaction rows, which `Message.clearReactions()` would have handled had this
   * been one save per message. It isn't — this is a bulk rewrite — so the cascade has
   * to be done explicitly, and missing it would leave MessageReaction rows pointing at
   * content that no longer exists.
   */
  const reactions = await MessageReaction.deleteMany({ message: { $in: ids } });
  console.log(`Deleted ${reactions.deletedCount} orphaned reaction row(s).`);

  if (KEEP_FILES) {
    console.log("--keep-files given: Cloudinary assets left in place.");
  } else {
    let destroyed = 0;
    let failed = 0;
    for (const url of assets) {
      // Sequential on purpose: this is a one-off against a rate-limited API, and
      // finishing a minute later is better than being throttled halfway through.
      if (await deleteFromCloudinary(url)) destroyed += 1;
      else failed += 1;
    }
    console.log(`Destroyed ${destroyed} asset(s); ${failed} failed.`);
    if (failed) {
      console.log("Failures are logged above. Re-running is safe but will not retry");
      console.log("them — the rows are already tombstones, so the URLs are gone.");
    }
  }

  const remaining = await Message.countDocuments(QUERY);
  console.log(`\nRemaining legacy document messages: ${remaining}`);
  if (remaining) {
    console.log("Not zero — investigate before removing the legacy code paths.");
  } else {
    console.log("Clean. The schema and client may now drop 'file' and 'document'.");
  }

  await mongoose.disconnect();
};

/*
 * Only when run directly.
 *
 * Importing this file to test `QUERY` and `buildTombstoneUpdate` must not connect to a
 * database and start rewriting rows.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(async (error) => {
    console.error("Purge failed:", error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
