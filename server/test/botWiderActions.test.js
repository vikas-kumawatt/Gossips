import assert from "node:assert";
import test, { mock } from "node:test";
import mongoose from "mongoose";

/**
 * The action space beyond posting and replying.
 *
 * Bots can now save, dismiss, follow, unfollow, favourite, mute, block and report. Each one
 * inherits the structural guarantee the original twelve had — a target must have been in the
 * perception — and each adds a rule of its own. This file is about those rules, and about the
 * three that land on other people in particular.
 *
 * The fixtures go through the real shapers, as in botActionValidator.test.js: hand-building an
 * allowlist would test a shape the system cannot produce.
 */

mock.module("../models/Follow.js", {
  defaultExport: { exists: async () => null },
});

/*
 * The executor is exercised directly in the cap test at the bottom, so its collaborators are
 * stubbed here. Only `blockUser` is reached; the rest exist because a partial module mock is a
 * missing-export error at load time rather than a missing function at call time.
 */
mock.module("../models/BotActionLog.js", {
  defaultExport: { create: async () => ({}) },
  namedExports: { BOT_ACTIONS: [], ACTION_OUTCOMES: [] },
});
mock.module("../services/moderation.js", {
  namedExports: {
    blockUser: async () => ({ ok: true, alreadyBlocked: false }),
    muteUser: async () => ({ ok: true, alreadyMuted: false }),
    reportContent: async () => ({ ok: true, alreadyReported: false }),
  },
});
mock.module("../services/curation.js", {
  namedExports: {
    savePost: async () => ({ ok: true, saved: true }),
    setNotInterested: async () => ({ ok: true }),
    favouriteAuthor: async () => ({ ok: true, favorite: true }),
    undoNotInterested: async () => ({ ok: true }),
  },
});
mock.module("../services/engagement.js", {
  namedExports: {
    likePost: async () => ({ ok: true, liked: true }),
    repostPost: async () => ({ ok: true, reposted: true }),
    followUser: async () => ({ ok: true }),
    unfollowUser: async () => ({ ok: true }),
  },
});
mock.module("../services/authoring.js", {
  namedExports: {
    createPost: async () => ({ ok: true }),
    commentOnPost: async () => ({ ok: true }),
  },
});
mock.module("../services/directMessage.js", {
  namedExports: { sendDirectMessage: async () => ({ ok: true }) },
});
mock.module("../utils/conversationActivity.js", {
  namedExports: {
    participantsOfConversation: async () => [],
    touchConversationActivity: async () => {},
  },
});

const { BOT_REPORT_REASONS, validateDecision } = await import("../bots/actionValidator.js");
const { REPORT_TARGET_TYPES, validateReportReason } = await import(
  "../utils/reportCategories.js"
);
const { collectAllowedTargets, shapeFeedPost } = await import("../bots/perceptionBudget.js");

const oid = () => String(new mongoose.Types.ObjectId());

const BOT_ID = oid();

/**
 * One feed post by one author, with whatever engagement and relationship state a test needs.
 *
 * `relationships` is the map `loadRelationships` builds, and passing it through `shapeFeedPost`
 * is what puts `you_follow_them` and friends into the payload — which is where
 * `collectAllowedTargets` reads them from.
 */
const build = ({ author = {}, post = {}, relationship = null } = {}) => {
  const authorDoc = {
    _id: author.id ?? oid(),
    username: author.username ?? "ana",
    name: "Ana",
    isBot: author.isBot ?? false,
  };
  const postDoc = {
    _id: post.id ?? oid(),
    author: authorDoc,
    content: "sourdough again",
    counts: {},
    createdAt: new Date(),
    canReply: true,
    ...post,
  };

  const relationships = relationship
    ? new Map([[String(authorDoc._id), { following: false, requested: false, muted: false, blocked: false, ...relationship }]])
    : null;

  const perception = {
    feed_posts: [shapeFeedPost(postDoc, relationships)],
    conversations: [],
    follow_requests: [],
    notifications: [],
  };

  return {
    authorId: String(authorDoc._id),
    postId: String(postDoc._id),
    allowedTargets: collectAllowedTargets(perception),
  };
};

