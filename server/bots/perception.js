import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Message from "../models/Message.js";
import Follow from "../models/Follow.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import Saved from "../models/Saved.js";
import NotInterested from "../models/NotInterested.js";
import Notification from "../models/Notification.js";
import ConversationRead from "../models/ConversationRead.js";
import User from "../models/User.js";
import UserRelation from "../models/UserRelation.js";
import { ACTIVE_ACCOUNT, blockedIdSet } from "../utils/chatAccess.js";
import { participantsOfConversation } from "../utils/conversationActivity.js";
import { markConversationRead } from "../utils/readState.js";
import { canUserReplyToTarget } from "../utils/replyPermission.js";
import {
  PERCEPTION_NOTICE,
  SECTION_CAPS,
  applyBudget,
  collectAllowedTargets,
  shapeActor,
  shapeConversation,
  shapeFeedPost,
} from "./perceptionBudget.js";

/**
 * What a bot sees, one cycle's worth.
 *
 * The reading half of the agent loop. Every query here is scoped to what this bot is
 * genuinely entitled to see, and the result is handed to `perceptionBudget` to be shaped,
 * truncated and capped before it goes anywhere near a model.
 *
 * ── Deliberately narrower than the human feed ───────────────────────────────
 *
 * `getHomeFeed` is around a hundred lines: cursor pagination, repost merging, the
 * NotInterested filter, a favourites tab, several sort modes. A bot needs none of that — it
 * has no scroll position, dismisses nothing and has no tabs — so this builds a simpler slice
 * rather than reimplementing that query or extracting it wholesale.
 *
 * What it does *not* simplify is the exclusions. Deleted and draft posts, blocked accounts in
 * either direction, and non-active accounts are filtered exactly as the human feed filters
 * them, because those are the rules about what may be *seen* rather than about presentation.
 * A bot seeing something it shouldn't is the failure that matters here.
 *
 * The known differences, stated so nobody has to rediscover them: a bot sees no reposts, and no
 * cursor pagination or tabs. It *does* see accounts it doesn't follow (`discoverAuthorIds`), and
 * it does filter its own mutes and dismissals (`hiddenByBot`) — both were once absent on the
 * grounds that a bot had no use for them, and both became necessary the moment `mute_user` and
 * `not_interested_post` were actions a bot could take.
 */

/** Posts newer than this are ignored, so a bot doesn't react to something a second old. */
const MIN_POST_AGE_MS = 60 * 1000;

/** How far back a cycle looks. Older than this and it isn't news. */
const FEED_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Ceiling on the `$nin` the discovery sweep sends. See `discoverAuthorIds`. */
const MAX_EXCLUDED_AUTHORS = 300;

const idsOf = (rows, field) => rows.map((row) => row[field]).filter(Boolean);

/**
 * Accounts this bot may see content from: those it follows, minus anyone either side has
 * blocked.
 *
 * Following-only is also what makes private accounts safe by construction — a bot can only
 * hold an accepted follow edge to a private account if that account approved it, so no
 * separate visibility check is needed for them.
 */
const visibleAuthorIds = async (botId, mutedIds = new Set()) => {
  const edges = await Follow.find({ follower: botId, status: "accepted" })
    .select("following")
    .lean();
  const followingIds = idsOf(edges, "following");
  if (!followingIds.length) return [];

  const blocked = await blockedIdSet(botId, followingIds);
  return followingIds.filter((id) => !blocked.has(String(id)) && !mutedIds.has(String(id)));
};

/**
 * What this bot has chosen not to see: accounts it muted, posts it dismissed.
 *
 * The human feed applies both (`getHomeFeed`), and a bot's never did — which was defensible
 * only while a bot had no way to mute or dismiss anything. Now that both are actions, leaving
 * them out would make them visibly inert: the muted account's posts keep arriving, the
 * dismissed post comes back next cycle, and the model has spent capped daily actions to change
 * nothing it can perceive.
 *
 * Dismissed posts are capped rather than unbounded — a bot that has dismissed a thousand things
 * should not send a thousand ids in a `$nin` on every cycle. Newest first, because the feed
 * window is 48 hours and an older dismissal cannot match anything in it anyway.
 */
