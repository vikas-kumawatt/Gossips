/**
 * Cursor merging and conversation keys.
 *
 * Both of these are pure and both had bugs that were invisible from the
 * outside: the query still returned rows, they were just the wrong rows.
 *
 * Run: node --test test/chatPagination.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCursorPageInfo,
  buildCursorQuery,
  encodeCursor,
  decodeCursor,
  mergeFilters,
  withCursor,
} from "../utils/cursorPagination.js";
import {
  activityCursorFilter,
  decodeActivityCursor,
  encodeActivityCursor,
  participantsOfConversation,
} from "../utils/conversationActivity.js";
import Message from "../models/Message.js";

const CURSOR = { createdAt: "2026-07-01T00:00:00.000Z", _id: "0".repeat(23) + "1" };

// ── mergeFilters ─────────────────────────────────────────────────────────────
//
// The same class of bug as withCursor's, found a second time in `globalSearch`: a
// content-match `{$or}` was spread over a caller-scoping `{$or}`, so the predicate
// restricting results to the caller's own conversations disappeared and the endpoint
// returned every matching direct message in the collection to any authenticated
// user. Rows came back either way, which is why it went unnoticed.

test("mergeFilters keeps both $or predicates instead of one overwriting the other", () => {
  const scope = { $or: [{ sender: "me" }, { receiver: "me" }] };
  const content = { $or: [{ content: /x/ }, { "media.caption": /x/ }] };
  const merged = mergeFilters(scope, content, { isDeleted: { $ne: true } });

  assert.equal(merged.$or, undefined, "two $ors cannot be siblings");
  assert.equal(merged.$and.length, 2);
  assert.deepEqual(merged.$and[0], scope, "the caller scope survives");
  assert.deepEqual(merged.$and[1], content, "and so does the content match");
  assert.deepEqual(merged.isDeleted, { $ne: true }, "non-colliding keys stay flat");
});

test("mergeFilters leaves a single $or flat", () => {
  // The common case has to produce exactly the object you'd write by hand, or
  // every query in the app gains an $and the planner has to see through.
  const merged = mergeFilters({ group: { $in: ["g"] } }, { $or: [{ content: /x/ }] });
  assert.deepEqual(merged, { group: { $in: ["g"] }, $or: [{ content: /x/ }] });
});

test("mergeFilters extends an existing $and rather than dropping it", () => {
  const merged = mergeFilters(
    { $and: [{ a: 1 }], $or: [{ b: 2 }] },
    { $or: [{ c: 3 }] }
  );
  assert.equal(merged.$and.length, 3, "the original $and clause plus both $ors");
  assert.deepEqual(merged.$and[0], { a: 1 });
});

test("mergeFilters ignores null and undefined inputs", () => {
  assert.deepEqual(mergeFilters(null, { a: 1 }, undefined), { a: 1 });
  assert.deepEqual(mergeFilters(), {});
});

test("mergeFilters requires *both* clauses when three filters collide", () => {
  const merged = mergeFilters({ $or: [{ a: 1 }] }, { $or: [{ b: 2 }] }, { $or: [{ c: 3 }] });
  assert.equal(merged.$and.length, 3);
  assert.deepEqual(
    merged.$and.map((clause) => clause.$or[0]),
    [{ a: 1 }, { b: 2 }, { c: 3 }]
  );
});

// ── withCursor ───────────────────────────────────────────────────────────────

test("withCursor keeps a base $or instead of overwriting it", () => {
  const base = { conversation: "a:b", $or: [{ content: /x/ }, { "media.caption": /x/ }] };
  const merged = withCursor(base, CURSOR);

  // The base $or must survive. Spreading used to drop it, which turned page
  // two of a search into "every message older than the cursor".
  assert.equal(merged.$or, undefined, "the two $ors cannot be siblings");
  assert.equal(merged.$and.length, 2);
  assert.deepEqual(merged.$and[0], { $or: base.$or });
  assert.ok(merged.$and[1].$or, "the cursor predicate is the second clause");
  assert.equal(merged.conversation, "a:b", "other keys are preserved");
});

test("withCursor appends to an existing $and rather than replacing it", () => {
  const base = { $and: [{ a: 1 }], $or: [{ b: 2 }] };
  const merged = withCursor(base, CURSOR);
  assert.equal(merged.$and.length, 3);
  assert.deepEqual(merged.$and[0], { a: 1 });
});

test("withCursor spreads when there is no base $or", () => {
  const merged = withCursor({ conversation: "a:b" }, CURSOR);
  assert.ok(merged.$or, "no collision, so the cursor stays at the top level");
  assert.equal(merged.$and, undefined);
});

test("withCursor without a cursor returns the query unchanged", () => {
  const base = { conversation: "a:b", $or: [{ content: 1 }] };
  assert.deepEqual(withCursor(base, null), base);
});

test("withCursor does not mutate the query it is given", () => {
  const base = { conversation: "a:b", $or: [{ content: 1 }] };
  const snapshot = JSON.stringify(base);
  withCursor(base, CURSOR);
  assert.equal(JSON.stringify(base), snapshot);
});

// ── Cursor field ─────────────────────────────────────────────────────────────

test("a cursor can be built on a field other than createdAt", () => {
  const row = { pinnedAt: new Date("2026-06-01T00:00:00.000Z"), _id: CURSOR._id };
  const decoded = decodeCursor(encodeCursor(row, "pinnedAt"));

  assert.equal(decoded.field, "pinnedAt");
  const q = buildCursorQuery(decoded);
  // The boundary must be compared against the field the query sorts by.
  // Paging on createdAt while sorting on pinnedAt both skipped and repeated
  // rows, because the predicate had nothing to do with the ordering.
  assert.ok(q.$or[0].pinnedAt, "the predicate targets pinnedAt");
  assert.equal(q.$or[0].createdAt, undefined);
  assert.ok(q.$or[1].pinnedAt instanceof Date);
});

test("encodeCursor returns null when the sort field is missing from the row", () => {
  assert.equal(encodeCursor({ _id: CURSOR._id }, "pinnedAt"), null);
});

test("a cursor issued before the field parameter existed still means createdAt", () => {
  // Old cursors carry no `field` key at all; they must not start matching
  // against `undefined`.
  const legacy = Buffer.from(JSON.stringify(CURSOR)).toString("base64url");
  const q = buildCursorQuery(decodeCursor(legacy));
  assert.ok(q.$or[0].createdAt);
});

test("direction still selects the comparison operator", () => {
  assert.ok(buildCursorQuery(CURSOR, "desc").$or[0].createdAt.$lt);
  assert.ok(buildCursorQuery(CURSOR, "asc").$or[0].createdAt.$gt);
});

// ── Page info ────────────────────────────────────────────────────────────────

test("hasNextPage is false when the boundary row can't produce a cursor", () => {
  // A message pinned before `pinnedAt` existed. Claiming another page while
  // handing back a null cursor is a "load more" button that can never work.
  const rows = [
    { _id: "a", pinnedAt: new Date() },
    { _id: "b", pinnedAt: null },
    { _id: "c", pinnedAt: new Date() },
  ];
  const { pageInfo } = buildCursorPageInfo(rows, 2, "pinnedAt");
  assert.equal(pageInfo.nextCursor, null);
  assert.equal(pageInfo.hasNextPage, false);
});

test("hasNextPage is true when the boundary row does have the sort field", () => {
  const rows = [
    { _id: "a", pinnedAt: new Date() },
    { _id: "b", pinnedAt: new Date() },
    { _id: "c", pinnedAt: new Date() },
  ];
  const { items, pageInfo } = buildCursorPageInfo(rows, 2, "pinnedAt");
  assert.equal(items.length, 2);
  assert.equal(pageInfo.hasNextPage, true);
  assert.ok(pageInfo.nextCursor);
});

// ── Conversation keys ────────────────────────────────────────────────────────

const LOWER = "5f8d0d55b54764421b7156c3";
const UPPER = LOWER.toUpperCase();
const OTHER = "1a2b3c4d5e6f708192a3b4c5";

test("a DM key is the same whichever case the id arrives in", () => {
  // Uppercase hex is a valid ObjectId string, and Mongoose casts `receiver`
  // from it happily — so the message was stored and acked, under a key nobody
  // would ever query. It was invisible to both parties, permanently.
  assert.equal(
    Message.dmConversationKey(UPPER, OTHER),
    Message.dmConversationKey(LOWER, OTHER)
  );
});

test("a DM key is the same whichever way round the pair is given", () => {
  assert.equal(
    Message.dmConversationKey(LOWER, OTHER),
    Message.dmConversationKey(OTHER, LOWER)
  );
});

test("case does not flip the sort order of a DM key", () => {
  // 'A' < 'a' in a plain string comparison, so an uppercase id sorted ahead of
  // every lowercase one and the two halves of the pair could disagree.
  assert.equal(Message.dmConversationKey(UPPER, OTHER), `${OTHER}:${LOWER}`);
});

test("a group key is lowercased", () => {
  assert.equal(Message.groupConversationKey(UPPER), `g:${LOWER}`);
});

test("conversation keys accept a populated document as well as an id", () => {
  assert.equal(
    Message.dmConversationKey({ _id: LOWER }, OTHER),
    Message.dmConversationKey(LOWER, OTHER)
  );
});

// ── The chat list's activity cursor (CF23/CF24) ───────────────────────────────
//
// `getChats` pages `ConversationRead` on (lastMessageAt, _id) descending. Getting the
// tiebreak wrong here doesn't fail — it skips or repeats conversations at a page
// boundary, which reads as "a chat disappeared" and can't be reproduced on demand.

test("an activity cursor round-trips", () => {
  const row = { lastMessageAt: new Date("2026-07-01T00:00:00.000Z"), _id: OTHER };
  const decoded = decodeActivityCursor(encodeActivityCursor(row));
  assert.deepEqual(decoded, { lastMessageAt: "2026-07-01T00:00:00.000Z", _id: OTHER });
});

test("a row with no activity yields no cursor", () => {
  // Rather than a cursor pointing at `null`, which would page from the epoch and
  // re-serve the entire list.
  assert.equal(encodeActivityCursor({ _id: OTHER }), null);
  assert.equal(encodeActivityCursor(null), null);
});

test("a malformed or truncated cursor decodes to null, not a throw", () => {
  // It arrives in the query string, so it is attacker-controlled: a 500 on
  // `?cursor=x` would be a one-character denial of the chat list.
  assert.equal(decodeActivityCursor("not-base64!!"), null);
  assert.equal(decodeActivityCursor(Buffer.from("{}").toString("base64url")), null);
  assert.equal(decodeActivityCursor(""), null);
  assert.equal(decodeActivityCursor(undefined), null);
  assert.equal(decodeActivityCursor(["a"]), null);
});

test("the activity predicate pages strictly backwards, with _id as the tiebreak", () => {
  const at = "2026-07-01T00:00:00.000Z";
  const filter = activityCursorFilter({ lastMessageAt: at, _id: OTHER });

  assert.equal(filter.$or.length, 2);
  assert.deepEqual(filter.$or[0], { lastMessageAt: { $lt: new Date(at) } });
  // Descending sort means a descending tiebreak. `$gt` here would serve the rows
  // *above* the boundary again — the same page, forever.
  assert.deepEqual(filter.$or[1].lastMessageAt, new Date(at));
  assert.equal(filter.$or[1]._id.$lt.toString(), OTHER);
});

test("the tiebreak id is cast, not left as a string", () => {
  // A string sorts below every ObjectId in BSON, so an uncast `_id` makes the
  // tiebreak branch match nothing and silently drops every conversation that
  // shares the boundary millisecond.
  const filter = activityCursorFilter({ lastMessageAt: "2026-07-01T00:00:00.000Z", _id: OTHER });
  assert.equal(typeof filter.$or[1]._id.$lt, "object");
});

test("no cursor means no predicate", () => {
  // `{}` and not `{$or: []}`: an empty `$or` matches nothing, so page one would
  // come back empty.
  assert.deepEqual(activityCursorFilter(null), {});
  assert.deepEqual(activityCursorFilter({ _id: OTHER }), {});
  assert.deepEqual(activityCursorFilter({ lastMessageAt: "2026-07-01T00:00:00.000Z" }), {});
});

// ── Who a conversation belongs to ─────────────────────────────────────────────
//
// The backfill derives participants from the key alone. Writing a row for the wrong
// user puts someone else's conversation in their chat list.

test("a DM key yields both participants", async () => {
  const participants = await participantsOfConversation(`${OTHER}:${LOWER}`);
  assert.deepEqual(participants.map(String).sort(), [LOWER, OTHER].sort());
});

test("a self-conversation yields one participant, not two rows on one key", async () => {
  const participants = await participantsOfConversation(`${LOWER}:${LOWER}`);
  assert.equal(participants.length, 1);
});

test("a key that isn't a DM or a group yields nobody", async () => {
  // Two ids or nothing: a malformed key with five segments would otherwise write
  // five rows, and a row is what puts a conversation in someone's list.
  for (const key of [`${LOWER}:${OTHER}:${LOWER}`, LOWER, "", "g:", "g:nope", null, 42]) {
    assert.deepEqual(await participantsOfConversation(key), [], `key: ${String(key)}`);
  }
});
