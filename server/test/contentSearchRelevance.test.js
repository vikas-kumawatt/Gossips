import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import {
  buildPostSearchPipeline,
  buildReplySearchPipeline,
  isTextIndexUnavailable,
  looksLikeWholeWords,
  mergeByRelevance,
  parseSearchFilters,
} from "../utils/contentSearch.js";

/**
 * The relevance sort, which `contentSearch.test.js` does not cover — that file
 * predates it and asserts the chronological path.
 *
 * These are shape assertions over the emitted pipeline rather than round trips
 * through Mongo, for the same reason the rest of this directory is: the suites
 * run with no database and no network. That is a real limit — nothing here
 * proves the *ranking* is any good — but it does pin the several MongoDB
 * constraints this pipeline has to satisfy, each of which fails at runtime and
 * silently if broken.
 */

const filtersOf = (query) => {
  const { filters, error } = parseSearchFilters(query);
  assert.equal(error, undefined, `expected no error, got: ${error}`);
  return filters;
};

const stageNames = (pipeline) => pipeline.map((stage) => Object.keys(stage)[0]);

const rankedInput = (overrides = {}) => ({
  viewerId: new mongoose.Types.ObjectId(),
  filters: filtersOf({ q: "coffee", sort: "relevance" }),
  contentRegex: null,
  textQuery: "coffee",
  cursorMatch: {},
  authorId: null,
  followingIds: [],
  hiddenAuthorIds: [],
  limit: 16,
  ...overrides,
});

const chronologicalInput = (overrides = {}) => ({
  ...rankedInput(),
  contentRegex: /coffee/i,
  textQuery: null,
  filters: filtersOf({ q: "coffee" }),
  ...overrides,
});

// ── Filter parsing ───────────────────────────────────────────────────────────

test("sort defaults to recent and accepts only the two known modes", () => {
  assert.equal(filtersOf({}).sort, "recent");
  assert.equal(filtersOf({ sort: "recent" }).sort, "recent");
  assert.equal(filtersOf({ sort: "relevance" }).sort, "relevance");
  // Rejected rather than defaulted: a relevance toggle that silently did
  // nothing is the failure this guards against.
  assert.ok(parseSearchFilters({ sort: "top" }).error);
  assert.ok(parseSearchFilters({ sort: "" , q: "x" }).error === undefined);
});

test("looksLikeWholeWords gates the queries a text index can actually answer", () => {
  // A trailing fragment is what a half-typed query looks like; the index finds
  // nothing for it, so the controller must not choose the ranked path.
  assert.equal(looksLikeWholeWords("cof"), false);
  assert.equal(looksLikeWholeWords("a"), false);
  assert.equal(looksLikeWholeWords("coffee"), true);
  assert.equal(looksLikeWholeWords("cold brew"), true);
  // Multi-word wins even when each word is short — "to be" is a real query.
  assert.equal(looksLikeWholeWords("to be"), true);
  assert.equal(looksLikeWholeWords("   "), false);
  assert.equal(looksLikeWholeWords(""), false);
  assert.equal(looksLikeWholeWords(undefined), false);
});

// ── Pipeline shape: the MongoDB constraints ──────────────────────────────────

test("THE CONSTRAINT: $text is in the first $match, where Mongo requires it", () => {
  for (const build of [buildPostSearchPipeline, buildReplySearchPipeline]) {
    const pipeline = build(rankedInput());
    assert.deepEqual(pipeline[0].$match.$text, { $search: "coffee" });

    // And nowhere else — a second $text anywhere is rejected by the server.
    const occurrences = JSON.stringify(pipeline).split('"$text"').length - 1;
    assert.equal(occurrences, 1, "$text must appear exactly once");
  }
});

