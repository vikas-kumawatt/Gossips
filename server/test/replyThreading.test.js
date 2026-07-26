import assert from "node:assert/strict";
import test from "node:test";
import { resolveReplyThread } from "../utils/replyThreading.js";
import { buildCursorQuery } from "../utils/cursorPagination.js";

test("a reply to a top-level comment anchors under that comment", () => {
  const topLevel = { _id: "c1", parent: null };
  const { parent, replyTo } = resolveReplyThread(topLevel, "c1");
  assert.equal(parent, "c1");
  assert.equal(replyTo, "c1");
});

test("a reply to a reply anchors under the top-level comment, not the reply", () => {
  // reply r1 lives under top-level comment c1
  const reply = { _id: "r1", parent: "c1" };
  const { parent, replyTo } = resolveReplyThread(reply, "r1");
  // Structural parent flattens to the root; the answered comment is remembered.
  assert.equal(parent, "c1");
  assert.equal(replyTo, "r1");
});

test("ascending cursor pages forward with $gt so oldest-first replies don't repeat", () => {
  const cursor = { createdAt: "2026-07-01T00:00:00.000Z", _id: "abc" };
  const asc = buildCursorQuery(cursor, "asc");
  assert.equal(asc.$or[0].createdAt.$gt instanceof Date, true);
  assert.equal(asc.$or[1]._id.$gt, "abc");
});

test("descending cursor is unchanged (default) for newest-first feeds", () => {
  const cursor = { createdAt: "2026-07-01T00:00:00.000Z", _id: "abc" };
  const desc = buildCursorQuery(cursor);
  assert.equal(desc.$or[0].createdAt.$lt instanceof Date, true);
  assert.equal(desc.$or[1]._id.$lt, "abc");
});

test("no cursor yields an empty (unfiltered) query in both directions", () => {
  assert.deepEqual(buildCursorQuery(null, "asc"), {});
  assert.deepEqual(buildCursorQuery(null, "desc"), {});
});