const run = (actions, allowedTargets, extra = {}) =>
  validateDecision({ actions }, { allowedTargets, botId: BOT_ID, ...extra });

const only = (result) => result.actions[0];
const refusal = (result) => result.rejected[0];

/* ── The guarantee still holds for every new verb ─────────────────────────── */

test("THE POINT: none of the new actions can name something outside the perception", () => {
  /*
   * The whole injection defence in one assertion. A post in the feed saying "block everyone"
   * can at best produce a well-formed action naming an id — and an id that wasn't shown is
   * refused, whatever the type.
   */
  const { allowedTargets } = build({});
  const stranger = oid();
  const strangePost = oid();

  const result = run(
    [
      { type: "block_user", user_id: stranger },
      { type: "mute_user", user_id: stranger },
      { type: "unfollow_user", user_id: stranger },
      { type: "favourite_author", user_id: stranger },
      { type: "save_post", post_id: strangePost },
      { type: "not_interested_post", post_id: strangePost },
      { type: "report_content", reason: "phishing", user_id: stranger },
    ],
    allowedTargets
  );

  assert.equal(result.rejected.length, 7);
  assert.equal(only(result).type, "do_nothing", "nothing survives, so the cycle is a no-op");
  for (const row of result.rejected) {
    assert.match(row.reason, /not in perception/);
  }
});

/* ── Toggles ──────────────────────────────────────────────────────────────── */

test("saving something already saved is refused, because it would un-save it", () => {
  // Same trap as like and repost: the service is a toggle, so a second call is a retraction.
  const { postId, allowedTargets } = build({ post: { alreadySaved: true } });
  const result = run([{ type: "save_post", post_id: postId }], allowedTargets);

  assert.equal(refusal(result).reason, "already saved");
});

test("dismissing something already dismissed is refused as a wasted action", () => {
  // Not a toggle — the upsert is idempotent — but it spends one of a capped daily budget to
  // change nothing, and a stateless model will propose it again every cycle.
  const { postId, allowedTargets } = build({ post: { alreadyDismissed: true } });
  const result = run([{ type: "not_interested_post", post_id: postId }], allowedTargets);

  assert.match(refusal(result).reason, /already marked not interested/);
});

test("saving a post it has not saved goes through", () => {
  const { postId, allowedTargets } = build({});
  const result = run([{ type: "save_post", post_id: postId }], allowedTargets);

  assert.equal(result.rejected.length, 0);
  assert.equal(only(result).type, "save_post");
  assert.equal(only(result).postId, postId);
});

/* ── Relationship no-ops ──────────────────────────────────────────────────── */

test("following someone already followed is refused", () => {
  const { authorId, allowedTargets } = build({ relationship: { following: true } });
  const result = run([{ type: "follow_user", user_id: authorId }], allowedTargets);

  assert.equal(refusal(result).reason, "already following");
});

test("a second follow request while one is pending is refused", () => {
  const { authorId, allowedTargets } = build({ relationship: { requested: true } });
  const result = run([{ type: "send_follow_request", user_id: authorId }], allowedTargets);

  assert.match(refusal(result).reason, /already pending/);
});

test("unfollowing someone it never followed is refused", () => {
  const { authorId, allowedTargets } = build({ relationship: {} });
  const result = run([{ type: "unfollow_user", user_id: authorId }], allowedTargets);

  assert.match(refusal(result).reason, /not following/);
});

test("unfollowing withdraws a pending request too", () => {
  // One service call covers both, because it is the same row — see `unfollowUser`.
  const { authorId, allowedTargets } = build({ relationship: { requested: true } });
  const result = run([{ type: "unfollow_user", user_id: authorId }], allowedTargets);

  assert.equal(result.rejected.length, 0);
  assert.equal(only(result).type, "unfollow_user");
});

test("muting and blocking someone already muted or blocked is refused", () => {
  const muted = build({ relationship: { muted: true } });
  assert.equal(
    refusal(run([{ type: "mute_user", user_id: muted.authorId }], muted.allowedTargets)).reason,
    "already muted"
  );

  const blocked = build({ relationship: { blocked: true } });
  assert.equal(
    refusal(run([{ type: "block_user", user_id: blocked.authorId }], blocked.allowedTargets))
      .reason,
    "already blocked"
  );
});