test("THE CONSTRAINT: the score is captured before any $lookup can lose it", () => {
  /*
   * `$meta: "textScore"` is only readable in the stage following the `$text`
   * match. Both pipelines then run several `$lookup`/`$unwind` stages before
   * they sort, so the score is materialised into a real field immediately —
   * otherwise the later `$sort` reads a field that is not there and the
   * ordering silently becomes arbitrary.
   */
  for (const build of [buildPostSearchPipeline, buildReplySearchPipeline]) {
    const pipeline = build(rankedInput());
    const names = stageNames(pipeline);

    assert.deepEqual(pipeline[1].$addFields, { score: { $meta: "textScore" } });
    assert.ok(
      names.indexOf("$addFields") < names.indexOf("$lookup"),
      "score must be captured before the first join"
    );
  }
});

test("ranked results sort by score, with recency and id as deterministic tiebreaks", () => {
  for (const build of [buildPostSearchPipeline, buildReplySearchPipeline]) {
    const pipeline = build(rankedInput());
    const sort = pipeline.find((stage) => stage.$sort).$sort;
    assert.deepEqual(sort, { score: -1, createdAt: -1, _id: -1 });
    // A plain field, not `$meta` again — see the previous test.
    assert.equal(typeof sort.score, "number");
  }
});

test("THE CORRECTNESS BUG: no $skip inside either pipeline", () => {
  /*
   * Posts and replies are ranked independently and merged afterwards, so a
   * `$skip` of 15 in each yields rows 15–30 of two separate lists rather than
   * rows 15–30 of the merged one. The offset has to be applied after the merge,
   * which means it must not appear here.
   */
  for (const build of [buildPostSearchPipeline, buildReplySearchPipeline]) {
    assert.ok(!stageNames(build(rankedInput())).includes("$skip"));
    assert.ok(!stageNames(build(rankedInput({ limit: 100 }))).includes("$skip"));
  }
});

test("the two modes are mutually exclusive: ranked carries no regex", () => {
  const ranked = buildPostSearchPipeline(rankedInput());
  assert.equal(ranked[0].$match.content, undefined);

  const chronological = buildPostSearchPipeline(chronologicalInput());
  assert.ok(chronological[0].$match.content instanceof RegExp);
  assert.equal(chronological[0].$match.$text, undefined);
});

test("REGRESSION: the chronological pipeline is untouched by the ranking work", () => {
  for (const build of [buildPostSearchPipeline, buildReplySearchPipeline]) {
    const pipeline = build(chronologicalInput());
    const names = stageNames(pipeline);

    assert.ok(!names.includes("$addFields"), "no score stage on the recent path");
    assert.equal(pipeline.find((stage) => stage.$sort).$sort.score, undefined);
    assert.deepEqual(pipeline.find((stage) => stage.$sort).$sort, {
      createdAt: -1,
      _id: -1,
    });
    // Still projects only the keys the sort needs.
    const project = pipeline.find((stage) => stage.$project).$project;
    assert.deepEqual(project, { _id: 1, createdAt: 1 });
  }
});

test("the ranked projection carries the score through to the merge", () => {
  const project = buildPostSearchPipeline(rankedInput()).find((s) => s.$project).$project;
  assert.deepEqual(project, { _id: 1, createdAt: 1, score: 1 });
});

test("visibility filtering still precedes the sort and limit on the ranked path", () => {
  // The join must not be skipped by the ranking branch, or a private account's
  // posts would surface for the sake of a better-ranked page.
  for (const build of [buildPostSearchPipeline, buildReplySearchPipeline]) {
    const names = stageNames(build(rankedInput()));
    assert.ok(names.lastIndexOf("$match") < names.indexOf("$sort"));
    assert.ok(names.indexOf("$sort") < names.indexOf("$limit"));
    assert.equal(names[names.length - 1], "$limit");
  }
});

// ── Merging ──────────────────────────────────────────────────────────────────