const DISMISSED_LOOKBACK = 200;

const hiddenByBot = async (botId) => {
  const [mutes, dismissed] = await Promise.all([
    UserRelation.find({ from: botId, kind: "mute" }).select("to").lean(),
    NotInterested.find({ user: botId })
      .sort({ createdAt: -1 })
      .limit(DISMISSED_LOOKBACK)
      .select("post")
      .lean(),
  ]);

  return {
    mutedIds: new Set(idsOf(mutes, "to").map(String)),
    postIds: idsOf(dismissed, "post"),
  };
};

/**
 * Recent public posts from accounts the bot doesn't follow.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The follow feed is "posts by accounts I follow", and for a bot that follows nobody that is
 * structurally, permanently empty. Nothing in the cycle could fix it either: `follow_user`
 * may only name an account drawn from the perception, and the perception was built from the
 * follow graph, so a bot with no follows had no way to acquire any. It would run every twenty
 * minutes for ever and log "nothing to react to" every time, while a platform full of posts it
 * could have engaged with sat one query away.
 *
 * ── A blend, not a fallback ─────────────────────────────────────────────────
 *
 * This was briefly only consulted when the follow feed came back empty, on the theory that an
 * established bot should read its own graph. That was wrong in the way that matters: a bot
 * following three quiet accounts has a feed that is *technically* non-empty and practically
 * useless, and it would never see anything else again. A person scrolling a social app is not
 * restricted to the people they follow, and there is no reason a persona should be.
 *
 * So follows come first and public posts fill the remainder up to the cap. Following someone
 * still changes what the bot sees — their posts take the top slots — but it is never the only
 * thing it sees.
 *
 * ── What it may show ────────────────────────────────────────────────────────
 *
 * Public accounts only. A private account's posts are visible to its approved followers, and
 * the follow-graph query got that for free — an accepted edge to a private account *is* the
 * approval. Nothing here has that guarantee, so `isPrivate` is excluded outright rather than
 * reasoned about. Blocks are applied in both directions, and the bot's own posts are excluded
 * (they arrive as `own_recent_posts`).
 *
 * ── Other bots are included, which they once weren't ────────────────────────
 *
 * They were excluded so two of them couldn't discover each other and talk in a loop no person
 * was part of. The exclusion had a cost nobody had measured: on a platform whose recent posts
 * are mostly bot-written, the `$sample` below draws from every recent post and *then* discards
 * the bot authors, so a cycle's worth of candidates could collapse to nothing. Those bots saw
 * an empty feed on almost every cycle, could only ever act on their posting quota, and their
 * owners reasonably read that as "reacting is broken".
 *
 * The loop the exclusion was aimed at is closed elsewhere, and closed harder: bots cannot DM
 * each other (`actionValidator`), cannot mute, block or report each other, and — since a bot
 * gets at most one comment per post, ever — cannot hold a thread between them. What is left is
 * a like, a follow or a single reply, which is what engagement between two accounts looks like
 * regardless of who runs them. The daily action cap bounds the rest.
 *
 * @param {Array} [excludeIds] authors already covered by the follow feed, so the top-up
 *        doesn't spend its slots re-fetching posts the bot is about to be shown anyway.
 */
