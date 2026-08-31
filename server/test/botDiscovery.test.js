import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * The discovery fallback: what a bot may see when it follows nobody.
 *
 * `buildPerception` normally reads "posts by accounts I follow", which for a bot with an
 * empty follow graph is permanently empty — and nothing in the cycle could fix it, because
 * `follow_user` may only name an account drawn from the perception. The fallback is the way
 * out, and it is the one query in this file that reaches accounts the bot has no
 * relationship with, so what it excludes is the part worth pinning down.
 *
 * The models are mocked rather than a database stood up, matching botRunner.test.js: what is
 * under test is which filters are applied and in which order, not whether Mongo works.
 */

const oid = () => String(new mongoose.Types.ObjectId());

const BOT_ID = oid();
const FOLLOWED_ID = oid();
const STRANGER_ID = oid();

/** Every query the code issued, so a test can assert on the filters themselves. */
let postQueries = [];
let userQueries = [];

let followEdges = [];
let postsByQuery = () => [];
let eligibleUsers = [];
let blockedIds = new Set();

const chain = (value) => {
  const self = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    populate: () => self,
    lean: async () => value,
    then: (resolve) => Promise.resolve(value).then(resolve),
  };
  return self;
};

mock.module("../models/Post.js", {
  defaultExport: {
    find: (query) => {
      postQueries.push(query);
      return chain(postsByQuery(query));
    },
    /*
     * The discovery sweep is an aggregation, not a `find` — it uses `$sample` so that every
     * bot gets a different slice of the eligible pool rather than the platform's newest N.
     * Recorded into the same `postQueries` list, keyed by its `$match`, so the assertions
     * below can treat both shapes the same way.
     */
    aggregate: async (pipeline) => {
      const match = pipeline.find((stage) => stage.$match)?.$match ?? {};
      postQueries.push(match);
      return postsByQuery(match);
    },
  },
});

mock.module("../models/User.js", {
  defaultExport: {
    find: (query) => {
      userQueries.push(query);
      return chain(eligibleUsers);
    },
    findOne: () => chain(null),
  },
});

mock.module("../models/Follow.js", {
  defaultExport: { find: () => chain(followEdges) },
});

mock.module("../models/Like.js", { defaultExport: { find: () => chain([]) } });
mock.module("../models/Repost.js", { defaultExport: { find: () => chain([]) } });
/*
 * Read per feed slice for `already_commented`. Mocked rather than left real because the real
 * model imports its schemas from `Post.js`, which is mocked above — so an unmocked Comment
 * would fail to load rather than fail a test.
 */
let ownComments = [];
mock.module("../models/Comment.js", { defaultExport: { find: () => chain(ownComments) } });
mock.module("../models/Notification.js", {
  defaultExport: { find: () => chain([]), countDocuments: async () => 0 },
});
mock.module("../models/Message.js", {
  defaultExport: { find: () => chain([]), countDocuments: async () => 0 },
});
mock.module("../models/ConversationRead.js", {
  defaultExport: { find: () => chain([]) },
});

/** Mutes and dismissals: empty by default, so the feed sees everything it is entitled to. */
let mutedRelations = [];
let dismissedPosts = [];

mock.module("../models/UserRelation.js", {
  defaultExport: { find: () => chain(mutedRelations) },
});
mock.module("../models/Saved.js", { defaultExport: { find: () => chain([]) } });
mock.module("../models/NotInterested.js", {
  defaultExport: { find: () => chain(dismissedPosts) },
});

mock.module("../utils/chatAccess.js", {
  namedExports: {
    ACTIVE_ACCOUNT: { accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] } },
    blockedIdSet: async () => blockedIds,
    audienceAllows: async () => true,
    privacyOf: async () => ({ readReceipts: true, whoCanSeeOnlineStatus: "everyone" }),
    invalidatePrivacy: () => {},
  },
});
mock.module("../utils/conversationActivity.js", {
  namedExports: { participantsOfConversation: async () => [] },
});
mock.module("../utils/replyPermission.js", {
  namedExports: { canUserReplyToTarget: async () => true },
});

const { buildPerception } = await import("../bots/perception.js");

const postBy = (authorId) => ({
  _id: oid(),
  author: { _id: authorId, username: "someone", name: "Someone", isBot: false },
  content: "a post worth reacting to",
  counts: {},
  createdAt: new Date(Date.now() - 10 * 60 * 1000),
});

const reset = () => {
  postQueries = [];
  userQueries = [];
  followEdges = [];
  postsByQuery = () => [];
  eligibleUsers = [];
  blockedIds = new Set();
  mutedRelations = [];
  dismissedPosts = [];
  ownComments = [];
};

/** True when the query is the discovery author sweep rather than a feed read. */
const isDiscoverySweep = (query) => Boolean(query?.author?.$nin);