test("mergeByRelevance orders by score across both collections", () => {
  const merged = mergeByRelevance(
    [
      { _id: "a", kind: "post", score: 1.2, createdAt: "2026-01-01T00:00:00.000Z" },
      { _id: "b", kind: "reply", score: 4.5, createdAt: "2026-01-01T00:00:00.000Z" },
      { _id: "c", kind: "post", score: 2.8, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    10
  );
  // A reply outranking both posts is the point: merging by recency here would
  // discard the ranking that was just computed.
  assert.deepEqual(merged.map((row) => row._id), ["b", "c", "a"]);
});

test("equal scores fall back to recency, then to id, so the order is total", () => {
  /*
   * Offset pagination over a non-total order shows one row twice and another
   * never, because two equally-scored rows can swap places between requests.
   */
  const merged = mergeByRelevance(
    [
      { _id: "6600000000000000000000a1", score: 3, createdAt: "2026-01-01T00:00:00.000Z" },
      { _id: "6600000000000000000000a2", score: 3, createdAt: "2026-01-01T00:00:00.000Z" },
      { _id: "6600000000000000000000a3", score: 3, createdAt: "2026-02-01T00:00:00.000Z" },
    ],
    10
  );
  assert.deepEqual(merged.map((row) => row._id), [
    "6600000000000000000000a3", // newest of the tied scores
    "6600000000000000000000a2", // then descending id, matching mergeByRecency
    "6600000000000000000000a1",
  ]);
});

test("a missing score sorts last rather than throwing", () => {
  const merged = mergeByRelevance(
    [
      { _id: "a", createdAt: "2026-01-01T00:00:00.000Z" },
      { _id: "b", score: 0.1, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    10
  );
  assert.deepEqual(merged.map((row) => row._id), ["b", "a"]);
});

test("mergeByRelevance trims to the requested size, keeping the best", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    _id: `id${index}`,
    score: index,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  assert.equal(mergeByRelevance(items, 16).length, 16);
  assert.equal(mergeByRelevance(items, 1)[0]._id, "id29");
});

test("slicing after the merge is what makes the offset correct", () => {
  /*
   * The controller fetches `skip + limit + 1` from each collection and slices
   * the merged list. This is that arithmetic, on a merged list built from two
   * independently-ranked sources.
   */
  const posts = [
    { _id: "p1", score: 9, createdAt: "2026-01-01T00:00:00.000Z" },
    { _id: "p2", score: 5, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const replies = [
    { _id: "r1", score: 7, createdAt: "2026-01-01T00:00:00.000Z" },
    { _id: "r2", score: 3, createdAt: "2026-01-01T00:00:00.000Z" },
  ];

  const skip = 1;
  const limit = 2;
  const page = mergeByRelevance([...posts, ...replies], skip + limit + 1).slice(skip);

  // Global order is p1, r1, p2, r2 — so page two of size two starts at r1.
  assert.deepEqual(page.map((row) => row._id), ["r1", "p2", "r2"]);
});

// ── The index-not-ready window ───────────────────────────────────────────────

test("THE DEPLOY WINDOW: a missing text index is recognised, not treated as a crash", () => {
  /*
   * `background: true` means the index is unusable until the build finishes, and
   * `$text` throws in that window rather than returning nothing. Recognising it
   * is what lets relevance degrade to recency instead of 500ing for the first
   * minutes after a deploy.
   */
  assert.equal(isTextIndexUnavailable({ code: 27 }), true);
  assert.equal(isTextIndexUnavailable({ codeName: "IndexNotFound" }), true);
  assert.equal(
    isTextIndexUnavailable(new Error("text index required for $text query")),
    true
  );
});

test("and every other failure still propagates", () => {
  // A fallback that swallowed arbitrary errors would turn a broken query into a
  // silently wrong answer, which is worse than a 500.
  assert.equal(isTextIndexUnavailable(new Error("connection timed out")), false);
  assert.equal(isTextIndexUnavailable({ code: 11000 }), false);
  assert.equal(isTextIndexUnavailable(null), false);
  assert.equal(isTextIndexUnavailable(undefined), false);
});
