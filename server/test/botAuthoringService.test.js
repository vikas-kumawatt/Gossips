import assert from "node:assert";
import test, { beforeEach, mock } from "node:test";
import mongoose from "mongoose";

/**
 * Authoring, asserted by the operations it performs.
 *
 * The expectations are read off `createPost` and `replyOnPost` as they were before the
 * extraction. Two of them are invariants that a second implementation would plausibly lose,
 * and both have a named test below: the quote snapshot, and the fact that publish effects are
 * withheld from a scheduled item.
 *
 * Requires `--experimental-test-module-mocks`.
 */

const oid = () => new mongoose.Types.ObjectId();

let calls = [];
const names = () => calls.map((c) => c.name);
const callTo = (name) => calls.find((c) => c.name === name);
const push = (name, args = []) => calls.push({ name, args });

const query = (result) => {
  const chain = {
    select: () => chain,
    lean: () => Promise.resolve(result),
    then: (r) => Promise.resolve(result).then(r),
  };
  return chain;
};

const ACTOR = oid();
const POST = oid();
const PARENT = oid();
const QUOTED = oid();

let state = {};
const resetState = () => {
  state = {
    post: { _id: POST, author: oid(), whoCanReply: "everyone", mentions: [] },
    comment: { _id: PARENT, author: oid(), whoCanReply: "everyone", mentions: [], parent: null },
    canReply: true,
    snapshot: { content: "the original text", versionAt: new Date("2026-01-01") },
  };
};

mock.module("../models/Post.js", {
  defaultExport: {
    findOne: (filter) => {
      push("Post.findOne", [filter]);
      return query(state.post);
    },
    findById: (id) => {
      push("Post.findById", [id]);
      return query(state.post);
    },
    create: (doc) => {
      push("Post.create", [doc]);
      return Promise.resolve({ ...doc, _id: oid() });
    },
  },
});

mock.module("../models/Comment.js", {
  defaultExport: {
    findOne: (filter) => {
      push("Comment.findOne", [filter]);
      return query(state.comment);
    },
    findById: (id) => {
      push("Comment.findById", [id]);
      return query(state.comment);
    },
    create: (doc) => {
      push("Comment.create", [doc]);
      return Promise.resolve({ ...doc, _id: oid() });
    },
  },
});

mock.module("../utils/contentIndex.js", {
  namedExports: {
    indexContent: async (content) => {
      push("indexContent", [content]);
      return { mentionIds: [], hashtags: [] };
    },
  },
});

mock.module("../utils/publishing.js", {
  namedExports: {
    applyPostPublishEffects: (...a) => {
      push("applyPostPublishEffects", a);
      return Promise.resolve();
    },
    applyCommentPublishEffects: (...a) => {
      push("applyCommentPublishEffects", a);
      return Promise.resolve();
    },
    captureQuotedSnapshot: (postId, commentId) => {
      push("captureQuotedSnapshot", [postId, commentId]);
      return Promise.resolve(state.snapshot);
    },
  },
});

mock.module("../utils/replyPermission.js", {
  namedExports: {
    canUserReplyToTarget: (...a) => {
      push("canUserReplyToTarget", a);
      return Promise.resolve(state.canReply);
    },
    replyDeniedMessage: (setting) => `denied:${setting}`,
    normalizeWhoCanReply: (value) => value || "everyone",
  },
});

mock.module("../utils/replyThreading.js", {
  namedExports: {
    resolveReplyThread: (target, parentId) => {
      push("resolveReplyThread", [target?._id, parentId]);
      // Two-deep flattening: anchor under the top-level comment.
      return { parent: target?.parent || parentId, replyTo: parentId };
    },
  },
});

const { createPost, commentOnPost } = await import("../services/authoring.js");

beforeEach(() => {
  calls = [];
  resetState();
});

/* ── Posts ────────────────────────────────────────────────────────────────── */

test("a plain post is indexed, created, and published", async () => {
  const result = await createPost({ actorId: ACTOR, content: "hello world" });

  assert.deepEqual(names(), ["indexContent", "captureQuotedSnapshot", "Post.create", "applyPostPublishEffects"]);
  assert.equal(result.ok, true);
  assert.equal(result.scheduled, false);
});

test("an empty post is refused before anything is written", async () => {
  const result = await createPost({ actorId: ACTOR, content: "   " });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(callTo("Post.create"), undefined);
});

