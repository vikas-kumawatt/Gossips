import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import {
  buildAggregateCursorMatch,
  buildPostSearchPipeline,
  buildReplySearchPipeline,
  mergeByRecency,
  parseSearchFilters,
} from "../utils/contentSearch.js";
import { escapeRegex } from "../utils/respond.js";

const filtersOf = (query) => {
  const { filters, error } = parseSearchFilters(query);
  assert.equal(error, undefined, `expected no error, got: ${error}`);
  return filters;
};

const errorOf = (query) => parseSearchFilters(query).error;

const stageNames = (pipeline) => pipeline.map((stage) => Object.keys(stage)[0]);
const firstMatch = (pipeline) => pipeline[0].$match;

// ── Input hardening ──────────────────────────────────────────────────────────

test("regex metacharacters in a query match literally instead of compiling", () => {
  // The control against a searcher supplying their own pattern: ".*" must not
  // match everything, and "(" must not throw while compiling.
  assert.equal(new RegExp(escapeRegex(".*"), "i").test("anything"), false);
  assert.equal(new RegExp(escapeRegex(".*"), "i").test("a.*b"), true);
  assert.doesNotThrow(() => new RegExp(escapeRegex("(unclosed["), "i"));
});

test("duplicated query params arrive as arrays and collapse to the first string", () => {
  // ?q=alpha&q=beta — Express hands this over as an array, and `.trim()` on an
  // array would throw before any validation ran.
  const filters = filtersOf({ q: ["alpha", "beta"] });
  assert.equal(filters.q, "alpha");
});

test("object-valued params are discarded rather than crashing", () => {
  const filters = filtersOf({ q: { evil: 1 }, minLikes: { $gt: 0 } });
  assert.equal(filters.q, "");
  assert.equal(filters.minLikes, 0);
});

test("an over-long query is rejected, not silently truncated", () => {
  const error = errorOf({ q: "x".repeat(101) });
  assert.match(error, /100 characters/);
  // Exactly at the cap is fine.
  assert.equal(filtersOf({ q: "x".repeat(100) }).q, "x".repeat(100));
});

test("activity thresholds accept whole numbers and reject everything else", () => {
  assert.equal(filtersOf({ minLikes: "5" }).minLikes, 5);
  assert.equal(filtersOf({ minLikes: "" }).minLikes, 0);
  assert.equal(filtersOf({}).minComments, 0);

  ["1.5", "-2", "1e3", "abc", "0x10", " "].forEach((value) => {
    const filters = parseSearchFilters({ minReposts: value });
    if (value === " ") {
      // Whitespace is an empty filter, not a malformed one.
      assert.equal(filters.filters.minReposts, 0);
    } else {
      assert.ok(filters.error, `expected "${value}" to be rejected`);
    }
  });

  assert.ok(errorOf({ minLikes: "1000001" }));
});

test("date boundaries are validated and ordered", () => {
  assert.ok(errorOf({ after: "not-a-date" }));
  assert.ok(errorOf({ after: "2026-07-29T00:00:00.000Z", before: "2026-07-01T00:00:00.000Z" }));
  // Equal instants are a valid (if empty) window, not an error.
  assert.equal(
    errorOf({ after: "2026-07-01T00:00:00.000Z", before: "2026-07-01T00:00:00.000Z" }),
    undefined
  );
});

test("enum filters reject unknown values", () => {
  assert.ok(errorOf({ from: "everyone" }));
  assert.ok(errorOf({ datePosted: "past-fortnight" }));
  assert.ok(errorOf({ from: "user" }), "custom profile filter needs a username");
});

test("a username filter tolerates a leading @ and rejects an over-long handle", () => {
  assert.equal(filtersOf({ from: "user", username: "@someone" }).username, "someone");
  assert.ok(errorOf({ from: "user", username: "u".repeat(41) }));
});

test("excludeReplies reads both string and boolean forms", () => {
  assert.equal(filtersOf({ excludeReplies: "true" }).excludeReplies, true);
  assert.equal(filtersOf({ excludeReplies: "1" }).excludeReplies, true);
  assert.equal(filtersOf({ excludeReplies: "false" }).excludeReplies, false);
  assert.equal(filtersOf({}).excludeReplies, false);
});

// ── Cursor ───────────────────────────────────────────────────────────────────

