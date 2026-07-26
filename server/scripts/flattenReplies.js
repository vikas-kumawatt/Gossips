/**
 * Flatten existing comment threads to two levels.
 *
 *   node scripts/flattenReplies.js [--dry]
 *
 * The reply model used to allow unlimited nesting (a reply could be the parent
 * of another reply). It's now two levels: a top-level comment and a flat list
 * of replies. This backfills existing data to match:
 *
 *   - Every reply's `parent` is re-anchored to its top-level (root) comment.
 *   - `replyTo` is set to the comment the reply actually answered (its old
 *     immediate parent), so "Replying to @user" and notifications still work.
 *   - `counts.replies` is recomputed from scratch on every comment (= live
 *     replies whose parent is that comment) and every post (= all its live
 *     comments), so the flattening can't leave counts stale.
 *
 * Idempotent: safe to run more than once. `--dry` reports what would change
 * without writing.
 *
 * Run from the server directory with the same .env the app uses.
 */
import "dotenv/config";
import mongoose from "mongoose";
import Comment from "../models/Comment.js";
import Post from "../models/Post.js";

const isLive = (c) => c.isDeleted !== true && c.isScheduled !== true;

const run = async () => {
  const dry = process.argv.includes("--dry");

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) {
    console.error("No Mongo connection string found (MONGO_URI / MONGODB_URI / DB_URI).");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const comments = await Comment.find({})
    .select("_id parent replyTo post isDeleted isScheduled counts")
    .lean();

  const byId = new Map(comments.map((c) => [c._id.toString(), c]));

  // Walk up the (possibly deep) parent chain to the top-level comment. Guarded
  // against cycles and missing parents.
  const rootOf = (comment) => {
    let current = comment;
    const seen = new Set();
    while (current.parent) {
      const key = current.parent.toString();
      if (seen.has(key)) break; // cycle guard
      seen.add(key);
      const parent = byId.get(key);
      if (!parent) break; // dangling parent — treat current as the root's child
      if (!parent.parent) return parent; // parent is top-level → it's the root
      current = parent;
    }
    return current.parent ? byId.get(current.parent.toString()) || comment : comment;
  };

  // 1) Re-anchor replies and set replyTo.
  const structureOps = [];
  for (const c of comments) {
    if (!c.parent) continue; // top-level comment
    const root = rootOf(c);
    const newParent = root?._id || c.parent;
    const newReplyTo = c.replyTo || c.parent; // the comment actually answered

    const parentChanged = newParent.toString() !== c.parent.toString();
    const replyToChanged = !c.replyTo || c.replyTo.toString() !== newReplyTo.toString();
    if (parentChanged || replyToChanged) {
      structureOps.push({
        updateOne: {
          filter: { _id: c._id },
          update: { $set: { parent: newParent, replyTo: newReplyTo } },
        },
      });
      // Reflect the change in-memory so count recomputation below is accurate.
      c.parent = newParent;
      c.replyTo = newReplyTo;
    }
  }

  // 2) Recompute counts.replies for every comment.
  const liveChildCount = new Map();
  for (const c of comments) {
    if (!c.parent || !isLive(c)) continue;
    const key = c.parent.toString();
    liveChildCount.set(key, (liveChildCount.get(key) || 0) + 1);
  }
  const commentCountOps = [];
  for (const c of comments) {
    const want = liveChildCount.get(c._id.toString()) || 0;
    if ((c.counts?.replies ?? 0) !== want) {
      commentCountOps.push({
        updateOne: { filter: { _id: c._id }, update: { $set: { "counts.replies": want } } },
      });
    }
  }

  // 3) Recompute counts.replies for every post (= all its live comments).
  const livePostCount = new Map();
  for (const c of comments) {
    if (!isLive(c) || !c.post) continue;
    const key = c.post.toString();
    livePostCount.set(key, (livePostCount.get(key) || 0) + 1);
  }
  const postCountOps = [];
  for (const [postId, want] of livePostCount) {
    postCountOps.push({
      updateOne: { filter: { _id: postId }, update: { $set: { "counts.replies": want } } },
    });
  }

  console.log(
    `Comments: ${comments.length} | re-anchor/replyTo: ${structureOps.length} | ` +
      `comment-count fixes: ${commentCountOps.length} | posts touched: ${postCountOps.length}`
  );

  if (dry) {
    console.log("Dry run — no changes written.");
    await mongoose.disconnect();
    return;
  }

  if (structureOps.length) await Comment.bulkWrite(structureOps);
  if (commentCountOps.length) await Comment.bulkWrite(commentCountOps);
  if (postCountOps.length) await Post.bulkWrite(postCountOps);

  console.log("Done.");
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("flattenReplies failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