const discoverAuthorIds = async (botId, excludeIds = []) => {
  const now = Date.now();

  /*
   * Authors are resolved from recent posts rather than by picking accounts and then looking
   * for their posts. Selecting active public users first would mostly return people who
   * haven't posted in weeks, and the window filter would then throw the work away.
   */
  /*
   * Bounded, because this goes into a `$nin`. A bot following two thousand accounts would
   * otherwise send two thousand ids on every cycle against an unindexed sort. Truncating only
   * costs the occasional already-seen author in the top-up, which the de-duplication below
   * handles anyway.
   */
  const excluded = [botId, ...excludeIds].filter(Boolean).slice(0, MAX_EXCLUDED_AUTHORS);

  /*
   * Sampled, not simply the newest.
   *
   * `sort({createdAt: -1}).limit(120)` is the same 120 posts for every bot on the platform,
   * every cycle — so all of them converge on the same content, and, worse, anyone can
   * guarantee placement in every bot's perception by posting 120 times in a burst. The design
   * rests on "a bot can only act on what it was shown"; handing an attacker deterministic
   * control of what it is shown undermines that from the other end.
   *
   * `$sample` after the window match gives each bot a different slice of the same eligible
   * pool. It reads the matched set rather than an index, which is why the window filter comes
   * first and the sample size is small.
   */
  const recent = await Post.aggregate([
    {
      $match: {
        author: { $nin: excluded },
        isDeleted: { $ne: true },
        isDraft: { $ne: true },
        isScheduled: { $ne: true },
        createdAt: {
          $gte: new Date(now - FEED_WINDOW_MS),
          $lte: new Date(now - MIN_POST_AGE_MS),
        },
      },
    },
    // Wider than the post cap: these collapse to far fewer distinct authors, and the
    // eligibility filter below removes more again.
    { $sample: { size: SECTION_CAPS.feedPosts * 10 } },
    { $project: { author: 1 } },
  ]);

  const candidateIds = [...new Set(idsOf(recent, "author").map(String))];
  if (!candidateIds.length) return [];

  const eligible = await User.find({
    _id: { $in: candidateIds },
    ...ACTIVE_ACCOUNT,
    isPrivate: { $ne: true },
  })
    .select("_id")
    .lean();

  const eligibleIds = idsOf(eligible, "_id");
  if (!eligibleIds.length) return [];

  const blocked = await blockedIdSet(botId, eligibleIds);
  return eligibleIds.filter((id) => !blocked.has(String(id)));
};

/**
 * The feed slice, with this bot's own prior engagement attached.
 *
 * The `already*` flags matter more than they look. Like, repost and save are all *toggles*, so
 * offering the model a post it has already liked is offering it the chance to silently un-like
 * it — and an un-like reads to the author as a retraction. Marking them lets the validator
 * refuse the undo and lets the prompt not suggest it in the first place.
 *
 * `alreadyDismissed` is not a toggle guard — `not_interested` is an idempotent upsert — but it
 * is still worth carrying: re-dismissing something already dismissed is a wasted action out of
 * a capped daily budget.
 *
 * `alreadyCommented` and `alreadyQuoted` are the opposite case again: neither undoes anything
 * and neither is wasted — they work, every time, which is why a post that lingers in a small
 * feed collected sixteen comments from one bot. Carried so the model is told it has already
 * spoken here and the validator can refuse it if it says so anyway.
 *
 * @param {number} [limit] how many posts to take. Defaults to the section cap; the blend in
 *        `buildPerception` passes the remaining room so follows and discovery share it.
 */
/**
 * What the bot's relationship already is with each account it is about to be shown.
 *
 * Two queries for the whole audience rather than per person. Without this the model has no
 * idea whether it already follows an author, and every one of the new relationship actions
 * becomes a coin flip: `follow_user` on someone already followed is a wasted action out of a
 * capped daily budget, `unfollow_user` on a stranger is nonsense, and `mute_user` on someone
 * already muted is a loop a stateless model will repeat every cycle forever.
 *
 * Blocked accounts should not be reachable at all — the feed and conversation loaders filter
 * them — so `blocked` here is a belt-and-braces marker rather than the enforcement.
 *
 * @returns {Promise<Map<string, {following: boolean, requested: boolean, muted: boolean, blocked: boolean}>>}
 */