test("a cursor id becomes a real ObjectId, not the decoded string", () => {
  /*
   * Aggregation does no schema casting: comparing a hex *string* with $lt
   * against ObjectIds matches nothing, silently dropping every row that shares
   * a timestamp with the cursor.
   */
  const id = new mongoose.Types.ObjectId();
  const { match } = buildAggregateCursorMatch({
    createdAt: "2026-07-01T00:00:00.000Z",
    _id: id.toString(),
  });

  assert.ok(match.$or[0].createdAt.$lt instanceof Date);
  assert.ok(match.$or[1]._id.$lt instanceof mongoose.Types.ObjectId);
  assert.equal(match.$or[1]._id.$lt.toString(), id.toString());
});

test("a tampered cursor is rejected instead of quietly matching nothing", () => {
  assert.ok(buildAggregateCursorMatch({ createdAt: "2026-07-01T00:00:00.000Z", _id: "nope" }).error);
  assert.ok(buildAggregateCursorMatch({ createdAt: "banana", _id: new mongoose.Types.ObjectId().toString() }).error);
  assert.deepEqual(buildAggregateCursorMatch(null), { match: {} });
});

// ── Pipelines ────────────────────────────────────────────────────────────────

const pipelineInput = (overrides = {}) => ({
  viewerId: new mongoose.Types.ObjectId(),
  filters: filtersOf({}),
  contentRegex: /hello/i,
  cursorMatch: {},
  authorId: null,
  followingIds: [],
  hiddenAuthorIds: [],
  limit: 16,
  ...overrides,
});

test("unpublished and deleted content is excluded from both pipelines", () => {
  const posts = firstMatch(buildPostSearchPipeline(pipelineInput()));
  assert.deepEqual(posts.isDeleted, { $ne: true });
  // A scheduled post is stored as a draft, so this covers both.
  assert.deepEqual(posts.isDraft, { $ne: true });

  const replies = firstMatch(buildReplySearchPipeline(pipelineInput()));
  assert.deepEqual(replies.isDeleted, { $ne: true });
  assert.deepEqual(replies.isScheduled, { $ne: true });
});

test("visibility filtering happens before the sort and limit", () => {
  /*
   * If the limit ran first, a page would be cut down before private and blocked
   * authors were removed — returning short pages and skipping visible posts at
   * the next cursor.
   */
  const stages = stageNames(buildPostSearchPipeline(pipelineInput()));
  const lastMatch = stages.lastIndexOf("$match");
  assert.ok(lastMatch < stages.indexOf("$sort"));
  assert.ok(stages.indexOf("$sort") < stages.indexOf("$limit"));
  assert.equal(stages[stages.length - 1], "$limit");
});

test("author constraints are combined so a mute can't be overwritten", () => {
  // Three separate conditions all write `author`; assigned rather than $and-ed,
  // the last one would win and the mute would stop applying.
  const authorId = new mongoose.Types.ObjectId();
  const hidden = [new mongoose.Types.ObjectId()];
  const following = [new mongoose.Types.ObjectId()];

  const match = firstMatch(
    buildPostSearchPipeline(
      pipelineInput({
        filters: filtersOf({ from: "user", username: "someone" }),
        authorId,
        hiddenAuthorIds: hidden,
        followingIds: following,
      })
    )
  );

  assert.equal(match.author, undefined);
  assert.equal(match.$and.length, 2);
  assert.deepEqual(match.$and[0], { author: authorId });
  assert.deepEqual(match.$and[1], { author: { $nin: hidden } });
});

test("the following filter and the hidden-author exclusion both apply", () => {
  const hidden = [new mongoose.Types.ObjectId()];
  const following = [new mongoose.Types.ObjectId()];
  const match = firstMatch(
    buildPostSearchPipeline(
      pipelineInput({
        filters: filtersOf({ from: "following" }),
        hiddenAuthorIds: hidden,
        followingIds: following,
      })
    )
  );

  assert.deepEqual(match.$and, [{ author: { $in: following } }, { author: { $nin: hidden } }]);
});

