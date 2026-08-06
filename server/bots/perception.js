import Post from "../models/Post.js";
import Message from "../models/Message.js";
import Follow from "../models/Follow.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import Notification from "../models/Notification.js";
import ConversationRead from "../models/ConversationRead.js";
import User from "../models/User.js";
import { ACTIVE_ACCOUNT, blockedIdSet } from "../utils/chatAccess.js";
import { participantsOfConversation } from "../utils/conversationActivity.js";
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
 * The known differences, stated so nobody has to rediscover them: a bot sees no reposts, no
 * suggested accounts it doesn't follow, and no NotInterested filtering. All three are absences
 * of features a bot has no use for.
 */

/** Posts newer than this are ignored, so a bot doesn't react to something a second old. */
const MIN_POST_AGE_MS = 60 * 1000;

/** How far back a cycle looks. Older than this and it isn't news. */
const FEED_WINDOW_MS = 48 * 60 * 60 * 1000;

const idsOf = (rows, field) => rows.map((row) => row[field]).filter(Boolean);

/**
 * Accounts this bot may see content from: those it follows, minus anyone either side has
 * blocked.
 *
 * Following-only is also what makes private accounts safe by construction — a bot can only
 * hold an accepted follow edge to a private account if that account approved it, so no
 * separate visibility check is needed for them.
 */
const visibleAuthorIds = async (botId) => {
  const edges = await Follow.find({ follower: botId, status: "accepted" })
    .select("following")
    .lean();
  const followingIds = idsOf(edges, "following");
  if (!followingIds.length) return [];

  const blocked = await blockedIdSet(botId, followingIds);
  return followingIds.filter((id) => !blocked.has(String(id)));
};

/**
 * The feed slice, with this bot's own prior engagement attached.
 *
 * `alreadyLiked` and `alreadyReposted` matter more than they look: both actions are *toggles*,
 * so offering the model a post it has already liked means offering it the chance to silently
 * un-like it. Marking them lets the validator and the prompt exclude them instead.
 */
const loadFeed = async (botId, authorIds) => {
  if (!authorIds.length) return [];

  const now = Date.now();
  const posts = await Post.find({
    author: { $in: authorIds },
    isDeleted: { $ne: true },
    isDraft: { $ne: true },
    isScheduled: { $ne: true },
    createdAt: {
      $gte: new Date(now - FEED_WINDOW_MS),
      // A post seconds old is one the author may still be editing or deleting.
      $lte: new Date(now - MIN_POST_AGE_MS),
    },
  })
    .sort({ createdAt: -1 })
    .limit(SECTION_CAPS.feedPosts)
    .select("content media poll quotedPost quotedComment counts createdAt author whoCanReply mentions")
    .populate("author", "username name bio isBot")
    .lean();

  if (!posts.length) return [];

  const postIds = posts.map((post) => post._id);
  const [likes, reposts] = await Promise.all([
    Like.find({ user: botId, targetType: "Post", target: { $in: postIds } })
      .select("target")
      .lean(),
    Repost.find({ user: botId, targetType: "Post", target: { $in: postIds } })
      .select("target")
      .lean(),
  ]);
  const liked = new Set(likes.map((row) => String(row.target)));
  const reposted = new Set(reposts.map((row) => String(row.target)));

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

  const authorIds = await visibleAuthorIds(botId);

  const [feed, conversations, followRequests, notifications, ownRecent] = await Promise.all([
    loadFeed(botId, authorIds),
    loadConversations(botId),
    loadFollowRequests(botId),
    loadNotifications(botId),
    loadOwnRecent(botId),
  ]);

  const assembled = {
    notice: PERCEPTION_NOTICE,
    now: new Date().toISOString(),
    feed_posts: feed.map(shapeFeedPost),
    conversations: conversations.map((conversation) => shapeConversation(conversation, botId)),
    follow_requests: followRequests,
    notifications,
    own_recent_posts: ownRecent,
  };

  const { perception, tokens, dropped } = applyBudget(assembled);

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
