import assert from "node:assert";
import test, { beforeEach, mock } from "node:test";
import mongoose from "mongoose";

/**
 * Does the extracted service do exactly what the controller did?
 *
 * That is the only question this phase has to answer, and syntax checks can't answer it. So
 * every model, notifier, cache and socket the service touches is replaced with a recorder,
 * and the test asserts the *sequence* of operations — which writes, in which order, with
 * which arguments, and which notifications and emits fall out of them.
 *
 * The expectations below were read off the original controller bodies before extraction, not
 * off the new service. A test written from the new code would pass by construction and prove
 * nothing.
 *
 * Requires `--experimental-test-module-mocks`; see the `test:services` npm script.
 */

const oid = () => new mongoose.Types.ObjectId();

/** Every operation, in order, as `"Collection.method"` plus its arguments. */
let calls = [];
const record = (name) => (...args) => {
  calls.push({ name, args });
  return undefined;
};
const names = () => calls.map((c) => c.name);
const callTo = (name) => calls.find((c) => c.name === name);

/*
 * A stand-in for a Mongoose query chain: `.select().lean()` resolves to whatever the test
 * queued. Chainable because the service calls it that way and a plain promise would break on
 * `.select`.
 */
const query = (result, label) => {
  const chain = {
    select: () => chain,
    lean: () => Promise.resolve(result),
    then: (resolve) => Promise.resolve(result).then(resolve),
  };
  if (label) calls.push({ name: label, args: [] });
  return chain;
};

const ACTOR = oid();
const AUTHOR = oid();
const POST = oid();
const TARGET = oid();

/** What each mocked collection should answer. Reassigned per test. */
let state = {};

const resetState = () => {
  state = {
    post: { _id: POST, author: AUTHOR, counts: { likes: 4, reposts: 2 }, isDeleted: false },
    existingLike: null,
    existingRepost: null,
    existingFollow: null,
    targetUser: { _id: TARGET, username: "target", isPrivate: false },
    actorUser: { username: "actor" },
    blocks: false,
  };
};

mock.module("../models/Post.js", {
  defaultExport: {
    findById: (...a) => {
      calls.push({ name: "Post.findById", args: a });
      return query(state.post);
    },
    updateOne: (...a) => {
      calls.push({ name: "Post.updateOne", args: a });
      return Promise.resolve({ modifiedCount: 1 });
    },
  },
});

mock.module("../models/Like.js", {
  defaultExport: {
    findOne: (...a) => {
      calls.push({ name: "Like.findOne", args: a });
      return Promise.resolve(state.existingLike);
    },
    create: (...a) => {
      calls.push({ name: "Like.create", args: a });
      return Promise.resolve({ _id: oid() });
    },
    deleteOne: (...a) => {
      calls.push({ name: "Like.deleteOne", args: a });
      return Promise.resolve({ deletedCount: 1 });
    },
  },
});

mock.module("../models/Repost.js", {
  defaultExport: {
    findOne: (...a) => {
      calls.push({ name: "Repost.findOne", args: a });
      return Promise.resolve(state.existingRepost);
    },
    create: (...a) => {
      calls.push({ name: "Repost.create", args: a });
      return Promise.resolve({ _id: oid() });
    },
    deleteOne: (...a) => {
      calls.push({ name: "Repost.deleteOne", args: a });
      return Promise.resolve({ deletedCount: 1 });
    },
  },
});

mock.module("../models/Follow.js", {
  defaultExport: {
    findOne: (...a) => {
      calls.push({ name: "Follow.findOne", args: a });
      return Promise.resolve(state.existingFollow);
    },
    create: (...a) => {
      calls.push({ name: "Follow.create", args: a });
      return Promise.resolve({ _id: oid() });
    },
  },
});

mock.module("../models/User.js", {
  defaultExport: {
    findById: (id) => {
      const isActor = String(id) === String(ACTOR);
      calls.push({ name: isActor ? "User.findById(actor)" : "User.findById(target)", args: [id] });
      const doc = isActor ? state.actorUser : state.targetUser;
      /*
       * `_id` is always present, because Mongoose always returns it unless it is explicitly
       * excluded — and the self-follow test depends on that. Without it, a lookup where the
       * actor *is* the target returned a document with no `_id`, the service's self-check
       * compared against `undefined`, and the test failed against correct code. A stub that
       * is less realistic than the thing it stands in for produces exactly this: a fake
       * failure that looks like a real one.
       */
      return query(doc ? { _id: id, ...doc } : null);
    },
    updateOne: (...a) => {
      calls.push({ name: "User.updateOne", args: a });
      return Promise.resolve({ modifiedCount: 1 });
    },
  },
});