test("a date preset and an explicit after date intersect to the tighter bound", () => {
  // 2000 is far older than "past hour", so the preset wins the lower bound.
  const match = firstMatch(
    buildPostSearchPipeline(
      pipelineInput({
        filters: filtersOf({ datePosted: "hour", after: "2000-01-01T00:00:00.000Z" }),
      })
    )
  );

  const lower = match.createdAt.$gte;
  assert.ok(lower instanceof Date);
  assert.ok(lower.getTime() > new Date("2020-01-01T00:00:00.000Z").getTime());

  // The other way round: an explicit date newer than the window is the tighter one.
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const tighter = firstMatch(
    buildPostSearchPipeline(
      pipelineInput({ filters: filtersOf({ datePosted: "year", after: future }) })
    )
  );
  assert.equal(tighter.createdAt.$gte.toISOString(), future);
});

test("activity thresholds map onto the cached counters", () => {
  const match = firstMatch(
    buildPostSearchPipeline(
      pipelineInput({
        filters: filtersOf({ minLikes: "10", minComments: "2", minReposts: "3" }),
      })
    )
  );
  assert.deepEqual(match["counts.likes"], { $gte: 10 });
  assert.deepEqual(match["counts.replies"], { $gte: 2 });
  assert.deepEqual(match["counts.reposts"], { $gte: 3 });

  // A zero threshold is no threshold — it must not appear as a $gte: 0 clause.
  const none = firstMatch(buildPostSearchPipeline(pipelineInput()));
  assert.equal(none["counts.likes"], undefined);
});

test("excluding replies also excludes posts that carry a parent", () => {
  const match = firstMatch(
    buildPostSearchPipeline(
      pipelineInput({ filters: filtersOf({ excludeReplies: "true" }) })
    )
  );
  assert.equal(match.parentGossip, null);

  assert.equal(firstMatch(buildPostSearchPipeline(pipelineInput())).parentGossip, undefined);
});

test("a reply is checked against its parent post's author, not just its own", () => {
  /*
   * A public reply written under a private account's post is only visible to
   * that account's followers. Without the parent join, searching would be a way
   * to read a private thread one reply at a time.
   */
  const hidden = [new mongoose.Types.ObjectId()];
  const pipeline = buildReplySearchPipeline(pipelineInput({ hiddenAuthorIds: hidden }));
  const json = JSON.stringify(pipeline);

  assert.ok(json.includes('"postAuthorDoc"'), "parent post author must be joined");
  assert.ok(json.includes('"postDoc.isDeleted"'), "parent post must still be live");
  assert.ok(json.includes('"postDoc.isDraft"'), "unpublished parent posts must drop out");
  assert.ok(json.includes('"postDoc.author"'), "parent post author must be block-checked");

  // Two account joins (reply author, parent post author) plus the post join.
  assert.equal(stageNames(pipeline).filter((name) => name === "$lookup").length, 3);
});

test("suspended and deleted accounts drop out of search", () => {
  const json = JSON.stringify(buildPostSearchPipeline(pipelineInput()));
  ["deleted", "deactivated", "suspended", "locked"].forEach((status) => {
    assert.ok(json.includes(status), `${status} accounts must be excluded`);
  });
});

// ── Merging two collections into one page ────────────────────────────────────

test("posts and replies interleave strictly by recency", () => {
  const merged = mergeByRecency(
    [
      { _id: "a", createdAt: "2026-07-01T00:00:00.000Z", kind: "post" },
      { _id: "b", createdAt: "2026-07-03T00:00:00.000Z", kind: "reply" },
      { _id: "c", createdAt: "2026-07-02T00:00:00.000Z", kind: "post" },
    ],
    10
  );
  assert.deepEqual(merged.map((item) => item._id), ["b", "c", "a"]);
});

test("identical timestamps fall back to descending id, matching the cursor", () => {
  const older = "6600000000000000000000a1";
  const newer = "6600000000000000000000a2";
  const merged = mergeByRecency(
    [
      { _id: older, createdAt: "2026-07-01T00:00:00.000Z" },
      { _id: newer, createdAt: "2026-07-01T00:00:00.000Z" },
    ],
    10
  );
  assert.deepEqual(merged.map((item) => item._id), [newer, older]);
});

test("merging trims to the requested size", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    _id: `id${index}`,
    createdAt: new Date(2026, 0, index + 1).toISOString(),
  }));
  assert.equal(mergeByRecency(items, 16).length, 16);
  // Newest first, so the trim drops the oldest rows.
  assert.equal(mergeByRecency(items, 1)[0]._id, "id29");
});