test("a post that is only media, only a poll or only a quote is allowed", async () => {
  for (const over of [
    { media: [{ url: "https://x/y.jpg", type: "image" }] },
    { poll: { question: "?", options: [] } },
    { quotedPost: QUOTED },
  ]) {
    calls = [];
    resetState();
    const result = await createPost({ actorId: ACTOR, content: "", ...over });
    assert.equal(result.ok, true, `${Object.keys(over)[0]} alone must be postable`);
  }
});

test("THE POINT: a quote always captures a snapshot of what it quoted", async () => {
  /*
   * A quote renders its target from this snapshot, so an author cannot edit their post later
   * and silently rewrite what a quoter appears to be responding to. This is the invariant most
   * likely to be dropped by a second implementation, because a quote looks correct without it
   * right up until someone edits a quoted post.
   */
  const result = await createPost({ actorId: ACTOR, content: "look at this", quotedPost: QUOTED });

  assert.deepEqual(callTo("captureQuotedSnapshot").args, [QUOTED, null]);
  const created = callTo("Post.create").args[0];
  assert.deepEqual(created.quotedSnapshot, state.snapshot);
  assert.equal(String(created.quotedPost), String(QUOTED));
  assert.equal(result.ok, true);
});

test("a quote target's reply audience is enforced, and refuses before writing", async () => {
  /*
   * A quote *is* a response: someone who restricted replies to people they follow has not
   * consented to being quoted into a stranger's feed either.
   */
  state.canReply = false;

  const result = await createPost({ actorId: ACTOR, content: "hmm", quotedPost: QUOTED });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /^denied:/);
  assert.equal(callTo("Post.create"), undefined);
  assert.equal(callTo("captureQuotedSnapshot"), undefined, "refused before the snapshot");
});

test("a missing or deleted quote target is a 404", async () => {
  state.post = null;
  const result = await createPost({ actorId: ACTOR, content: "x", quotedPost: QUOTED });
  assert.equal(result.status, 404);

  // The lookup must exclude deleted posts rather than filtering afterwards.
  assert.deepEqual(callTo("Post.findOne").args[0], { _id: QUOTED, isDeleted: { $ne: true } });
});

test("an unparseable quote id is refused without a query", async () => {
  const result = await createPost({ actorId: ACTOR, content: "x", quotedPost: "nope" });
  assert.equal(result.status, 404);
  assert.equal(callTo("Post.findOne"), undefined);
});

test("quoting a comment goes through the comment collection and its own gate", async () => {
  const result = await createPost({ actorId: ACTOR, content: "re:", quotedComment: PARENT });

  assert.deepEqual(callTo("Comment.findOne").args[0], { _id: PARENT, isDeleted: { $ne: true } });
  assert.ok(callTo("canUserReplyToTarget"));
  assert.deepEqual(callTo("captureQuotedSnapshot").args, [null, PARENT]);
  assert.equal(result.ok, true);
});

test("THE POINT: a scheduled post is created but NOT published", async () => {
  /*
   * Publish effects bump counters, update hashtag stats and notify mentioned people. Running
   * them at create time for a scheduled post would notify someone about something they can't
   * see yet — the publisher applies them when it runs the item.
   */
  const when = new Date(Date.now() + 3600_000);

  const result = await createPost({ actorId: ACTOR, content: "later", scheduledFor: when });

  const created = callTo("Post.create").args[0];
  assert.equal(created.isScheduled, true);
  assert.equal(created.scheduledFor, when);
  assert.equal(created.scheduleStatus, "pending");
  assert.equal(callTo("applyPostPublishEffects"), undefined, "must not publish early");
  assert.equal(result.scheduled, true);
});

test("an unscheduled post carries the null scheduling fields, not undefined", async () => {
  await createPost({ actorId: ACTOR, content: "now" });
  const created = callTo("Post.create").args[0];
  assert.equal(created.isScheduled, false);
  assert.equal(created.scheduledFor, null);
  assert.equal(created.scheduleStatus, null);
});

test("the AI flag is coerced to a boolean, not passed through", async () => {
  // The HTTP path receives form-encoded "true"; the service must not store a string.
  for (const input of ["true", 1, true]) {
    calls = [];
    resetState();
    await createPost({ actorId: ACTOR, content: "x", isAiGenerated: input });
    assert.strictEqual(callTo("Post.create").args[0].isAiGenerated, true);
  }
  calls = [];
  resetState();
  await createPost({ actorId: ACTOR, content: "x" });
  assert.strictEqual(callTo("Post.create").args[0].isAiGenerated, false);
});

/* ── Comments ─────────────────────────────────────────────────────────────── */