const loadRelationships = async (botId, userIds) => {
  const ids = [...new Set(userIds.map(String))].filter(Boolean);
  if (!ids.length) return new Map();

  const [edges, relations] = await Promise.all([
    Follow.find({ follower: botId, following: { $in: ids } })
      .select("following status")
      .lean(),
    UserRelation.find({ from: botId, to: { $in: ids }, kind: { $in: ["mute", "block"] } })
      .select("to kind")
      .lean(),
  ]);

  const map = new Map(
    ids.map((id) => [id, { following: false, requested: false, muted: false, blocked: false }])
  );

  for (const edge of edges) {
    const entry = map.get(String(edge.following));
    if (!entry) continue;
    if (edge.status === "accepted") entry.following = true;
    if (edge.status === "pending") entry.requested = true;
  }
  for (const relation of relations) {
    const entry = map.get(String(relation.to));
    if (!entry) continue;
    if (relation.kind === "mute") entry.muted = true;
    if (relation.kind === "block") entry.blocked = true;
  }

  return map;
};

const loadFeed = async (botId, authorIds, limit = SECTION_CAPS.feedPosts, exclude = {}) => {
  if (!authorIds.length || limit <= 0) return [];

  const now = Date.now();
  const posts = await Post.find({
    author: { $in: authorIds },
    isDeleted: { $ne: true },
    isDraft: { $ne: true },
    isScheduled: { $ne: true },
    /*
     * Posts the bot has already dismissed, hidden the way the human feed hides them.
     *
     * `getHomeFeed` has always done this and a bot's feed never did, which did not matter while
     * a bot had no way to dismiss anything. It does now, and without this `not_interested_post`
     * would be an action that visibly changes nothing: the same post comes back next cycle
     * carrying `already_dismissed`, and the bot has spent a slot in its daily budget to be
     * shown it again.
     */
    ...(exclude.postIds?.length ? { _id: { $nin: exclude.postIds } } : {}),
    createdAt: {
      $gte: new Date(now - FEED_WINDOW_MS),
      // A post seconds old is one the author may still be editing or deleting.
      $lte: new Date(now - MIN_POST_AGE_MS),
    },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("content media poll quotedPost quotedComment counts createdAt author whoCanReply mentions")
    .populate("author", "username name bio isBot")
    .lean();

  if (!posts.length) return [];

  const postIds = posts.map((post) => post._id);
  const [likes, reposts, saves, dismissed, comments, quotes] = await Promise.all([
    Like.find({ user: botId, targetType: "Post", target: { $in: postIds } })
      .select("target")
      .lean(),
    Repost.find({ user: botId, targetType: "Post", target: { $in: postIds } })
      .select("target")
      .lean(),
    Saved.find({ user: botId, post: { $in: postIds } })
      .select("post")
      .lean(),
    NotInterested.find({ user: botId, post: { $in: postIds } })
      .select("post")
      .lean(),
    /*
     * What this bot has already said under each of these posts, and about them.
     *
     * The other four flags exist because the action would undo something or spend a budget to
     * change nothing. These two exist because the action *works* — and that is worse. A post
     * that stays in a small feed comes back every cycle, the model has no memory of the last
     * one, and one bot put sixteen comments under a single post over a day. Nothing refused
     * any of them: each was a valid comment on a post it was legitimately shown, and the
     * validator's duplicate check only looks within one cycle.
     *
     * Deleted comments are counted too — `isDeleted` is not filtered — because deleting a
     * reply is not an invitation to write it again.
     */
    Comment.find({ author: botId, post: { $in: postIds } })
      .select("post")
      .lean(),
    Post.find({ author: botId, quotedPost: { $in: postIds } })
      .select("quotedPost")
      .lean(),
  ]);
  const liked = new Set(likes.map((row) => String(row.target)));
  const reposted = new Set(reposts.map((row) => String(row.target)));
  const saved = new Set(saves.map((row) => String(row.post)));
  const notInterested = new Set(dismissed.map((row) => String(row.post)));
  const commented = new Set(comments.map((row) => String(row.post)));
  const quoted = new Set(quotes.map((row) => String(row.quotedPost)));

  /*
   * `canUserReplyToTarget` per post, capped by `SECTION_CAPS.feedPosts`.
   *
   * One call each rather than a batch, because the helper is the single implementation of that
   * rule and a batched copy would be a second one. At twenty posts a cycle, on a schedule
   * measured in tens of minutes, the cost is irrelevant next to the model call that follows.
   */
  const replyable = await Promise.all(
    posts.map((post) => canUserReplyToTarget(botId, post).catch(() => false))
  );

  return posts.map((post, index) => ({
    ...post,
    alreadyLiked: liked.has(String(post._id)),
    alreadyReposted: reposted.has(String(post._id)),
    alreadySaved: saved.has(String(post._id)),
    alreadyDismissed: notInterested.has(String(post._id)),
    alreadyCommented: commented.has(String(post._id)),
    alreadyQuoted: quoted.has(String(post._id)),
    canReply: replyable[index],
  }));
};

/**
 * Conversations with something unread, and a short tail of each.
 *
 * Unread is `createdAt > lastReadAt` against `ConversationRead`, the same watermark the human
 * chat list uses — so a bot's idea of "unread" cannot drift from what a person would see.
 * `clearedAt` is honoured too: a conversation the bot's owner deleted stays deleted.
 */
const loadConversations = async (botId) => {
  const reads = await ConversationRead.find({ user: botId })
    .select("conversation lastReadAt clearedAt")
    .sort({ lastReadAt: -1 })
    .limit(50)
    .lean();
  if (!reads.length) return [];

  const conversations = [];

  for (const read of reads) {
    if (conversations.length >= SECTION_CAPS.conversations) break;

    const since = read.clearedAt && read.clearedAt > read.lastReadAt ? read.clearedAt : read.lastReadAt;

    const unread = await Message.countDocuments({
      conversation: read.conversation,
      sender: { $ne: botId },
      isDeleted: { $ne: true },
      createdAt: { $gt: since || new Date(0) },
    });
    if (!unread) continue;

    /*
     * The tail, oldest-last then reversed by the shaper. Includes the bot's own messages: a
     * reply written without seeing what it itself last said reads as a different person each
     * time, which is the specific failure that makes bots feel like bots.
     */
    const messages = await Message.find({
      conversation: read.conversation,
      isDeleted: { $ne: true },
      ...(read.clearedAt ? { createdAt: { $gt: read.clearedAt } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(SECTION_CAPS.messagesPerConversation)
      .select("content media createdAt sender")
      .lean();
    if (!messages.length) continue;

    /*
     * The peer, via the existing helper rather than by parsing the key here.
     *
     * `participantsOfConversation` already knows both shapes — a DM key is two sorted ids, a
     * group key is `g:<id>` and resolves through GroupMember. Reimplementing the DM half
     * inline would have quietly treated a group conversation as a DM and picked a nonsense
     * peer, since a bot can be in groups too.
     */
    const participants = await participantsOfConversation(read.conversation);
    const peerId = participants.find((id) => String(id) !== String(botId));
    /*
     * Skipped when there isn't exactly one other party. Group conversations are out of scope
     * for a bot cycle for now: a group reply needs the group's own send gates (slow mode,
     * mute, per-member permissions) which `sendDirectMessage` does not apply.
     */
    if (!peerId || participants.length !== 2) continue;

    const peer = await User.findOne({ _id: peerId, ...ACTIVE_ACCOUNT })
      .select("username name bio isBot")
      .lean();
    // A deleted or suspended peer's conversation is not something to reply into.
    if (!peer) continue;

    conversations.push({
      conversation: read.conversation,
      peer,
      unread,
      messages: messages.reverse(),
    });
  }

  return conversations;
};

/**
 * Record that the bot has now seen these conversations.
 *
 * The counterpart to `loadConversations`, and it lives beside it deliberately: that function
 * *defines* unread for a bot, and nothing was ever writing the other half of the pair.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * A bot's `lastReadAt` never moved. Only `chatController` advanced it, and only for the human
 * pressing keys — so from the watermark's point of view a bot had never read anything in its life.
 * Every cycle, `loadConversations` found the same peer message still `createdAt > lastReadAt`,
 * put the same conversation in the perception, and the model answered it again. Forever.
 *
 * What that looks like to the person on the other end is a bot re-answering a message they sent
 * days ago, in slightly different words each time, with no new message from them in between. It
 * is the single most unnerving thing one of these accounts can do, and it was not rate-limited by
 * anything except the cycle cadence.
 *
 * ── Why "seen", not "replied" ───────────────────────────────────────────────
 *
 * Marking read only when a reply is sent would fix the visible half and leave the expensive half:
 * a bot that reads a message and decides not to answer would be shown it again next cycle, and the
 * cycle after, paying for the same judgement each time — and eventually making a *different* call
 * and answering something hours old. Being shown the message and reaching a decision about it is
 * what reading is; the reply is one possible outcome of it.
 *
 * ── The timestamp is not "now" ──────────────────────────────────────────────
 *
 * `at` must be when the conversation was *read*, not when the cycle finished. A model call takes
 * seconds, and a message that arrives in that window was never in the perception. Marking it read
 * with `new Date()` at the end would swallow it silently — the person's follow-up would be
 * ignored, which is a worse bug than the one being fixed here. Callers pass the instant they
 * snapshotted.
 *
 * Best-effort: a failed watermark write means the conversation is offered again next cycle, which
 * is the behaviour this replaces, so it is not worth failing a completed cycle over.
 */
export const markConversationsSeen = async (botId, conversationIds, at) => {
  for (const conversation of new Set((conversationIds || []).filter(Boolean))) {
    try {
      await markConversationRead(botId, String(conversation), at);
    } catch (error) {
      console.error("bot read watermark failed:", error?.message ?? error);
    }
  }
};

/** Follow requests waiting on this bot, if it is private. */
const loadFollowRequests = async (botId) => {
  const pending = await Follow.find({ following: botId, status: "pending" })
    .sort({ createdAt: -1 })
    .limit(SECTION_CAPS.followRequests)
    .populate("follower", "username name bio isBot")
    .lean();

  // With the bio: deciding whether to accept a follow is exactly the case where who
  // someone claims to be is the question being asked.
  return pending
    // No relationship map: by definition the bot does not follow someone whose request to
    // follow *it* is still pending, and the bio is what the decision turns on here.
    .map((edge) => shapeActor(edge.follower, { withBio: true }))
    .filter((actor) => actor.id);
};

/** Recent notifications: who engaged with this bot, and on what. */
const loadNotifications = async (botId) => {
  const rows = await Notification.find({ recipient: botId, isRead: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(SECTION_CAPS.notifications)
    .populate("sender", "username name bio isBot")
    .lean();

  return rows
    .filter((row) => row.sender)
    .map((row) => ({
      type: row.type,
      from: shapeActor(row.sender),
      post_id: row.entityType === "Post" && row.entity ? String(row.entity) : null,
      at: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    }));
};

/** What this bot has posted lately, so it doesn't repeat itself. */
const loadOwnRecent = async (botId) => {
  const posts = await Post.find({ author: botId, isDeleted: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(SECTION_CAPS.ownRecentPosts)
    .select("content createdAt")
    .lean();

  return posts.map((post) => ({
    text: post.content?.slice(0, 200) ?? "",
    at: post.createdAt ? new Date(post.createdAt).toISOString() : null,
  }));
};

/**
 * Build one cycle's perception.
 *
 * @returns `{ perception, allowedTargets, tokens, dropped }`
 *
 * `allowedTargets` is derived from the *shaped* perception, not from the queries — so an id can
 * only be actionable if it survived every filter and appeared in the payload the model saw.
 * That is what makes "a bot cannot act on something it wasn't shown" a structural guarantee
 * rather than a promise.
 */
export const buildPerception = async (bot) => {
  const botId = bot?._id ?? bot;

  // What the bot has chosen not to see, applied to both halves of the feed below.
  const hidden = await hiddenByBot(botId);
  const authorIds = await visibleAuthorIds(botId, hidden.mutedIds);

  const [followedFeed, conversations, followRequests, notifications, ownRecent] =
    await Promise.all([
      loadFeed(botId, authorIds, SECTION_CAPS.feedPosts, hidden),
      loadConversations(botId),
      loadFollowRequests(botId),
      loadNotifications(botId),
      loadOwnRecent(botId),
    ]);

  /*
   * Public posts fill whatever room the follow feed left — see `discoverAuthorIds`.
   *
   * Sequential rather than part of the `Promise.all` above, because how many to ask for
   * depends on what the follow feed returned. A bot whose follows already filled the cap pays
   * nothing for this.
   *
   * The authors already in the feed are excluded so the top-up doesn't spend its slots on
   * posts the bot is being shown anyway. `collectAllowedTargets` derives from the shaped
   * perception, so discovered posts become legal like/comment/save targets and their authors
   * legal `follow_user` targets with no change to the validator.
   */
  const feed = [...followedFeed];
  let discovered = 0;
  const room = SECTION_CAPS.feedPosts - feed.length;
  if (room > 0) {
    const seenAuthors = [...new Set(followedFeed.map((post) => String(post.author?._id ?? post.author)))];
    // Muted accounts are excluded from discovery too, or muting someone the bot doesn't follow
    // would do nothing at all — which is most of the accounts it can now see.
    const discoveryIds = await discoverAuthorIds(botId, [
      ...authorIds,
      ...seenAuthors,
      ...hidden.mutedIds,
    ]);
    if (discoveryIds.length) {
      const extra = await loadFeed(botId, discoveryIds, room, hidden);
      // Marked per post rather than for the batch: a blended feed has both kinds in it, and
      // "you don't follow this person" is exactly the context that makes `follow_user` a
      // sensible thing for the model to consider on that post and not on the one above it.
      for (const post of extra) feed.push({ ...post, fromDiscovery: true });
      discovered = extra.length;
    }
  }

  /*
   * Relationship state for everyone the bot is about to be shown.
   *
   * Without it the model is guessing: it cannot tell whether it already follows the author of
   * a post, and `follow_user` on someone already followed is a wasted action out of a capped
   * daily budget — while `unfollow_user` on a stranger is nonsense. Muting and blocking are
   * carried for the same reason, and because re-muting someone is the kind of loop a model
   * with no memory of its own state will happily repeat every cycle.
   */
  const audience = [
    ...feed.map((post) => post.author?._id ?? post.author),
    // `peer`, not `with`. `with` is the *shaped* name — `shapeConversation` renames it — and
    // reading it here silently dropped every DM peer from the relationship lookup, which made
    // `unfollow_user` permanently refuse anyone the bot only knew through messages.
    ...conversations.map((conversation) => conversation.peer?._id ?? conversation.peer),
  ].filter(Boolean);
  const relationships = await loadRelationships(botId, audience);

  const assembled = {
    notice: PERCEPTION_NOTICE,
    now: new Date().toISOString(),
    feed_posts: feed.map((post) => shapeFeedPost(post, relationships)),
    conversations: conversations.map((conversation) =>
      shapeConversation(conversation, botId, relationships)
    ),
    follow_requests: followRequests,
    notifications,
    own_recent_posts: ownRecent,
  };

  const { perception, tokens, dropped } = applyBudget(assembled);

  /*
   * Marked after the budget, not before. `applyBudget` can sacrifice `feed_posts` entirely,
   * and saying where posts came from when there are none is noise. Absent when the follow feed
   * filled the cap on its own, so an established bot's payload is unchanged.
   */
  if (discovered && perception.feed_posts?.length) {
    perception.feed_includes_accounts_you_dont_follow = true;
  }

  return {
    perception,
    allowedTargets: collectAllowedTargets(perception),
    tokens,
    dropped,
  };
};

/**
 * Is there anything worth spending a model call on?
 *
 * Checked before the call, not after. A bot whose feed is empty and whose inbox is quiet has
 * nothing to decide, and asking anyway costs the owner money to be told `do_nothing`. This is
 * the cheapest saving in the whole feature and the easiest to forget.
 */
export const hasAnythingToDo = (perception) =>
  Boolean(
    perception?.feed_posts?.length ||
      perception?.conversations?.length ||
      perception?.follow_requests?.length ||
      perception?.notifications?.length
  );