test("a bot that follows nobody still finds posts to react to", async () => {
  /*
   * THE POINT. This is the reported bug: an owner watching a platform full of posts, and an
   * activity log saying "nothing to react to" every cycle. The feed was empty because it only
   * ever looked at accounts the bot followed, and the bot followed nobody.
   */
  reset();
  followEdges = [];
  postsByQuery = (query) =>
    isDiscoverySweep(query) ? [{ author: STRANGER_ID }] : [postBy(STRANGER_ID)];
  eligibleUsers = [{ _id: STRANGER_ID }];

  const { perception, allowedTargets } = await buildPerception({ _id: BOT_ID });

  assert.equal(perception.feed_posts.length, 1, "an empty follow graph must not mean an empty feed");
  assert.equal(perception.feed_includes_accounts_you_dont_follow, true);
  assert.equal(perception.feed_posts[0].from_discovery, true, "marked per post, not per batch");
  assert.equal(
    allowedTargets.posts.size ?? allowedTargets.posts.length,
    1,
    "a discovered post has to be a legal like/comment target, or showing it is pointless"
  );
});

test("THE POINT: public posts top up a feed the follow graph only half filled", async () => {
  /*
   * The behaviour the fallback version got wrong. A bot following three quiet accounts has a
   * feed that is technically non-empty and practically useless; under a fallback it would
   * never see anything else again. A person scrolling an app is not restricted to the people
   * they follow, and neither is a persona.
   */
  reset();
  followEdges = [{ following: FOLLOWED_ID }];
  /*
   * Keyed on the authors asked for, so the two `loadFeed` calls — the follow feed and the
   * top-up — return different posts. `loadOwnRecent` also queries `Post` and carries no
   * `$in`, hence the guard.
   */
  postsByQuery = (query) => {
    if (isDiscoverySweep(query)) return [{ author: STRANGER_ID }];
    const asked = query?.author?.$in;
    return asked?.length ? [postBy(asked[0])] : [];
  };
  eligibleUsers = [{ _id: STRANGER_ID }];

  const { perception } = await buildPerception({ _id: BOT_ID });

  assert.equal(perception.feed_posts.length, 2, "one followed post plus one discovered");
  assert.equal(
    perception.feed_posts[0].from_discovery,
    undefined,
    "the followed post comes first and is not marked"
  );
  assert.equal(perception.feed_posts[1].from_discovery, true);
});

test("the top-up doesn't re-fetch authors the follow feed already covered", async () => {
  // Otherwise the discovery slots are spent on posts the bot is being shown anyway, and a
  // bot following one prolific account would see nothing new however much room was left.
  reset();
  followEdges = [{ following: FOLLOWED_ID }];
  postsByQuery = (query) => (isDiscoverySweep(query) ? [] : [postBy(FOLLOWED_ID)]);

  await buildPerception({ _id: BOT_ID });

  const sweep = postQueries.find(isDiscoverySweep);
  assert.ok(sweep, "the sweep should still run — there was room left");
  const excluded = sweep.author.$nin.map(String);
  assert.ok(excluded.includes(String(BOT_ID)), "a bot must not discover its own posts");
  assert.ok(excluded.includes(String(FOLLOWED_ID)), "nor an author already in the feed");
});

test("a feed the follow graph filled to the cap needs no discovery at all", async () => {
  // A cheap short-circuit, and the one case where an established bot pays nothing for this.
  reset();
  followEdges = [{ following: FOLLOWED_ID }];
  postsByQuery = (query) =>
    isDiscoverySweep(query) ? [] : Array.from({ length: 12 }, () => postBy(FOLLOWED_ID));

  const { perception } = await buildPerception({ _id: BOT_ID });

  assert.equal(perception.feed_posts.length, 12);
  assert.equal(perception.feed_includes_accounts_you_dont_follow, undefined);
  assert.ok(
    !postQueries.some(isDiscoverySweep),
    "no room left, so the sweep must not run"
  );
});

test("discovery excludes private accounts and the bot itself", async () => {
  /*
   * The follow-graph query got private accounts right for free: an accepted edge to a private
   * account *is* that account's approval. Discovery has no such guarantee, so the exclusion
   * has to be explicit — this asserts on the filter rather than the result, because the result
   * would also be empty if the query were simply broken.
   */
  reset();
  followEdges = [];
  postsByQuery = (query) => (isDiscoverySweep(query) ? [{ author: STRANGER_ID }] : []);
  eligibleUsers = [];

  await buildPerception({ _id: BOT_ID });

  const sweep = postQueries.find(isDiscoverySweep);
  assert.ok(sweep, "the sweep should have run");
  assert.ok(
    sweep.author.$nin.map(String).includes(String(BOT_ID)),
    "a bot must not discover its own posts"
  );

  const filter = userQueries.at(-1);
  assert.deepEqual(filter.isPrivate, { $ne: true }, "private accounts are not discoverable");
  assert.ok(filter.accountStatus?.$nin?.includes("suspended"), "ACTIVE_ACCOUNT must be applied");
});