mock.module("../models/UserRelation.js", {
  defaultExport: {
    eitherBlocks: (...a) => {
      calls.push({ name: "UserRelation.eitherBlocks", args: a });
      return Promise.resolve(state.blocks);
    },
  },
});

mock.module("../utils/notifications.js", {
  namedExports: {
    sendNotification: (...a) => {
      calls.push({ name: "sendNotification", args: a });
      return Promise.resolve();
    },
  },
});

mock.module("../utils/cache.js", {
  namedExports: {
    del: record("cache.del"),
    CacheKeys: { profile: (username) => `profile:${username}` },
  },
});

mock.module("../config/socket.js", {
  namedExports: {
    getIO: () => ({
      to: (room) => ({
        emit: (event, payload) => {
          calls.push({ name: `emit:${event}`, args: [room, payload] });
        },
      }),
    }),
  },
});

const { likePost, repostPost, followUser } = await import("../services/engagement.js");

beforeEach(() => {
  calls = [];
  resetState();
});

/* ── Likes ────────────────────────────────────────────────────────────────── */

test("liking a post writes the like, bumps the count, then notifies — in that order", async () => {
  const result = await likePost({ actorId: ACTOR, postId: POST });

  assert.deepEqual(names(), [
    "Post.findById",
    "Like.findOne",
    "Like.create",
    "Post.updateOne",
    "sendNotification",
    "Post.findById",
  ]);

  // The notification comes *after* the write, so a failed notify can't roll back a like.
  assert.ok(names().indexOf("Like.create") < names().indexOf("sendNotification"));

  assert.deepEqual(callTo("Like.create").args[0], {
    user: ACTOR,
    targetType: "Post",
    target: POST,
  });
  assert.deepEqual(callTo("Post.updateOne").args[1], { $inc: { "counts.likes": 1 } });
  assert.deepEqual(callTo("sendNotification").args, [
    AUTHOR,
    ACTOR,
    "like",
    { entity: POST, entityType: "Post" },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.liked, true);
});

test("liking again removes it, decrements, and does NOT notify", async () => {
  state.existingLike = { _id: oid() };

  const result = await likePost({ actorId: ACTOR, postId: POST });

  assert.deepEqual(names(), [
    "Post.findById",
    "Like.findOne",
    "Like.deleteOne",
    "Post.updateOne",
    "Post.findById",
  ]);
  assert.deepEqual(callTo("Post.updateOne").args[1], { $inc: { "counts.likes": -1 } });
  assert.equal(callTo("sendNotification"), undefined, "unliking must not notify");
  assert.equal(result.liked, false);
});

test("THE POINT: liking your own post writes the like but sends no notification", async () => {
  state.post = { ...state.post, author: ACTOR };

  await likePost({ actorId: ACTOR, postId: POST });

  assert.ok(names().includes("Like.create"));
  assert.equal(callTo("sendNotification"), undefined, "no self-notification");
});

test("a missing or deleted post is a 404 and writes nothing", async () => {
  for (const post of [null, { ...state.post, isDeleted: true }]) {
    calls = [];
    resetState();
    state.post = post;

    const result = await likePost({ actorId: ACTOR, postId: POST });

    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.ok(!names().some((n) => n.includes("create") || n.includes("updateOne")));
  }
});

test("an unparseable post id is refused before any query runs", async () => {
  const result = await likePost({ actorId: ACTOR, postId: "not-an-objectid" });
  assert.equal(result.status, 404);
  assert.deepEqual(names(), [], "no database call for a malformed id");
});

/* ── Reposts ──────────────────────────────────────────────────────────────── */

test("reposting mirrors liking, with the repost counter and notification type", async () => {
  const result = await repostPost({ actorId: ACTOR, postId: POST });

  assert.deepEqual(names(), [
    "Post.findById",
    "Repost.findOne",
    "Repost.create",
    "Post.updateOne",
    "sendNotification",
    "Post.findById",
  ]);
  assert.deepEqual(callTo("Post.updateOne").args[1], { $inc: { "counts.reposts": 1 } });
  assert.equal(callTo("sendNotification").args[2], "repost");
  assert.equal(result.reposted, true);
});

test("un-reposting decrements and stays quiet", async () => {
  state.existingRepost = { _id: oid() };

  const result = await repostPost({ actorId: ACTOR, postId: POST });

  assert.deepEqual(callTo("Post.updateOne").args[1], { $inc: { "counts.reposts": -1 } });
  assert.equal(callTo("sendNotification"), undefined);
  assert.equal(result.reposted, false);
});

/* ── Follows ──────────────────────────────────────────────────────────────── */

test("following a public account writes the edge, both counters, notifies, emits, invalidates", async () => {
  const result = await followUser({ actorId: ACTOR, targetId: TARGET });

  assert.deepEqual(names(), [
    "User.findById(actor)",
    "User.findById(target)",
    "UserRelation.eitherBlocks",
    "Follow.findOne",
    "Follow.create",
    "User.updateOne",
    "User.updateOne",
    "sendNotification",
    "emit:followStatusUpdate",
    "cache.del",
    "cache.del",
  ]);

  assert.deepEqual(callTo("Follow.create").args[0], {
    follower: ACTOR,
    following: TARGET,
    status: "accepted",
  });

  // Both sides of the count, which is the pair most easily got wrong.
  const increments = calls.filter((c) => c.name === "User.updateOne").map((c) => c.args[1]);
  assert.deepEqual(increments, [
    { $inc: { "counts.following": 1 } },
    { $inc: { "counts.followers": 1 } },
  ]);

  assert.equal(callTo("sendNotification").args[2], "follow");
  assert.deepEqual(callTo("emit:followStatusUpdate").args[1], {
    username: "target",
    action: "follow",
    isPending: false,
    isPrivate: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.pending, false);
});

test("THE POINT: a private account gets a pending request, no counters, and a different notification", async () => {
  state.targetUser = { ...state.targetUser, isPrivate: true };

  const result = await followUser({ actorId: ACTOR, targetId: TARGET });

  assert.deepEqual(callTo("Follow.create").args[0], {
    follower: ACTOR,
    following: TARGET,
    status: "pending",
  });
  // Counters must NOT move on a request — the follow hasn't happened yet.
  assert.equal(callTo("User.updateOne"), undefined, "a pending request moves no counters");
  assert.equal(callTo("sendNotification").args[2], "follow_request");
  assert.equal(callTo("emit:followStatusUpdate").args[1].isPending, true);

  assert.equal(result.pending, true);
  assert.equal(result.isPrivate, true);
});

test("a block in either direction refuses before the edge is looked up", async () => {
  state.blocks = true;

  const result = await followUser({ actorId: ACTOR, targetId: TARGET });

  assert.equal(result.status, 403);
  assert.ok(!names().includes("Follow.findOne"), "stops at the block check");
  assert.ok(!names().includes("Follow.create"));
});

test("following yourself is refused", async () => {
  state.targetUser = { _id: ACTOR, username: "actor", isPrivate: false };

  const result = await followUser({ actorId: ACTOR, targetId: ACTOR });

  assert.equal(result.status, 400);
  assert.match(result.error, /yourself/);
  assert.ok(!names().includes("Follow.create"));
});

test("an existing edge is reported, not duplicated", async () => {
  for (const [status, expected] of [
    ["accepted", /already follow/],
    ["pending", /already sent/],
  ]) {
    calls = [];
    resetState();
    state.existingFollow = { status };

    const result = await followUser({ actorId: ACTOR, targetId: TARGET });

    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, expected);
    assert.ok(!names().includes("Follow.create"), `${status} must not write again`);
  }
});

test("a missing target is a 404 before anything is written", async () => {
  state.targetUser = null;

  const result = await followUser({ actorId: ACTOR, targetId: TARGET });

  assert.equal(result.status, 404);
  assert.ok(!names().includes("Follow.create"));
  assert.ok(!names().includes("UserRelation.eitherBlocks"));
});

test("every refusal carries a status and a human-readable reason", async () => {
  /*
   * The bot layer records `error` verbatim as the rejection reason on the audit log, so a
   * refusal with no message would produce a log row that says a bot was stopped and not why.
   */
  const refusals = [];

  state.targetUser = null;
  refusals.push(await followUser({ actorId: ACTOR, targetId: TARGET }));

  resetState();
  state.post = null;
  refusals.push(await likePost({ actorId: ACTOR, postId: POST }));
  refusals.push(await repostPost({ actorId: ACTOR, postId: POST }));

  for (const refusal of refusals) {
    assert.equal(refusal.ok, false);
    assert.equal(typeof refusal.status, "number");
    assert.ok(refusal.error && refusal.error.length > 3, "must explain itself");
  }
});