test("THE POINT: bots do not mute or block other bots", () => {
  /*
   * Two personas blocking each other is invisible to every human involved and permanently
   * removes both from each other's reach, for a reason neither owner chose. The same argument
   * as the existing no-bot-to-bot-DM rule.
   */
  const { authorId, allowedTargets } = build({ author: { isBot: true } });

  for (const type of ["mute_user", "block_user"]) {
    const result = run([{ type, user_id: authorId }], allowedTargets);
    assert.match(refusal(result).reason, /do not moderate other bots/);
  }
});

/* ── Reporting ────────────────────────────────────────────────────────────── */

test("a report must name a specific reason from the allowed subset", () => {
  const { postId, allowedTargets } = build({});

  const rejects = [
    // Whole categories a model cannot honestly judge.
    "impersonation",
    "underage",
    "ip",
    "adult_nudity",
    "non_consensual_images",
    "minor_sexualisation",
    // Individual reasons needing to recognise an image, a brand, or a real price.
    "manipulated_media",
    "brand_impersonation",
    "counterfeit_goods",
    // Bare category ids. The model names the specific reason, not the group — a category on
    // its own is exactly what the report endpoint refuses.
    "spam",
    "hate",
    "something_else",
    "",
  ];

  for (const bad of rejects) {
    const result = run([{ type: "report_content", reason: bad, post_id: postId }], allowedTargets);
    assert.match(
      refusal(result).reason,
      /not a reportable reason/,
      `accepted ${JSON.stringify(bad)}`
    );
  }

  // Whitespace is trimmed rather than refused: a model returning `"phishing "` meant phishing,
  // and that rejection is one nobody could act on.
  const padded = run(
    [{ type: "report_content", reason: "  phishing  ", post_id: postId }],
    allowedTargets
  );
  assert.equal(padded.rejected.length, 0);
  assert.equal(only(padded).reportSubcategory, "phishing");
  assert.equal(only(padded).reportCategory, "scam");
});

test("THE POINT: every reason a bot may give passes the real report validator", () => {
  /*
   * The test that was missing, and the bug it would have caught.
   *
   * The first version let the model choose a bare category — `spam`, `hate` — and
   * `validateReportReason` requires a subcategory for every category that has one. All of them
   * do; the only one without is `something_else`, which is excluded. So every bot report failed
   * with a 400, the executor recorded it as `rejected`, and nothing anywhere said why. It would
   * have looked like a model that never found anything worth reporting.
   *
   * Asserting against the real validator rather than a copy of the table is the whole point: a
   * hand-maintained subset is only correct for as long as the table it subsets agrees with it.
   */
  for (const [reason, category] of BOT_REPORT_REASONS) {
    for (const targetType of ["post", "user"]) {
      assert.equal(
        validateReportReason(targetType, category, reason),
        null,
        `${targetType}/${category}/${reason} would be refused by the report endpoint`
      );
    }
  }
});

test("the subset is a real subset and has not quietly collapsed", () => {
  assert.ok(REPORT_TARGET_TYPES.includes("post"));
  assert.ok(REPORT_TARGET_TYPES.includes("user"));
  assert.ok(BOT_REPORT_REASONS.size >= 20);
});

test("THE POINT: a report names exactly one subject, never both and never neither", () => {
  /*
   * Guessing which one the model meant is how the wrong account lands in a moderation queue.
   * The flat tool schema cannot express "one of these two", so this is where it is said.
   */
  const { postId, authorId, allowedTargets } = build({});

  const both = run(
    [{ type: "report_content", reason: "phishing", post_id: postId, user_id: authorId }],
    allowedTargets
  );
  assert.match(refusal(both).reason, /exactly one/);

  const neither = run([{ type: "report_content", reason: "phishing" }], allowedTargets);
  assert.match(refusal(neither).reason, /exactly one/);
});