test("other bots are discoverable, or a bot-heavy platform leaves every bot blind", async () => {
  /*
   * This filter used to read `isBot: { $ne: true }`, to stop two bots discovering each other
   * and holding a conversation no person was part of. What it actually produced: the sweep
   * samples 120 recent posts and *then* drops the bot authors, so on a platform whose recent
   * posts are mostly bot-written the candidates collapsed to nothing. Those bots saw an empty
   * feed nearly every cycle and could only ever act on their posting quota.
   *
   * The loop is closed where it can be closed properly — no bot-to-bot DMs, no bot moderating
   * a bot, and one comment per post — rather than by making them invisible to each other.
   */
  reset();
  followEdges = [];
  postsByQuery = (query) => (isDiscoverySweep(query) ? [{ author: STRANGER_ID }] : []);
  eligibleUsers = [];

  await buildPerception({ _id: BOT_ID });

  const filter = userQueries.at(-1);
  assert.equal(filter.isBot, undefined, "a bot's posts are as discoverable as anyone else's");
});

test("discovery honours blocks in both directions", async () => {
  reset();
  followEdges = [];
  postsByQuery = (query) =>
    isDiscoverySweep(query) ? [{ author: STRANGER_ID }] : [postBy(STRANGER_ID)];
  eligibleUsers = [{ _id: STRANGER_ID }];
  blockedIds = new Set([String(STRANGER_ID)]);

  const { perception } = await buildPerception({ _id: BOT_ID });

  assert.equal(
    perception.feed_posts.length,
    0,
    "a blocked account must not become visible by being discovered"
  );
  assert.equal(perception.feed_includes_accounts_you_dont_follow, undefined);
});

test("THE POINT: a bot's own mute actually removes that account from its feed", async () => {
  /*
   * Muting was added as an action before the feed knew anything about it, which made it inert:
   * the model spends one of a capped daily budget and the same account's posts arrive next
   * cycle regardless. An action whose effect the actor cannot perceive is worse than no action
   * — a stateless model will keep proposing it forever.
   */
  reset();
  followEdges = [{ following: FOLLOWED_ID }];
  mutedRelations = [{ to: FOLLOWED_ID }];
  postsByQuery = (query) => {
    if (isDiscoverySweep(query)) return [];
    const asked = query?.author?.$in;
    return asked?.length ? [postBy(asked[0])] : [];
  };

  const { perception } = await buildPerception({ _id: BOT_ID });

  assert.equal(perception.feed_posts.length, 0, "a muted account must not reach the feed");

  // And discovery must exclude them too, or muting someone the bot doesn't follow does nothing
  // — which is most of the accounts it can now see.
  const sweep = postQueries.find(isDiscoverySweep);
  assert.ok(sweep.author.$nin.map(String).includes(String(FOLLOWED_ID)));
});

test("posts the bot dismissed do not come back", async () => {
  // Same argument as the mute above: `not_interested_post` has to change what the bot sees.
  reset();
  const dismissedId = oid();
  followEdges = [{ following: FOLLOWED_ID }];
  dismissedPosts = [{ post: dismissedId }];
  postsByQuery = () => [];

  await buildPerception({ _id: BOT_ID });

  const feedRead = postQueries.find((query) => query?.author?.$in);
  assert.ok(feedRead, "the follow feed should have been read");
  assert.deepEqual(
    feedRead._id.$nin.map(String),
    [String(dismissedId)],
    "a dismissed post must be excluded at the query, not filtered after"
  );
});

test("the discovery sweep is sampled, not the platform's newest N", async () => {
  /*
   * `sort({createdAt:-1}).limit(120)` gives every bot the same 120 posts, which means anyone
   * can guarantee placement in every bot's perception by posting 120 times in a burst. The
   * whole design rests on a bot only acting on what it was shown; letting an outsider choose
   * what that is attacks it from the other end.
   */
  reset();
  followEdges = [];
  let pipeline = null;
  postsByQuery = () => [];

  const Post = (await import("../models/Post.js")).default;
  const realAggregate = Post.aggregate;
  Post.aggregate = async (stages) => {
    pipeline = stages;
    return realAggregate(stages);
  };

  await buildPerception({ _id: BOT_ID });
  Post.aggregate = realAggregate;

  assert.ok(pipeline, "discovery should have run");
  assert.ok(
    pipeline.some((stage) => stage.$sample),
    "the sweep must sample rather than take the newest"
  );
  assert.ok(
    !pipeline.some((stage) => stage.$sort),
    "a sort would make the sample deterministic again"
  );
});

test("no recent posts anywhere leaves the feed empty rather than throwing", async () => {
  // The genuinely idle case, which is what the runner's do_nothing branch is now for.
  reset();
  followEdges = [];
  postsByQuery = () => [];

  const { perception } = await buildPerception({ _id: BOT_ID });

  assert.equal(perception.feed_posts.length, 0);
  assert.equal(perception.feed_includes_accounts_you_dont_follow, undefined);
});