test("a top-level comment checks the post's audience, then publishes", async () => {
  const result = await commentOnPost({ actorId: ACTOR, postId: POST, content: "nice" });

  assert.deepEqual(names(), [
    "Post.findById",
    "canUserReplyToTarget",
    "indexContent",
    "Comment.create",
    "applyCommentPublishEffects",
  ]);
  assert.equal(result.ok, true);

  const created = callTo("Comment.create").args[0];
  assert.equal(created.parent, null, "a top-level comment has no parent");
  assert.equal(created.replyTo, null);
});

test("a nested reply checks the PARENT COMMENT's audience, not the post's", async () => {
  // Replying to a comment is governed by that comment's setting; using the post's would let
  // someone bypass a stricter thread.
  const result = await commentOnPost({
    actorId: ACTOR,
    postId: POST,
    parentId: PARENT,
    content: "agreed",
  });

  assert.ok(callTo("Comment.findById"), "the parent comment is fetched");
  assert.equal(callTo("Post.findById"), undefined, "the post is not the gate here");
  assert.ok(callTo("resolveReplyThread"));
  assert.equal(result.ok, true);
});

test("THE POINT: thread depth comes from the fetched target, not the caller's id", async () => {
  /*
   * `resolveReplyThread` is given the *fetched* comment. That is what keeps a thread two deep
   * and stops a caller anchoring a reply under an arbitrary comment by passing its id.
   */
  const grandparent = oid();
  state.comment = { _id: PARENT, author: oid(), whoCanReply: "everyone", parent: grandparent };

  await commentOnPost({ actorId: ACTOR, postId: POST, parentId: PARENT, content: "deep" });

  const [targetId, parentArg] = callTo("resolveReplyThread").args;
  assert.equal(String(targetId), String(PARENT), "the fetched target is passed");
  assert.equal(parentArg, PARENT);

  const created = callTo("Comment.create").args[0];
  assert.equal(String(created.parent), String(grandparent), "anchored at the top level");
  assert.equal(String(created.replyTo), String(PARENT), "remembers what was answered");
});

test("a missing parent comment is a 404", async () => {
  state.comment = null;
  const result = await commentOnPost({
    actorId: ACTOR,
    postId: POST,
    parentId: PARENT,
    content: "x",
  });
  assert.equal(result.status, 404);
  assert.equal(callTo("Comment.create"), undefined);
});

test("a refused audience returns 403 with the setting's own message", async () => {
  state.canReply = false;
  const result = await commentOnPost({ actorId: ACTOR, postId: POST, content: "x" });

  assert.equal(result.status, 403);
  assert.equal(result.error, "denied:everyone");
  assert.equal(callTo("Comment.create"), undefined);
});

test("an empty comment is refused, but media, a poll or a location alone is enough", async () => {
  assert.equal((await commentOnPost({ actorId: ACTOR, postId: POST, content: " " })).status, 400);

  for (const over of [
    { media: [{ url: "https://x/y.gif", type: "gif" }] },
    { poll: { question: "?" } },
    { location: { name: "here" } },
  ]) {
    calls = [];
    resetState();
    const result = await commentOnPost({ actorId: ACTOR, postId: POST, content: "", ...over });
    assert.equal(result.ok, true, `${Object.keys(over)[0]} alone must be allowed`);
  }
});

test("a missing or malformed post id is refused before any query", async () => {
  for (const bad of [null, undefined, "", "not-an-id"]) {
    calls = [];
    resetState();
    const result = await commentOnPost({ actorId: ACTOR, postId: bad, content: "x" });
    assert.equal(result.status, 400);
    assert.deepEqual(names(), [], "no query for a bad id");
  }
});

test("a scheduled comment is created but not published either", async () => {
  const when = new Date(Date.now() + 3600_000);
  const result = await commentOnPost({
    actorId: ACTOR,
    postId: POST,
    content: "later",
    scheduledFor: when,
  });

  assert.equal(callTo("Comment.create").args[0].scheduleStatus, "pending");
  assert.equal(callTo("applyCommentPublishEffects"), undefined);
  assert.equal(result.scheduled, true);
});

test("every refusal carries a status and a reason the audit log can record", async () => {
  const refusals = [];
  refusals.push(await commentOnPost({ actorId: ACTOR, postId: null, content: "x" }));
  refusals.push(await createPost({ actorId: ACTOR, content: "" }));

  resetState();
  state.canReply = false;
  refusals.push(await commentOnPost({ actorId: ACTOR, postId: POST, content: "x" }));

  for (const refusal of refusals) {
    assert.equal(refusal.ok, false);
    assert.equal(typeof refusal.status, "number");
    assert.ok(refusal.error?.length > 3);
  }
});