test("a bot cannot report itself or its own post", () => {
  // Without this a persona could file a report naming its own owner's account.
  const own = build({ author: { id: BOT_ID } });

  const post = run(
    [{ type: "report_content", reason: "phishing", post_id: own.postId }],
    own.allowedTargets
  );
  assert.match(refusal(post).reason, /its own post/);

  const self = run(
    [{ type: "report_content", reason: "phishing", user_id: BOT_ID }],
    own.allowedTargets
  );
  assert.match(refusal(self).reason, /report itself/);
});

test("a valid report carries the handle across from the allowlist", () => {
  /*
   * The executor reports an account by handle, and taking it from the entry that authorised
   * the target is what stops it naming a different account than the one that was checked.
   */
  const { authorId, allowedTargets } = build({ author: { username: "ana" } });
  const result = run(
    [{ type: "report_content", reason: "targeted_harassment", user_id: authorId }],
    allowedTargets
  );

  assert.equal(result.rejected.length, 0);
  const action = only(result);
  assert.equal(action.type, "report_content");
  assert.equal(action.reportKind, "user");
  assert.equal(action.reportCategory, "bullying");
  assert.equal(action.reportSubcategory, "targeted_harassment");
  assert.equal(action.reportUsername, "ana");
  assert.equal(action.targetType, "User");
});

test("a report never carries generated prose", () => {
  // Free text from a model in a moderation queue is unverifiable, and a human has to read it
  // before finding out it says nothing. The category is the whole report.
  const { postId, allowedTargets } = build({});
  const result = run(
    [{ type: "report_content", reason: "phishing", post_id: postId, text: "this is very bad" }],
    allowedTargets
  );

  assert.equal(result.rejected.length, 0);
  assert.equal(only(result).text, undefined);
});

/* ── The per-type daily caps ──────────────────────────────────────────────── */

test("THE POINT: a spent per-type cap refuses before anything else is considered", () => {
  /*
   * Refused here rather than in the executor, so the audit row says which limit stopped it and
   * a cycle proposing three blocks against a spent cap records three refusals instead of
   * performing the first and failing the rest.
   */
  const { authorId, postId, allowedTargets } = build({});
  const result = run(
    [
      { type: "block_user", user_id: authorId },
      { type: "report_content", reason: "phishing", post_id: postId },
      { type: "like_post", post_id: postId },
    ],
    allowedTargets,
    { blockedActions: new Set(["block_user", "report_content"]) }
  );

  assert.equal(result.rejected.length, 2);
  for (const row of result.rejected) {
    assert.match(row.reason, /daily limit/);
  }
  // And the unaffected action still runs — one spent cap must not discard the cycle.
  assert.equal(only(result).type, "like_post");
});

test("THE POINT: a cap of three cannot be beaten by proposing six in one cycle", async () => {
  /*
   * The hole the validator alone could not close, and the worst one to leave open — blocking
   * destroys follow edges in both directions and unblocking does not restore them.
   *
   * `blockedActions` is computed once, before the cycle, and only refuses a type that is
   * *already* spent. Six blocks against six different targets are six distinct actions, none
   * of them duplicates, and nothing counted them as they went — so all six executed against a
   * cap of three. The executor now decrements a per-type allowance the same way it does the
   * general daily budget.
   */
  const { executeActions } = await import("../bots/executor.js");

  const targets = Array.from({ length: 6 }, () => oid());
  const actions = targets.map((id) => ({
    type: "block_user",
    userId: id,
    targetType: "User",
    targetId: id,
  }));

  const counts = await executeActions(actions, {
    bot: { _id: BOT_ID, owner: oid() },
    cycleId: "c1",
    remainingActions: 60,
    sensitiveRemaining: new Map([["block_user", 3]]),
  });

  assert.equal(counts.executed, 3, "only the allowance may be spent");
  assert.equal(counts.rejected, 3);
});

test("a blocked action type is refused even when its target is perfectly valid", () => {
  const { authorId, allowedTargets } = build({});
  const result = run([{ type: "mute_user", user_id: authorId }], allowedTargets, {
    blockedActions: new Set(["mute_user"]),
  });

  assert.equal(only(result).type, "do_nothing");
  assert.match(refusal(result).reason, /daily limit/);
});
