import mongoose from "mongoose";
import Message from "../models/Message.js";
import User from "../models/User.js";
import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";
import UserSettings from "../models/UserSettings.js";
import UserRelation from "../models/UserRelation.js";
import MessageReaction from "../models/MessageReaction.js";
import ConversationRead from "../models/ConversationRead.js";
import Follow from "../models/Follow.js";
import { deleteFromCloudinary, uploadToCloudinary, videoStillUrl } from "../config/cloudinary.js";
import { CHAT_UPLOAD_TYPES } from "../config/multerConfig.js";
import { getIO } from "../config/socket.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import {
  buildCursorPageInfo,
  decodeCursor,
  mergeFilters,
  parseCursorLimit,
  withCursor,
} from "../utils/cursorPagination.js";
import { escapeRegex } from "../utils/respond.js";
import { applyPollView, applyPollViews } from "../utils/pollView.js";
import { signMedia, verifyMedia } from "../utils/mediaToken.js";
import { parseReactionEmoji, parseSkinTone } from "../utils/reactions.js";
import { isUnlockedForRequest, issueUnlockGrant } from "../utils/chatLock.js";
import {
  MAX_CATEGORIES,
  MAX_PREFERENCE_ENTRIES,
  atPreferenceCap,
  parseChatId,
  sameChatId,
  withoutChatId,
} from "../utils/chatPreferences.js";
import {
  activityCursorFilter,
  decodeActivityCursor,
  encodeActivityCursor,
} from "../utils/conversationActivity.js";
import {
  EDITABLE_MESSAGE_TYPES,
  MAX_CONTENT_LENGTH,
  MAX_MEDIA_PER_MESSAGE,
} from "../utils/messageContent.js";
import {
  attachSharedContent,
  stripSharedSnapshot,
  stripSharedSnapshots,
} from "../utils/resolveSharedContent.js";
import {
  EPOCH,
  markConversationDelivered,
  markConversationRead,
  chatIdForConversation,
  dmPeerId,
  markConversationUnread,
  notifyConversationRead,
  peerReadAt,
  peerReadWatermarks,
  unreadCountsByConversation,
  watermarksFromRows,
} from "../utils/readState.js";
import {
  ACTIVE_ACCOUNT,
  MAX_RECIPIENTS,
  MAX_TTL_SECONDS,
  blockedIdSet,
  canSeeMessage,
  cleanIds,
  conversationRoom,
  groupMembership,
  historyFloor,
  historyFloorFilter,
  historyFloorFor,
  historyFloors,
  isGroupMember,
  isMessageParticipant,
  messageableIdSet,
  resolveGroupSend,
} from "../utils/chatAccess.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns Group ObjectIds the user belongs to (not banned). */
async function getUserGroupIds(userId) {
  const memberships = await GroupMember.find({
    user: userId,
    isBanned: { $ne: true },
  }).select("group").lean();
  return memberships.map((m) => m.group);
}


/**
 * `chatId` is `user_<id>` or `group_<id>`; conversations are keyed differently.
 * Returns null for anything malformed.
 */
const conversationForChatId = (chatId, userId) => {
  const canonical = parseChatId(chatId);
  if (!canonical) return null;
  const [kind, id] = canonical.split("_");
  return kind === "group"
    ? Message.groupConversationKey(id)
    : Message.dmConversationKey(userId, id);
};

/** deletedFor in new schema is plain ObjectId[]. */
const notDeletedForUser = (userId) => ({
  deletedFor: { $not: { $elemMatch: { $eq: userId } } },
});

/*
 * A note on `{ $ne: true }` rather than `{ isDeleted: false }`, which is what
 * every filter in this file now uses.
 *
 * Mongo's strict equality does not match a document where the field is absent,
 * and `.lean()` never applies a Mongoose default — so `{isDeleted: false}`
 * silently excluded every message written before `isDeleted` existed. The rest of
 * the repo has always used `$ne` and says why (shareController, contentSearch,
 * resolveSharedContent); the chat layer was the only place using equality, and
 * the two halves of the codebase disagreed about the *same collection*.
 *
 * Same reasoning for `isGroupMessage` and `isBanned`.
 */

// Matches UserSettings' customCategories.name maxlength.
const MAX_CATEGORY_NAME = 30;
// Nothing capped poll.question at all, so a 10MB question was a valid poll.
const MAX_POLL_QUESTION = 300;
const MAX_POLL_OPTION = 100;
/*
 * How far back the cross-conversation search reaches. Six months covers the
 * "where did they send me that link" case the search box exists for; see the
 * note in globalSearch for what it buys and what it costs.
 */
const GLOBAL_SEARCH_WINDOW_DAYS = 180;

const PREFERENCE_LIST_FULL = {
  error: `You can have up to ${MAX_PREFERENCE_ENTRIES} chats in that list`,
};

/**
 * A query-string value that is definitely a string, or undefined.
 *
 * Express parses `?search[]=x` into an array and `?search[a]=1` into an object,
 * and handlers that then called `.toLowerCase()` or handed the value to
 * `escapeRegex` threw — a malformed query string became a 500, which is a client
 * mistake reported as a server fault and pollutes the only signal that matters
 * on the error dashboard.
 */
const queryString = (value) => (typeof value === "string" ? value : undefined);

/**
 * 423 for a locked conversation the request holds no unlock grant for.
 *
 * Returns true when it has answered, so the caller returns immediately. Applied
 * to every read that carries message content, not just the thread: enforcing it
 * at one entry point while search, media and pinned messages answered freely
 * would be a boundary with four doors in it.
 */
const answeredLocked = async (req, res, userId, chatId) => {
  if (await isUnlockedForRequest(req, userId, chatId)) return false;
  res.status(423).json({
    error: "This chat is locked",
    locked: true,
    chatId,
  });
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

export const getMessages = async (req, res) => {
  try {
    const userId = req.user._id;
    const senderId = userId.toString();

    const receiver = await User.findOne({ username: req.params.username }).select("_id username name profilePic isVerified");
    if (!receiver) return res.status(404).json({ error: "User not found" });

    // The chat lock, enforced here rather than only in the list. Checked before
    // any of the work below, so a locked thread costs one settings read.
    if (await answeredLocked(req, res, userId, `user_${receiver._id}`)) return;

    // Block state — history stays readable (Instagram-style), but sending is
    // disabled (enforced in the socket layer) and the UI reflects the direction.
    const [youBlockedRel, blockedYouRel] = await Promise.all([
      UserRelation.findOne({ from: userId, to: receiver._id, kind: "block" }).lean(),
      UserRelation.findOne({ from: receiver._id, to: userId, kind: "block" }).lean(),
    ]);
    const blockState = {
      youBlocked: Boolean(youBlockedRel),
      blockedByThem: Boolean(blockedYouRel),
    };

    const { limit = 50, cursor, after, messageType } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);

    const conversationKey = Message.dmConversationKey(userId, receiver._id);

    /*
     * Unsent messages are returned, not filtered out.
     *
     * The client leaves a "This message was deleted" tombstone in place when
     * `messageUnsent` arrives, and the server used to exclude those rows on the
     * next read — so a message you unsent came back on reload as if it had
     * never existed, and the two halves disagreed about what the thread
     * contained. `unsendMessage` already overwrites the content and clears the
     * media, so the row carries nothing to leak. `deletedFor` is different: it
     * is per-user and stays hidden.
     */
    const query = withCursor(
      {
        conversation: conversationKey,
        ...notDeletedForUser(userId),
      },
      parsedCursor
    );

    // `?after=garbage` and `?after[]=x` both produce an Invalid Date, which
    // Mongoose rejects with a CastError — a 500 for a malformed query string.
    const afterDate = typeof after === "string" ? new Date(after) : null;
    if (afterDate && !Number.isNaN(afterDate.getTime())) {
      query.createdAt = { ...query.createdAt, $gt: afterDate };
    }
    if (typeof messageType === "string") query.messageType = messageType;

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic isVerified")
      .populate("receiver", "username name profilePic isVerified")
      /*
       * The reply preview needs a name to render and needs to know whether the
       * original still exists. `"content sender"` gave it neither: `sender` was
       * a bare id, so the author line was always blank, and without `isDeleted`
       * a reply to an unsent message still showed the original text.
       */
      .populate({
        path: "replyTo",
        select: "content messageType media isDeleted sender createdAt",
        populate: { path: "sender", select: "username name" },
      })
      .populate("mentions", "username name profilePic")
      .lean();

    const { items: pagedDesc, pageInfo } = buildCursorPageInfo(messages, limitNum);
    const chronologicalMessages = [...pagedDesc].reverse();

    // Mark unread messages as delivered
    const unreadIds = chronologicalMessages
      .filter((msg) => msg.receiver?._id?.toString() === senderId && msg.status === "sent")
      .map((msg) => msg._id);

    if (unreadIds.length) {
      // One watermark write instead of a receipt row per message.
      await Message.updateMany({ _id: { $in: unreadIds } }, { $set: { status: "delivered" } });
      await markConversationDelivered(userId, conversationKey);
    }

    await User.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } });

    // Shared posts resolve against the reader, so a private account or a new
    // block locks the card even on messages sent long ago.
    await attachSharedContent(chronologicalMessages, userId);

    // So does a poll: an anonymous one must not ship its voter list.
    applyPollViews(chronologicalMessages, userId);

    // How far the other person has read. The client renders "Seen" by comparing
    // this against each of the caller's own messages — the old code tested a
    // `message.isRead` field that has never existed on the schema, so Seen
    // could not render at all.
    const theirReadAt = await peerReadAt(userId, receiver._id, conversationKey);

    /*
     * The peer, resolved server-side.
     *
     * The client used to get this from `GET /user/:username`, which 404s when
     * that person has blocked you — and the page read *any* 404 as a block, so
     * a mistyped username opened a thread with a fabricated "Gossips User" who
     * had supposedly blocked you. This endpoint already resolved the username
     * to decide whether the account exists, so it can say so authoritatively:
     * a 404 here means no such user, and a peer with `blockedByThem` means a
     * real person who has blocked you.
     */
    const peer = blockState.blockedByThem
      ? {
          _id: receiver._id,
          username: receiver.username,
          name: "Gossips User",
          profilePic: "",
          isVerified: false,
          blockedByThem: true,
        }
      : {
          _id: receiver._id,
          username: receiver.username,
          name: receiver.name,
          profilePic: receiver.profilePic,
          isVerified: receiver.isVerified,
          blockedByThem: false,
        };

    res.status(200).json({
      messages: chronologicalMessages,
      pageInfo,
      hasMore: pageInfo.hasNextPage,
      blockState,
      peer,
      conversation: conversationKey,
      peerReadAt: theirReadAt,
    });
  } catch (error) {
    console.error("getMessages error:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
};

export const getGroupMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { groupId } = req.params;
    const { limit = 50, cursor, after } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);

    const group = await Group.findById(groupId)
      .select("name avatar counts _id settings.messageHistory")
      .lean();
    if (!group) return res.status(404).json({ error: "Group not found" });

    const membership = await GroupMember.findOne({ group: groupId, user: userId, isBanned: { $ne: true } }).lean();
    if (!membership) return res.status(403).json({ error: "Not a member of this group" });

    // Groups can be locked too — `lockedChats` holds `group_<id>` entries.
    if (await answeredLocked(req, res, userId, `group_${group._id}`)) return;

    const conversationKey = Message.groupConversationKey(groupId);

    /*
     * `messageHistory: "hidden"` floors this thread at the caller's own joinedAt.
     *
     * Computed from the two documents already in hand rather than through the async
     * `historyFloor` helper, which would re-read both. The pure form is exported for
     * exactly this case.
     */
    const floor = historyFloorFor(group.settings?.messageHistory, membership.joinedAt);

    // Tombstones are returned here too, and anonymous polls are stripped for
    // this reader the same way — see the notes in getMessages.
    let query = withCursor(
      {
        conversation: conversationKey,
        ...notDeletedForUser(userId),
      },
      parsedCursor
    );

    // Same guard as getMessages — an unparseable date was a 500.
    const afterDate = typeof after === "string" ? new Date(after) : null;
    if (afterDate && !Number.isNaN(afterDate.getTime())) {
      query.createdAt = { $gt: afterDate };
    }

    /*
     * Merged last, and with `mergeFilters` rather than a spread.
     *
     * `after` above writes `query.createdAt` directly, so a spread in either order would
     * have one of the two bounds silently overwrite the other — and the one that vanishes
     * would be the floor, which is the access control. `mergeFilters` puts colliding keys
     * under `$and` so both survive.
     */
    query = mergeFilters(query, historyFloorFilter(floor));

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic isVerified")
      /*
       * The reply preview needs a name to render and needs to know whether the
       * original still exists. `"content sender"` gave it neither: `sender` was
       * a bare id, so the author line was always blank, and without `isDeleted`
       * a reply to an unsent message still showed the original text.
       */
      .populate({
        path: "replyTo",
        select: "content messageType media isDeleted sender createdAt",
        populate: { path: "sender", select: "username name" },
      })
      .populate("mentions", "username name profilePic")
      .lean();

    const { items: pagedDesc, pageInfo } = buildCursorPageInfo(messages, limitNum);
    const chronologicalMessages = [...pagedDesc].reverse();

    /*
     * The reply preview is the way round the floor, so it gets floored too.
     *
     * The query above only bounds the messages themselves. `replyTo` is a populate, and it
     * selects `content` and `media` — so a member who joined yesterday reading a reply
     * written last year would be handed the text of the message it answers, one message at
     * a time, straight through a control that had just refused it in the list.
     *
     * Nulled rather than dropped: the reply still exists and the client already renders a
     * missing parent as "Original message unavailable", which is exactly what this is.
     */
    if (floor) {
      for (const message of chronologicalMessages) {
        if (message.replyTo?.createdAt && new Date(message.replyTo.createdAt) < floor) {
          message.replyTo = null;
        }
      }
    }

    await attachSharedContent(chronologicalMessages, userId);
    applyPollViews(chronologicalMessages, userId);

    res.status(200).json({
      messages: chronologicalMessages,
      pageInfo,
      hasMore: pageInfo.hasNextPage,
      groupInfo: {
        _id: group._id,
        name: group.name,
        avatar: group.avatar,
        memberCount: group.counts?.members ?? 0,
      },
    });
  } catch (error) {
    console.error("getGroupMessages error:", error);
    res.status(500).json({ error: "Failed to fetch group messages" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Chat list
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Conversations per page.
 *
 * Larger than the message default of 10 because a chat row is a fraction of the size and
 * the list is the first screen — a phone shows a dozen, so a page has to cover a scroll
 * or two without a round trip. `?limit=` overrides it up to the shared MAX_LIMIT of 100.
 */
const DEFAULT_CHAT_PAGE = 30;

export const getChats = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const userId = req.user._id;
    // Type-guarded: `?search[]=x` arrives as an array and the `.toLowerCase()`
    // below threw on it, turning a malformed query string into a 500.
    const search = queryString(req.query.search);
    const unreadOnly = queryString(req.query.unreadOnly);
    const archived = queryString(req.query.archived);
    const view = queryString(req.query.view) ?? "all";
    const categoryId = queryString(req.query.categoryId);

    // Load user's chat settings from UserSettings
    const settings = await UserSettings.findOne({ user: userId }).select("chat").lean();
    const chatPref = settings?.chat || {};

    /*
     * Canonicalised on read, because they are now used two ways.
     *
     * These lists can hold legacy uppercase-hex entries written before the writers
     * lowercased (see `sameChatId`). The flags below are set by exact `Set.has(chatId)`
     * against a canonical id, while the query predicates go through `parseChatId`, which
     * lowercases — so an uncanonicalised set would exclude an archived conversation from
     * the query and then report `isArchived: false` for it on the Archived tab. One
     * normalisation at the top keeps both readings identical. A malformed entry drops out,
     * which is correct: nothing can match it.
     */
    const canonicalSet = (list) =>
      new Set((Array.isArray(list) ? list : []).map(parseChatId).filter(Boolean));

    const archivedSet   = canonicalSet(chatPref.archivedChats?.map((c) => c.chatId));
    const favoriteSet   = canonicalSet(chatPref.favoriteChats);
    const pinnedSet     = canonicalSet(chatPref.pinnedChats);
    const mutedSet      = canonicalSet(chatPref.mutedChats);
    const lockedSet     = canonicalSet(chatPref.lockedChats);
    const assignmentMap = new Map(
      (chatPref.categoryAssignments || [])
        .map((a) => [parseChatId(a?.chatId), a?.categoryId])
        .filter(([chatId, categoryId]) => chatId && categoryId)
    );

    // Following/followers for relationship metadata
    const [followEdges, reverseEdges, blockedRelations, blockedByRelations] = await Promise.all([
      Follow.find({ follower: userId, status: "accepted" }).select("following").lean(),
      Follow.find({ following: userId, status: "accepted" }).select("follower").lean(),
      UserRelation.find({ from: userId, kind: "block" }).select("to").lean(),
      UserRelation.find({ to: userId, kind: "block" }).select("from").lean(),
    ]);
    const followingSet = new Set(followEdges.map((e) => e.following.toString()));
    const followersSet = new Set(reverseEdges.map((e) => e.follower.toString()));
    const blockedSet   = new Set(blockedRelations.map((r) => r.to.toString()));
    // Accounts that blocked the viewer — their identity is anonymized in the list.
    const blockedBySet = new Set(blockedByRelations.map((r) => r.from.toString()));

    // Default placeholder shown for an account that blocked you ("Gossips User").
    const anonymizePeer = (peer) =>
      peer && {
        _id: peer._id,
        username: peer.username, // kept for navigation; opening it shows "User not found"
        name: "Gossips User",
        profilePic: "",
        isVerified: false,
        blockedByThem: true,
      };

    // Read state comes from the per-conversation watermark, not from
    // Message.status. That field is one value shared by every recipient, so a
    // group message went to zero unread for all two hundred members the moment
    // any one of them opened the thread.
    /*
     * ── The page of conversations (CF23/CF24) ────────────────────────────────
     *
     * This used to `$group` every message the caller had ever sent or received to find
     * the newest per conversation, then cap the *result* at 500. Bounded output,
     * unbounded work: `$group` consumes every match whatever the limit, and past a
     * couple of hundred groups the planner can no longer explode-for-sort and falls back
     * to a blocking sort that spills to disk — on the app's most-called endpoint, marked
     * `no-store`. It also wasn't pagination: anyone past 500 conversations silently got
     * an incomplete list.
     *
     * `ConversationRead` already carries one row per (user, conversation) and now
     * records when each last had activity, so this is an indexed range scan over exactly
     * one page. See utils/conversationActivity.js for how the field is maintained.
     */
    const limitNum = parseCursorLimit(req.query.limit, DEFAULT_CHAT_PAGE);
    const cursor = decodeActivityCursor(queryString(req.query.cursor));

    const keysFor = (chatIds) =>
      chatIds.map((chatId) => conversationForChatId(chatId, userId)).filter(Boolean);

    /*
     * Views whose membership is known from UserSettings are scoped in the query.
     *
     * These lists are capped at MAX_PREFERENCE_ENTRIES, so turning them into a `$in` is
     * bounded by construction — and it means the Archived, Favourites and category tabs
     * page properly rather than filtering after a cap and going empty for anyone past
     * it. `null` means "no restriction", which is not the same as an empty list: an empty
     * scope means the view is genuinely empty, and `$in: []` says exactly that.
     */
    const allowedKeys =
      archived === "true" ? keysFor([...archivedSet])
      : view === "favorites" ? keysFor([...favoriteSet])
      : view === "category" && categoryId
        ? keysFor([...assignmentMap.entries()].filter(([, id]) => id === categoryId).map(([chatId]) => chatId))
        : null;

    // The default list excludes archived conversations in the query rather than after it,
    // so a page of 30 is 30 visible rows instead of however many survive a filter.
    const excludedKeys = archived === "false" ? keysFor([...archivedSet]) : [];

    const baseFilter = {
      user: userId,
      // Absent means the row predates the activity fields, or the conversation has no
      // messages — either way there is nothing to show for it. `npm run
      // chat:activity:backfill` is what fills those in.
      lastMessageAt: { $ne: null },
      // `view=groups` is an indexed predicate now, not a JavaScript filter over a capped
      // set — which is what made a member of more than 500 conversations unable to see
      // their own groups.
      ...(view === "groups" ? { isGroup: true } : {}),
      /*
       * Unread, as a query rather than a filter over a truncated page.
       *
       * `$expr` can't use an index, but it is a residual predicate on a range scan that
       * is already restricted to one user's rows, so it costs a comparison per row of
       * that user's own conversations — not a collection scan.
       *
       * It is a slight over-match: `lastMessageAt > lastReadAt` is also true when the
       * newest message is one the caller sent after reading, which is not unread. Those
       * rows are dropped below once the real counts are known, so a page can come back
       * shorter than the limit. That costs a page size, not a row — the cursor still
       * walks every conversation, which is the thing the old 500-cap could not do.
       */
      ...(unreadOnly === "true" || view === "unread"
        ? { $expr: { $gt: ["$lastMessageAt", { $ifNull: ["$lastReadAt", EPOCH] }] } }
        : {}),
    };

    /*
     * Pinned conversations, as a block above the cursored stream.
     *
     * Pinning has to win over recency globally — that is the entire feature — and no
     * cursor over `lastMessageAt` can express "these rows first" without a second query,
     * because a chat pinned two years ago belongs at the top of page one and sorts onto
     * page five. So the pinned rows are fetched separately, in full, on the first page
     * only, and excluded from the paged stream on every page.
     *
     * Fetching them "in full" is bounded by MAX_PREFERENCE_ENTRIES, and they are scoped
     * by the same view/archive predicates as the page — a pinned group still shouldn't
     * appear on the Archived tab.
     */
    const pinnedKeys = keysFor([...pinnedSet]);
    const allowedSet = allowedKeys && new Set(allowedKeys);
    const excludedSet = new Set(excludedKeys);
    const pinnedScope = pinnedKeys.filter(
      (key) => (!allowedSet || allowedSet.has(key)) && !excludedSet.has(key)
    );

    /** `{conversation: …}`, or `{}` when neither bound applies. */
    const conversationFilter = (only, except) => {
      const clause = {};
      if (only) clause.$in = only;
      if (except.length) clause.$nin = except;
      return Object.keys(clause).length ? { conversation: clause } : {};
    };

    const sortBy = { lastMessageAt: -1, _id: -1 };
    const rowFields = "conversation lastMessageAt lastMessageId lastReadAt isGroup";

    const [pinnedRows, rows] = await Promise.all([
      cursor || !pinnedScope.length
        ? []
        : ConversationRead.find(mergeFilters(baseFilter, { conversation: { $in: pinnedScope } }))
            .sort(sortBy)
            .limit(pinnedScope.length)
            .select(rowFields)
            .lean(),
      ConversationRead.find(
        mergeFilters(
          baseFilter,
          activityCursorFilter(cursor),
          conversationFilter(allowedKeys, [...excludedKeys, ...pinnedScope])
        )
      )
        .sort(sortBy)
        .limit(limitNum + 1)
        .select(rowFields)
        .lean(),
    ]);

    const more = rows.length > limitNum;
    const pageRows = more ? rows.slice(0, limitNum) : rows;
    const nextCursor = more ? encodeActivityCursor(pageRows[pageRows.length - 1]) : null;
    const orderedRows = [...pinnedRows, ...pageRows];

    /*
     * The previews, fetched by id.
     *
     * One query for the whole page rather than one per conversation, and only the fields
     * a preview renders — `$$ROOT` used to carry every message's media array, poll
     * votes, edit history and the ids of everyone who had deleted it for themselves,
     * multiplied by 500, on every request.
     *
     * Tombstones are included, because the thread returns them too: excluding them meant
     * unsending your newest message left the list showing the one before it while the
     * thread showed "This message was deleted" at the bottom. `unsendMessage` clears the
     * content, media, poll and snapshot, so the row carries nothing. `deletedFor` is
     * different — that one is per-user and stays excluded.
     */
    const previewIds = orderedRows.map((row) => row.lastMessageId).filter(Boolean);
    const previews = previewIds.length
      ? await Message.find({
          _id: { $in: previewIds },
          ...notDeletedForUser(userId),
        })
          .select(
            "conversation createdAt content messageType isDeleted sender isGroupMessage sharedContent poll.question media deletedFor"
          )
          // The sender, and only the sender: it drives the "You: …" prefix and the Seen
          // tick. `receiver` and `group` used to be populated here too, and the peer and
          // group documents now come from the conversation key below — so the preview is
          // no longer what decides who a chat is with, and two of the three populates go
          // away with it.
          //
          // Populated inside the query rather than by a later `Model.populate`, which is
          // what this used to do: that form does not inherit `lean` from anything, so
          // every peer document came back fully hydrated on the app's hottest endpoint.
          .populate({ path: "sender", select: "username name profilePic isVerified" })
          .lean()
      : [];

    const previewByConversation = new Map(previews.map((m) => [m.conversation, m]));

    /*
     * Identity comes from the conversation key, not from the preview.
     *
     * The key already encodes it — `g:<groupId>`, or the two user ids of a DM — so who a
     * chat is with does not depend on a message being fetchable. It used to: the peer was
     * read off the newest message's sender/receiver, so a row whose preview was
     * deleted-for-me or expired by the ephemeral TTL fell out of the derivation entirely
     * and the conversation vanished from the list while its thread still opened fine.
     *
     * Two batched lookups for the page, and a row whose peer or group has actually been
     * deleted is dropped — there is nothing left to render it as.
     */
    const peerIds = [];
    const groupIds = [];
    for (const row of orderedRows) {
      if (row.isGroup) {
        const groupId = row.conversation.slice(2);
        if (mongoose.isValidObjectId(groupId)) groupIds.push(groupId);
      } else {
        const peerId = dmPeerId(row.conversation, userId);
        if (peerId && mongoose.isValidObjectId(peerId)) peerIds.push(peerId);
      }
    }

    const [peers, groups] = await Promise.all([
      peerIds.length
        ? User.find({ _id: { $in: peerIds } }).select("username name profilePic isVerified").lean()
        : [],
      groupIds.length
        ? Group.find({ _id: { $in: groupIds } })
            .select("name avatar settings.messageHistory")
            .lean()
        : [],
    ]);
    const peerById = new Map(peers.map((u) => [u._id.toString(), u]));
    const groupById = new Map(groups.map((g) => [g._id.toString(), g]));

    /*
     * The list preview is a read of the newest message, so it obeys the history floor.
     *
     * Easy to miss, and it leaks exactly one message: join a group that has been quiet
     * since, and the newest message — from before you joined — is what the chat list shows
     * you as its preview. Every other read path is floored; this one would hand over the
     * last thing said before you arrived, on the first screen of the app.
     *
     * Conditional on a group on this page actually being `hidden`, so the common case
     * costs nothing. `settings.messageHistory` rides along on the group query that was
     * already happening; only the `joinedAt` lookup is extra, and only when it matters.
     */
    const hiddenGroups = groups.filter((g) => g.settings?.messageHistory === "hidden");
    const previewFloors = new Map();
    if (hiddenGroups.length) {
      const memberships = await GroupMember.find({
        group: { $in: hiddenGroups.map((g) => g._id) },
        user: userId,
        isBanned: { $ne: true },
      })
        .select("group joinedAt")
        .lean();
      const joinedByGroup = new Map(memberships.map((m) => [m.group.toString(), m.joinedAt]));
      for (const group of hiddenGroups) {
        const key = group._id.toString();
        previewFloors.set(key, historyFloorFor("hidden", joinedByGroup.get(key)));
      }
    }

    // From the rows already fetched, not a second query — see watermarksFromRows.
    const watermarks = watermarksFromRows(orderedRows);

    const unreadByConversation = await unreadCountsByConversation(
      userId,
      orderedRows.map((row) => row.conversation),
      watermarks
    );

    /*
     * One chat per row, in the order the query returned them.
     *
     * No re-sort: the rows arrive newest-activity-first from the index, with the pinned
     * block already in front. The old code sorted the whole array in JavaScript because
     * it had the whole array; sorting a page would only reorder within the page.
     */
    let chatArray = orderedRows.reduce((acc, row) => {
      const chatId = chatIdForConversation(row.conversation, userId);
      if (!chatId) return acc;

      const isGroup = Boolean(row.isGroup);
      const group = isGroup ? groupById.get(row.conversation.slice(2)) : null;
      const peerId = isGroup ? null : dmPeerId(row.conversation, userId);
      const otherUser = peerId ? peerById.get(peerId) : null;

      // A deleted account or group leaves a row nothing can render.
      if (isGroup ? !group : !otherUser) return acc;

      let preview = previewByConversation.get(row.conversation) ?? null;
      const blockedByThem = !isGroup && blockedBySet.has(peerId);

      // A preview from before this member joined a `hidden` group is withheld, exactly
      // like a locked chat's. `lastMessageTime` stays — the row's *position* in the list
      // isn't the secret, its contents are.
      const previewFloor = isGroup ? previewFloors.get(row.conversation.slice(2)) : null;
      if (preview && previewFloor && new Date(preview.createdAt) < previewFloor) {
        preview = null;
      }

      acc.push({
        id: chatId,
        isGroup,
        // Chat previews aren't resolved per reader, so a shared post is
        // reduced to a marker here rather than shipping its snapshot.
        // A locked chat gives up its preview. Hiding it only in the client
        // meant the content was still sitting in the response for anyone who
        // opened devtools — which is close to the only threat a chat lock
        // exists to address.
        latestMessage: lockedSet.has(chatId) || !preview ? null : stripSharedSnapshot(preview),
        conversation: row.conversation,
        unreadCount: unreadByConversation.get(row.conversation) || 0,
        // From the row, not the preview: they agree by construction, and the row is the
        // one that still has a timestamp when the preview has been deleted for this user.
        lastMessageTime: row.lastMessageAt,
        ...(isGroup
          ? { group }
          : {
              user: blockedByThem ? anonymizePeer(otherUser) : otherUser,
              relationship: {
                isFollowing: followingSet.has(peerId),
                isFollower: followersSet.has(peerId),
              },
              isBlocked: blockedSet.has(peerId),
              blockedByThem,
            }),
        isArchived: archivedSet.has(chatId),
        isFavorite: favoriteSet.has(chatId),
        isPinned: pinnedSet.has(chatId),
        isMuted: mutedSet.has(chatId),
        isLocked: lockedSet.has(chatId),
        categoryId: assignmentMap.get(chatId) || null,
      });
      return acc;
    }, []);

    // "Seen" for a chat whose last message is the caller's own: has anyone on
    // the other side read past it? One query for the whole list, and no
    // per-message write anywhere — the old code never managed to show this at
    // all, because the client tested a `isRead` field that doesn't exist.
    const ownLastConversations = chatArray
      .filter((c) => c.latestMessage?.sender?._id?.toString() === userId.toString())
      .map((c) => c.conversation);
    const peerWatermarks = await peerReadWatermarks(userId, ownLastConversations);
    chatArray = chatArray.map((chat) => ({
      ...chat,
      seen:
        chat.latestMessage?.sender?._id?.toString() === userId.toString() &&
        (peerWatermarks.get(chat.conversation) || EPOCH) >= new Date(chat.latestMessage.createdAt),
    }));

    /*
     * ── What is still filtered after the fetch ────────────────────────────────
     *
     * `archived`, `groups`, `favorites` and `category` used to be here and are now query
     * predicates above, which is what makes them page. Three things can't be:
     *
     *   unread   — the `$expr` predicate over-matches by one case (see baseFilter), so
     *              the real counts settle it. Nothing is lost, the page is just shorter.
     *   requests — "not someone I follow" lives in the Follow collection, not on the row.
     *   search   — matches peer usernames and group names, which aren't on the row either.
     *
     * The last two mean the *page* is filtered, not the query, so a page can come back
     * empty while later pages have matches. `pageInfo.filteredAfterFetch` says so
     * explicitly rather than leaving the client to guess whether an empty page means
     * "no results" or "keep asking".
     */
    if (unreadOnly === "true" || view === "unread") {
      chatArray = chatArray.filter((c) => c.unreadCount > 0);
    }

    if (view === "requests") {
      chatArray = chatArray.filter((c) => !c.isGroup && !followingSet.has(c.user?._id?.toString()));
    }

    if (search) {
      const q = search.toLowerCase();
      chatArray = chatArray.filter((chat) =>
        chat.isGroup
          ? chat.group?.name?.toLowerCase().includes(q)
          : chat.user?.username?.toLowerCase().includes(q) || chat.user?.name?.toLowerCase().includes(q)
      );
    }

    res.status(200).json({
      chats: chatArray,
      pageInfo: {
        // Same rule as buildCursorPageInfo: never claim there is more without a cursor to
        // ask with, or the client gets a dead "load more".
        hasNextPage: more && nextCursor !== null,
        nextCursor,
        filteredAfterFetch: view === "requests" || Boolean(search),
      },
    });
  } catch (error) {
    console.error("getChats error:", error);
    res.status(500).json({ error: "Failed to fetch chats" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Chat preferences (now in UserSettings)
// ─────────────────────────────────────────────────────────────────────────────

const normalizeCategories = (categories = []) =>
  categories
    .filter((c) => c?.id && c?.name?.trim())
    .map((c, i) => ({ id: c.id, name: c.name.trim(), order: Number.isFinite(c.order) ? c.order : i }))
    .sort((a, b) => a.order - b.order);

const toThemeMap = (rows = []) =>
  rows.reduce((acc, t) => {
    if (t?.chatId && t?.theme) acc[t.chatId] = t.theme;
    return acc;
  }, {});

const buildChatPreferencesResponse = (chat = {}) => ({
  categories: normalizeCategories(chat.customCategories || []),
  categoryAssignments: (chat.categoryAssignments || []).reduce((acc, a) => {
    if (a?.chatId && a?.categoryId) acc[a.chatId] = a.categoryId;
    return acc;
  }, {}),
  favoriteChats:      chat.favoriteChats      || [],
  pinnedChats:        chat.pinnedChats         || [],
  mutedChats:         chat.mutedChats          || [],
  lockedChats:        chat.lockedChats         || [],
  // Whether a PIN exists, never the hash. The client used to infer this from
  // "are any chats locked", which is a different question — unlock everything
  // and it would conclude you had no PIN and silently overwrite it.
  hasLockPin:         Boolean(chat.chatLockPinHash),
  // The account-wide default, and the per-conversation overrides of it. Sent as
  // a map for the same reason categoryAssignments is: the client only ever asks
  // "what is this one chat set to", never iterates.
  theme:              chat.theme               || "system",
  themeByChat: toThemeMap(chat.themeByChat),
  disappearingByChat: chat.disappearingByChat  || [],
});

/** Upsert UserSettings for user; returns the settings doc. */
/**
 * `+chat.chatLockPinHash` is the whole reason chat lock never worked.
 *
 * The field is `select: false`, so a plain findOne never returned it — which
 * made `if (!settings.chat.chatLockPinHash) return 400 "Lock PIN not set"` fire
 * unconditionally, even immediately after setting a PIN. Locking a chat was
 * impossible.
 */
const getOrCreateSettings = async (userId) => {
  let settings = await UserSettings.findOne({ user: userId }).select("+chat.chatLockPinHash");
  if (!settings) settings = await UserSettings.create({ user: userId });
  return settings;
};

export const getChatPreferences = async (req, res) => {
  try {
    const settings = await UserSettings.findOne({ user: req.user.id })
      .select("+chat.chatLockPinHash")
      .lean();
    res.status(200).json(buildChatPreferencesResponse(settings?.chat));
  } catch (error) {
    console.error("getChatPreferences error:", error);
    res.status(500).json({ error: "Failed to fetch chat preferences" });
  }
};

const CHAT_THEMES = ["system", "light", "dark"];

/**
 * With a `chatId` this sets that one conversation's theme; without one it sets
 * the account default, which is all this endpoint used to do. The picker that
 * calls it sits in a per-conversation settings page, so every save from there
 * was silently restyling every other conversation too.
 *
 * `chatId` stays optional so callers that only ever meant the account default —
 * and any client still on the old one-argument call — keep working unchanged.
 */
export const updateChatTheme = async (req, res) => {
  try {
    const { theme, chatId } = req.body;
    if (!CHAT_THEMES.includes(theme)) return res.status(400).json({ error: "theme must be system, light, or dark" });

    const settings = await getOrCreateSettings(req.user.id);

    if (chatId === undefined || chatId === null || chatId === "") {
      settings.chat.theme = theme;
      await settings.save();
      return res.status(200).json({
        chatId: null,
        theme: settings.chat.theme,
        themeByChat: toThemeMap(settings.chat.themeByChat),
      });
    }

    const key = parseChatId(chatId);
    if (!key) return res.status(400).json({ error: "Invalid chatId" });

    const list = [...(settings.chat.themeByChat || [])];
    if (atPreferenceCap(list, key)) return res.status(400).json(PREFERENCE_LIST_FULL);

    // Case-insensitive match so a legacy uppercase entry is *replaced* rather than
    // shadowed by a second row for the same conversation. See sameChatId.
    const idx = list.findIndex((x) => sameChatId(x, key));
    if (idx !== -1) list[idx] = { chatId: key, theme };
    else list.push({ chatId: key, theme });

    settings.chat.themeByChat = list;
    await settings.save();

    res.status(200).json({ chatId: key, theme, themeByChat: toThemeMap(list) });
  } catch (error) {
    console.error("updateChatTheme error:", error);
    res.status(500).json({ error: "Failed to update theme" });
  }
};

export const setDisappearingForChat = async (req, res) => {
  try {
    const chatId = parseChatId(req.params.chatId);
    if (!chatId) return res.status(400).json({ error: "Invalid chatId" });

    let seconds = req.body?.seconds;
    if (seconds === "" || seconds === undefined) seconds = null;
    else if (seconds !== null) {
      seconds = Number(seconds);
      // Whole seconds, bounded. It stored fractions and arbitrarily large
      // values before, and the cap was only ever checked against the client's
      // per-message override — never against the stored setting that the send
      // path now actually reads.
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_TTL_SECONDS) {
        return res.status(400).json({ error: "That duration isn't supported" });
      }
      if (seconds === 0) seconds = null;
    }

    const settings = await getOrCreateSettings(req.user.id);
    const list = [...(settings.chat.disappearingByChat || [])];
    if (seconds !== null && atPreferenceCap(list, chatId)) {
      return res.status(400).json(PREFERENCE_LIST_FULL);
    }
    // Case-insensitive, so a legacy uppercase entry can be turned off — see
    // sameChatId in utils/chatPreferences.js.
    const idx = list.findIndex((x) => sameChatId(x, chatId));

    if (seconds === null) { if (idx !== -1) list.splice(idx, 1); }
    else if (idx !== -1) list[idx] = { chatId, seconds };
    else list.push({ chatId, seconds });

    settings.chat.disappearingByChat = list;
    await settings.save();

    res.status(200).json({ chatId, seconds, disappearingByChat: list });
  } catch (error) {
    console.error("setDisappearingForChat error:", error);
    res.status(500).json({ error: "Failed to update disappearing messages" });
  }
};

export const createChatCategory = async (req, res) => {
  try {
    const name = (typeof req.body?.name === "string" ? req.body.name : "").trim();
    if (!name) return res.status(400).json({ error: "Category name is required" });
    // The schema caps this at 30, and a violation there surfaces through the
    // generic catch as a 500. Over-long is a client mistake and gets a 400 that
    // says which field and what the limit is.
    if (name.length > MAX_CATEGORY_NAME) {
      return res.status(400).json({
        error: `Category name must be ${MAX_CATEGORY_NAME} characters or fewer`,
      });
    }

    const settings = await getOrCreateSettings(req.user.id);
    const categories = normalizeCategories(settings.chat?.customCategories || []);

    if (categories.length >= MAX_CATEGORIES) {
      return res.status(400).json({ error: `You can have up to ${MAX_CATEGORIES} categories` });
    }
    if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: "Category already exists" });
    }

    categories.push({ id: uuidv4(), name, order: categories.length });
    settings.chat.customCategories = categories;
    await settings.save();

    res.status(201).json({ categories: normalizeCategories(settings.chat.customCategories) });
  } catch (error) {
    console.error("createChatCategory error:", error);
    res.status(500).json({ error: "Failed to create chat category" });
  }
};

export const reorderChatCategories = async (req, res) => {
  try {
    const orderedIds = Array.isArray(req.body?.orderedCategoryIds) ? req.body.orderedCategoryIds : [];
    if (!orderedIds.length) return res.status(400).json({ error: "orderedCategoryIds is required" });

    const settings = await getOrCreateSettings(req.user.id);
    const existing = normalizeCategories(settings.chat?.customCategories || []);
    const byId = new Map(existing.map((c) => [c.id, c]));

    /*
     * A reorder is a permutation: same set, different order. The guard used to
     * compare lengths, which a duplicate satisfies — ["A","A"] against [A,B] is
     * two ids for two categories, so it passed, saved A twice and silently
     * dropped B along with every chat assigned to it. Comparing the set of ids
     * is the check that was meant.
     */
    const uniqueIds = new Set(orderedIds.filter((id) => typeof id === "string"));
    const sameSet =
      uniqueIds.size === orderedIds.length &&
      uniqueIds.size === existing.length &&
      existing.every((c) => uniqueIds.has(c.id));

    if (!sameSet) {
      return res.status(400).json({
        error: "orderedCategoryIds must list every existing category exactly once",
      });
    }

    const reordered = orderedIds.map((id, i) => ({ ...byId.get(id), order: i }));

    settings.chat.customCategories = reordered;
    await settings.save();

    res.status(200).json({ categories: normalizeCategories(settings.chat.customCategories) });
  } catch (error) {
    console.error("reorderChatCategories error:", error);
    res.status(500).json({ error: "Failed to reorder chat categories" });
  }
};

export const deleteChatCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const settings = await getOrCreateSettings(req.user.id);

    settings.chat.customCategories = normalizeCategories(settings.chat?.customCategories || [])
      .filter((c) => c.id !== categoryId)
      .map((c, i) => ({ ...c, order: i }));

    settings.chat.categoryAssignments = (settings.chat?.categoryAssignments || []).filter(
      (a) => a.categoryId !== categoryId
    );

    await settings.save();
    res.status(200).json(buildChatPreferencesResponse(settings.chat));
  } catch (error) {
    console.error("deleteChatCategory error:", error);
    res.status(500).json({ error: "Failed to delete chat category" });
  }
};

export const assignChatCategory = async (req, res) => {
  try {
    const chatId = parseChatId(req.params.chatId);
    if (!chatId) return res.status(400).json({ error: "Invalid chatId" });

    const categoryId =
      typeof req.body?.categoryId === "string" && req.body.categoryId
        ? req.body.categoryId
        : null;

    const settings = await getOrCreateSettings(req.user.id);
    const validIds = new Set(normalizeCategories(settings.chat?.customCategories || []).map((c) => c.id));
    if (categoryId && !validIds.has(categoryId)) return res.status(400).json({ error: "Invalid categoryId" });

    const existing = settings.chat?.categoryAssignments || [];
    if (categoryId && atPreferenceCap(existing, chatId)) {
      return res.status(400).json(PREFERENCE_LIST_FULL);
    }

    const assignments = withoutChatId(existing, chatId);
    if (categoryId) assignments.push({ chatId, categoryId });
    settings.chat.categoryAssignments = assignments;
    await settings.save();

    res.status(200).json({ chatId, categoryId, categoryAssignments: buildChatPreferencesResponse(settings.chat).categoryAssignments });
  } catch (error) {
    console.error("assignChatCategory error:", error);
    res.status(500).json({ error: "Failed to assign chat category" });
  }
};

export const toggleFavoriteChat = async (req, res) => {
  try {
    const chatId = parseChatId(req.params.chatId);
    if (!chatId) return res.status(400).json({ error: "Invalid chatId" });

    const settings = await getOrCreateSettings(req.user.id);

    /*
     * Removal is case-insensitive, insertion is canonical.
     *
     * A Set keyed on the raw string couldn't remove a legacy uppercase entry — the
     * lowercased id simply wasn't in it — so unfavouriting silently did nothing and
     * the entry was stuck. See sameChatId.
     */
    const existing = settings.chat?.favoriteChats || [];
    const wasFavorite = existing.some((id) => sameChatId(id, chatId));
    let isFavorite = false;

    if (wasFavorite) {
      settings.chat.favoriteChats = withoutChatId(existing, chatId);
    } else {
      if (atPreferenceCap(existing, chatId)) {
        return res.status(400).json(PREFERENCE_LIST_FULL);
      }
      settings.chat.favoriteChats = [...existing, chatId];
      isFavorite = true;
    }
    await settings.save();

    res.status(200).json({ chatId, isFavorite, favoriteChats: settings.chat.favoriteChats });
  } catch (error) {
    console.error("toggleFavoriteChat error:", error);
    res.status(500).json({ error: "Failed to toggle favorite chat" });
  }
};

// `hide` is deliberately absent: nothing ever filtered on it, there was no
// "hidden" view to get a chat back from, and the menu item has been removed.
// Archive does that job and has a tab. UserSettings.hiddenChats stays so old
// documents still load.
const CHAT_STATE_FIELDS = {
  favorite: "favoriteChats",
  pin:      "pinnedChats",
  mute:     "mutedChats",
  lock:     "lockedChats",
};

export const updateChatState = async (req, res) => {
  try {
    const chatId = parseChatId(req.params.chatId);
    if (!chatId) return res.status(400).json({ error: "Invalid chatId" });

    const { stateKey, nextState, pin = "" } = req.body;

    // Read and unread aren't flags any more, they're the watermark.
    //
    // They used to be two arrays: opening a chat added it to `forcedReadChats`,
    // which zeroed its unread count and was only ever cleared by an explicit
    // mark-as-unread. So a chat you had opened once could never show a badge
    // again, and "Mark as read" — which only removed a *manual* unread flag —
    // did nothing at all to a genuinely unread thread.
    if (stateKey === "read" || stateKey === "unread") {
      const conversation = conversationForChatId(chatId, req.user._id);
      if (!conversation) return res.status(400).json({ error: "Invalid chatId" });

      const wantUnread = stateKey === "unread" ? nextState !== false : nextState === false;

      let unreadCount = 0;
      if (wantUnread) {
        const marked = await markConversationUnread(req.user._id, conversation);
        if (!marked) return res.status(400).json({ error: "Nothing to mark unread here" });
        unreadCount = marked.unreadCount;
      } else {
        const readAt = await markConversationRead(req.user._id, conversation);
        await notifyConversationRead({ io: getIO(), userId: req.user._id, conversation, readAt });
      }

      const current = await UserSettings.findOne({ user: req.user.id })
        .select("+chat.chatLockPinHash")
        .lean();
      return res.status(200).json({
        chatId,
        stateKey,
        enabled: wantUnread,
        // The real count, not the 1 the client used to assume. The watermark lands
        // a millisecond before the newest inbound message, so anything sharing that
        // millisecond is unread too (CF8).
        unreadCount,
        ...buildChatPreferencesResponse(current?.chat),
      });
    }

    if (typeof stateKey !== "string" || !CHAT_STATE_FIELDS[stateKey]) {
      return res.status(400).json({ error: "Invalid chatId/stateKey" });
    }

    const settings = await getOrCreateSettings(req.user.id);

    if (stateKey === "lock") {
      if (!settings.chat.chatLockPinHash) return res.status(400).json({ error: "Lock PIN not set" });
      const valid = await bcrypt.compare(String(pin), settings.chat.chatLockPinHash);
      if (!valid) return res.status(403).json({ error: "Invalid PIN" });
    }

    const field = CHAT_STATE_FIELDS[stateKey];
    const existing = settings.chat[field] || [];
    // Case-insensitive, so a legacy uppercase entry is still removable — see
    // sameChatId. Insertion always stores the canonical form.
    const isSet = existing.some((id) => sameChatId(id, chatId));
    const shouldEnable = typeof nextState === "boolean" ? nextState : !isSet;
    if (shouldEnable && atPreferenceCap(existing, chatId)) {
      return res.status(400).json(PREFERENCE_LIST_FULL);
    }
    settings.chat[field] = shouldEnable
      ? [...withoutChatId(existing, chatId), chatId]
      : withoutChatId(existing, chatId);

    await settings.save();
    res.status(200).json({ chatId, stateKey, enabled: shouldEnable, ...buildChatPreferencesResponse(settings.chat) });
  } catch (error) {
    console.error("updateChatState error:", error);
    res.status(500).json({ error: "Failed to update chat state" });
  }
};

export const setChatLockPin = async (req, res) => {
  try {
    const pin = String(req.body?.pin || "");
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4-8 digits" });

    const settings = await getOrCreateSettings(req.user.id);

    // Changing an existing PIN requires the current one. Without this, anyone
    // holding the session could silently reset the lock — which defeats the
    // point of having a second factor in front of a conversation at all.
    if (settings.chat.chatLockPinHash) {
      const currentPin = String(req.body?.currentPin || "");
      if (!currentPin) return res.status(400).json({ error: "Enter your current PIN" });
      const valid = await bcrypt.compare(currentPin, settings.chat.chatLockPinHash);
      if (!valid) return res.status(403).json({ error: "That PIN isn't right" });
    }

    settings.chat.chatLockPinHash = await bcrypt.hash(pin, 10);
    await settings.save();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("setChatLockPin error:", error);
    res.status(500).json({ error: "Failed to set PIN" });
  }
};

/**
 * Prove the PIN for one locked conversation, and get a grant that opens it.
 *
 * The lock used to be enforced entirely in the client: the list refused to open
 * a locked row and the chat list withheld its preview, but `GET
 * /chats/messages/<username>` returned the whole thread to anyone who typed the
 * URL. So the feature stopped a person holding your unlocked phone and stopped
 * nobody else.
 *
 * The PIN can't be checked on the read path itself — the thread is fetched on
 * open, on every page of history, and by four other endpoints — so it is proved
 * once here and the reads verify a short-lived signed grant instead. See
 * utils/chatLock.js for what the grant is bound to and why.
 *
 * The client used to reach this by calling `PUT /preferences/state/:chatId` with
 * `nextState` set to the value it already had, purely to make the server compare
 * the PIN. That worked but it was a write pretending to be a question, and it
 * had no way to return anything the read paths could use.
 */
export const verifyChatLockPin = async (req, res) => {
  try {
    const chatId = parseChatId(req.body?.chatId);
    if (!chatId) return res.status(400).json({ error: "Invalid chatId" });

    const settings = await getOrCreateSettings(req.user.id);
    if (!settings.chat.chatLockPinHash) {
      return res.status(400).json({ error: "Lock PIN not set" });
    }
    // Nothing to unlock is not the same as a wrong PIN, and saying so doesn't
    // leak anything: the caller owns this list and can read it from
    // GET /preferences.
    if (!(settings.chat.lockedChats || []).includes(chatId)) {
      return res.status(400).json({ error: "That chat isn't locked" });
    }

    const valid = await bcrypt.compare(String(req.body?.pin || ""), settings.chat.chatLockPinHash);
    if (!valid) return res.status(403).json({ error: "Invalid PIN" });

    const { grant, expiresAt } = issueUnlockGrant(req.user.id, chatId);
    res.status(200).json({ chatId, grant, expiresAt });
  } catch (error) {
    console.error("verifyChatLockPin error:", error);
    res.status(500).json({ error: "Failed to unlock chat" });
  }
};

/**
 * Forgotten PIN: clear it, and unlock everything it was protecting.
 *
 * There was no way out of this. `setChatLockPin` requires the current PIN to
 * set a new one — correct, since a session alone shouldn't be able to reset the
 * second factor — but that made a forgotten PIN permanent: those conversations
 * were unreachable for the life of the account, with no reset anywhere.
 *
 * The account password is the escalation. It's the credential the PIN sits
 * behind in the first place, so requiring it doesn't weaken the lock: anyone
 * who has it could read the chats by other means already.
 *
 * The locked list is cleared along with the hash. Leaving chats marked locked
 * with no PIN in existence would be a state nothing can open — the same dead
 * end one level down.
 */
export const resetChatLockPin = async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    if (!password) return res.status(400).json({ error: "Enter your password" });

    const user = await User.findById(req.user.id).select("+password");
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!(await user.comparePassword(password))) {
      return res.status(403).json({ error: "That password isn't right" });
    }

    const settings = await getOrCreateSettings(req.user.id);
    const unlocked = (settings.chat.lockedChats || []).length;
    settings.chat.chatLockPinHash = "";
    settings.chat.lockedChats = [];
    await settings.save();

    res.status(200).json({ success: true, unlocked });
  } catch (error) {
    console.error("resetChatLockPin error:", error);
    res.status(500).json({ error: "Failed to reset PIN" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────────────

export const getUserGroups = async (req, res) => {
  try {
    /*
     * Cursor-paged on `joinedAt`, which `{user, joinedAt}` serves.
     *
     * A flat limit bounded the response but wasn't pagination: a member of more
     * than a hundred groups simply could not reach the rest, with nothing in the
     * response to say so. (`populate({match})` was worse still — it filtered after
     * the fetch, so a membership pointing at a deleted group came back as `null`
     * and was dropped in JavaScript, making the size unpredictable.)
     */
    const limitNum = parseCursorLimit(req.query.limit, 100);
    const parsedCursor = decodeCursor(queryString(req.query.cursor));

    const memberships = await GroupMember.find(
      withCursor(
        { user: req.user.id, isBanned: { $ne: true } },
        parsedCursor && { ...parsedCursor, field: "joinedAt" }
      )
    )
      .select("group joinedAt")
      .sort({ joinedAt: -1, _id: -1 })
      .limit(limitNum + 1)
      .lean();

    const { items, pageInfo } = buildCursorPageInfo(memberships, limitNum, "joinedAt");

    const groups = await Group.find({
      _id: { $in: items.map((m) => m.group) },
      isActive: { $ne: false },
      isDeleted: { $ne: true },
    })
      .select("name avatar counts description createdAt")
      .lean();

    /*
     * Ordered the way the memberships were, not the way Mongo returned the
     * groups. The page boundary is a membership `joinedAt`, so a client appending
     * pages needs the rows in that same order or the list reshuffles on every
     * "load more".
     */
    const byId = new Map(groups.map((g) => [g._id.toString(), g]));
    const ordered = items.map((m) => byId.get(m.group.toString())).filter(Boolean);

    res.status(200).json({ groups: ordered, pageInfo, hasMore: pageInfo.hasNextPage });
  } catch (error) {
    console.error("getUserGroups error:", error);
    res.status(500).json({ error: "Failed to fetch user groups" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Archive / Delete chat
// ─────────────────────────────────────────────────────────────────────────────

export const archiveChat = async (req, res) => {
  try {
    const chatId = parseChatId(req.params.chatId);
    if (!chatId) return res.status(400).json({ error: "Invalid chat id" });

    /*
     * `archive` arrives as JSON, but a form post or a hand-rolled fetch sends
     * the string "false", which is truthy — so unarchiving archived instead.
     * Only an explicit false (boolean or string) means unarchive.
     */
    const raw = req.body?.archive;
    const archive = !(raw === false || raw === "false");

    const settings = await getOrCreateSettings(req.user.id);
    const list = settings.chat.archivedChats || [];

    if (archive) {
      if (atPreferenceCap(list, chatId)) {
        return res.status(400).json(PREFERENCE_LIST_FULL);
      }
      if (!list.some((c) => sameChatId(c, chatId))) {
        list.push({ chatId, archivedAt: new Date() });
      }
      settings.chat.archivedChats = list;
    } else {
      // Case-insensitive, so a legacy uppercase entry can be unarchived.
      settings.chat.archivedChats = withoutChatId(list, chatId);
    }

    await settings.save();

    res.status(200).json({ message: archive ? "Chat archived" : "Chat unarchived", archived: archive });
  } catch (error) {
    console.error("archiveChat error:", error);
    res.status(500).json({ error: "Failed to archive chat" });
  }
};

export const deleteChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const receiver = await User.findOne({ username: req.params.username }).select("_id").lean();
    if (!receiver) return res.status(404).json({ error: "User not found" });

    /*
     * Deleting a locked chat needs the PIN too.
     *
     * The lock's threat model is someone holding an unlocked session, and letting
     * them destroy the conversation without the PIN is worse than letting them read
     * it: reading is recoverable, this isn't. It's a write rather than a read, which
     * is why it wasn't in the original five, but it's the same boundary.
     */
    if (await answeredLocked(req, res, userId, `user_${receiver._id}`)) return;

    const conversationKey = Message.dmConversationKey(userId, receiver._id);

    // Soft delete: add viewer to deletedFor (now plain ObjectId[])
    await Message.updateMany(
      { conversation: conversationKey },
      { $addToSet: { deletedFor: userId } }
    );

    /*
     * Purge the chat from every per-chat list, not just the archived one.
     *
     * Deleting a chat that was pinned used to leave it pinned: the row vanished
     * until the next message arrived, then reappeared at the top of the list
     * still carrying its old mute, category and disappearing-timer settings.
     * Deleting is the one action that should leave nothing behind.
     */
    const settings = await UserSettings.findOne({ user: userId });
    if (settings) {
      const chatId = `user_${receiver._id}`;
      const chat = settings.chat;

      /*
       * Case-insensitively, and including `themeByChat`.
       *
       * Two bugs in one line. `themeByChat` was added in 8b and never added here,
       * so a per-chat theme survived the chat being deleted — and now also consumed
       * one of the MAX_PREFERENCE_ENTRIES slots forever.
       *
       * And the comparison has to ignore case. The writers canonicalise to
       * lowercase now, but any entry written before that could be uppercase hex —
       * and an exact-match filter would never find it, so the one action that is
       * supposed to leave nothing behind would leave an entry that no UI can see
       * and nothing can ever remove.
       */
      const matches = (value) => String(value || "").toLowerCase() === chatId;

      for (const key of ["favoriteChats", "pinnedChats", "mutedChats", "lockedChats", "hiddenChats"]) {
        chat[key] = (chat[key] || []).filter((id) => !matches(id));
      }
      for (const key of [
        "archivedChats",
        "categoryAssignments",
        "disappearingByChat",
        "themeByChat",
      ]) {
        chat[key] = (chat[key] || []).filter((entry) => !matches(entry?.chatId));
      }

      await settings.save();
    }

    res.status(200).json({ message: "Chat deleted successfully" });
  } catch (error) {
    console.error("deleteChat error:", error);
    res.status(500).json({ error: "Failed to delete chat" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Message operations
// ─────────────────────────────────────────────────────────────────────────────

export const unsendMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    // 404 rather than 403 for someone else's message: the distinct status would
    // otherwise confirm which ids exist, and message ids are guessable.
    if (!message || message.sender.toString() !== req.user.id) {
      return res.status(404).json({ error: "Message not found" });
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (message.createdAt < oneHourAgo) return res.status(403).json({ error: "Cannot unsend messages older than 1 hour" });

    message.isDeleted = true;
    message.content = "This message was deleted";
    message.media = [];
    /*
     * The thread read now returns tombstones rather than filtering them, so
     * everything else that carries content has to go too — otherwise unsending
     * a poll left the question and the running tally on screen, and unsending
     * a shared post left its snapshot.
     */
    message.poll = undefined;
    message.sharedContent = undefined;
    /*
     * And it stops being pinned.
     *
     * A tombstone stayed pinned, which meant it occupied one of the conversation's
     * pin slots while being invisible in the pinned list — five of those and nobody
     * in that conversation could pin anything again, with no way to unpin what they
     * couldn't see.
     */
    message.isPinned = false;
    message.pinnedAt = null;
    message.pinnedBy = null;
    /*
     * Reactions go too.
     *
     * A tombstone kept every MessageReaction row pointing at it plus a non-zero
     * cached `reactionSummary`, so "This message was deleted" rendered with three
     * hearts under it, and the rows stayed in the collection referencing content
     * that no longer exists. Nothing else in the repo cascades off a chat model —
     * this is the first of them; see also scripts/pruneOrphanedChatRows.js for the
     * rows the ephemeral TTL leaves behind, which no application hook can catch.
     */
    await message.clearReactions();
    await message.save();

    const io = getIO();
    io.to(conversationRoom(message)).emit("messageUnsent", {
      messageId: message._id,
      // So the client clears the reaction row it is still rendering rather than
      // waiting for a reload.
      reactionSummary: message.reactionSummary,
    });

    res.status(200).json({ message: "Message unsent successfully" });
  } catch (error) {
    console.error("unsendMessage error:", error);
    res.status(500).json({ error: "Failed to unsend message" });
  }
};

export const deleteMessageForMe = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.messageId)) {
      return res.status(404).json({ error: "Message not found" });
    }

    const message = await Message.findById(req.params.messageId);
    // Participation matters here even though hiding someone else's message does
    // the caller no good: `deletedFor` is an uncapped array on a document read
    // by the busiest query in the app, so letting anyone push into any message
    // is a way to inflate the collection toward the BSON ceiling. 404 rather
    // than 403 so the endpoint isn't a message-existence oracle either.
    if (!message || !(await isMessageParticipant(message, req.user.id))) {
      return res.status(404).json({ error: "Message not found" });
    }

    await message.softDeleteForUser(req.user.id);
    res.status(200).json({ message: "Message deleted successfully" });
  } catch (error) {
    console.error("deleteMessageForMe error:", error);
    res.status(500).json({ error: "Failed to delete message" });
  }
};

export const editMessage = async (req, res) => {
  try {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return res.status(400).json({ error: "Content cannot be empty" });
    // Message.content's maxlength. Without this the schema rejects the save and
    // the generic catch reports it as a 500 — the client's mistake looking like
    // the server's fault.
    if (content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: "That message is too long" });
    }

    const message = await Message.findById(req.params.messageId);
    if (!message || message.sender.toString() !== req.user.id) {
      return res.status(404).json({ error: "Message not found" });
    }
    if (message.isDeleted) {
      // Otherwise an edit overwrites "This message was deleted" with new text
      // and the tombstone speaks again. The socket path already refused this.
      return res.status(403).json({ error: "This message was deleted" });
    }
    if (!EDITABLE_MESSAGE_TYPES.has(message.messageType)) {
      return res.status(400).json({ error: "This kind of message can't be edited" });
    }

    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    if (message.createdAt < fifteenMinutesAgo) return res.status(403).json({ error: "Cannot edit messages older than 15 minutes" });

    await message.editContent(content);

    const io = getIO();
    io.to(conversationRoom(message)).emit("messageEdited", { messageId: message._id, content: message.content, editedAt: message.editedAt });

    res.status(200).json({
      message: "Message edited successfully",
      data: { content: message.content, editedAt: message.editedAt, isEdited: message.isEdited },
    });
  } catch (error) {
    console.error("editMessage error:", error);
    res.status(500).json({ error: "Failed to edit message" });
  }
};

export const toggleReaction = async (req, res) => {
  try {
    const userId = req.user.id;
    /*
     * Validated, not merely present.
     *
     * `if (!emoji)` was the whole check, so any string of any length was stored,
     * cached into the message's reactionSummary and rebroadcast to the room on
     * every later reaction. See utils/reactions.js.
     */
    const emoji = parseReactionEmoji(req.body?.emoji);
    if (!emoji) return res.status(400).json({ error: "That isn't an emoji" });
    const skinTone = parseSkinTone(req.body?.skinTone);

    const message = await Message.findById(req.params.messageId);
    if (!message || !(await isMessageParticipant(message, userId))) {
      return res.status(404).json({ error: "Message not found" });
    }

    const existing = await MessageReaction.findOne({ message: message._id, user: userId });
    if (existing && existing.emoji === emoji) {
      await message.removeReaction(userId);
    } else {
      await message.addReaction(userId, emoji, skinTone);
    }

    // Reload summary
    const updatedMsg = await Message.findById(message._id).select("reactionSummary").lean();

    const io = getIO();
    io.to(conversationRoom(message)).emit("messageReaction", { messageId: message._id, userId, emoji: existing?.emoji === emoji ? null : emoji, skinTone, reactionSummary: updatedMsg.reactionSummary });

    res.status(200).json({ message: "Reaction updated", reactionSummary: updatedMsg.reactionSummary });
  } catch (error) {
    console.error("toggleReaction error:", error);
    res.status(500).json({ error: "Failed to update reaction" });
  }
};

/**
 * Copy a message into other conversations.
 *
 * This used to check one thing — that the message existed. It didn't check that
 * the caller could see it, which made the endpoint a read primitive over the
 * whole Message collection: forward any id to yourself and the reply came back
 * with the content and media URLs of a conversation you were never in. It also
 * skipped `whoCanMessage` entirely, so forwarding was a way around a privacy
 * setting the send path enforces, and it shipped `sharedContent.snapshot` raw.
 *
 * Failures are now collected per target instead of throwing, so one bad id in a
 * list of twenty no longer 500s after half the recipients already received it.
 */
export const forwardMessage = async (req, res) => {
  try {
    const userId = req.user._id;
    const recipients = cleanIds(req.body?.receiverIds, { exclude: userId });
    const groups = cleanIds(req.body?.groupIds);

    if (!recipients.length && !groups.length) {
      // Distinguish "you gave me nothing" from "the only person you picked was
      // yourself, which cleanIds filtered out" — the second used to report the
      // first, which reads as a bug to anyone who just chose a recipient.
      const askedForSelf = cleanIds(req.body?.receiverIds).length > 0;
      return res.status(400).json({
        error: askedForSelf
          ? "You can't forward a message to yourself"
          : "Receiver IDs or Group IDs are required",
      });
    }
    if (recipients.length + groups.length > MAX_RECIPIENTS) {
      return res
        .status(400)
        .json({ error: `You can forward to up to ${MAX_RECIPIENTS} at once` });
    }
    if (!mongoose.isValidObjectId(req.params.messageId)) {
      return res.status(404).json({ error: "Message not found" });
    }

    const originalMessage = await Message.findById(req.params.messageId);
    // 404 rather than 403 for a message the caller isn't part of: a distinct
    // status would confirm which ids exist, and message ids are guessable.
    if (!originalMessage || !(await canSeeMessage(originalMessage, userId))) {
      return res.status(404).json({ error: "Message not found" });
    }

    /*
     * Forwarding is a read of the source conversation.
     *
     * Copying a message out of a locked chat returns its content in the response,
     * so this is the same boundary as the thread endpoint and needs the same grant
     * — otherwise the lock is bypassed one message at a time by anyone who knows
     * an id.
     */
    const sourceChatId = chatIdForConversation(originalMessage.conversation, userId);
    if (sourceChatId && (await answeredLocked(req, res, userId, sourceChatId))) return;

    const io = getIO();
    const results = { sent: [], failed: [] };

    const copyFields = {
      content: originalMessage.content,
      media: originalMessage.media,
      messageType: originalMessage.messageType,
      // Carry the payload, or forwarding a shared post produces a message
      // typed post_share with nothing in it — an empty bubble.
      sharedContent: originalMessage.sharedContent,
      isForwarded: true,
      forwardedFrom: {
        userId: originalMessage.sender,
        originalMessageId: originalMessage._id,
        /*
         * How far down the chain this copy sits.
         *
         * Copies were created with 0 unconditionally, so a forward of a forward
         * looked exactly like a forward of an original and a chain never
         * accumulated — there was no way to derive "forwarded many times", which
         * is the only thing this number is for.
         */
        forwardCount: (originalMessage.forwardedFrom?.forwardCount ?? 0) + 1,
      },
      // Ephemerality travels with the copy. Without this, forwarding was a way
      // to turn a disappearing message into a permanent one — the copy outlived
      // the original the sender expected to vanish.
      ...(originalMessage.isEphemeral
        ? {
            isEphemeral: true,
            selfDestructSeconds: originalMessage.selfDestructSeconds,
            // The copy inherits what's *left*, not a fresh lifetime — a
            // forward of a message with five seconds on it shouldn't live for
            // another day.
            expiresAt: originalMessage.expiresAt || null,
          }
        : {}),
    };

    // ── Direct messages ─────────────────────────────────────────────────────
    if (recipients.length) {
      const objectIds = recipients.map((id) => new mongoose.Types.ObjectId(id));

      const [existing, blocked, messageable] = await Promise.all([
        User.find({ _id: { $in: objectIds }, ...ACTIVE_ACCOUNT })
          .select("_id username")
          .lean(),
        blockedIdSet(userId, objectIds),
        messageableIdSet(userId, objectIds),
      ]);
      const byId = new Map(existing.map((u) => [u._id.toString(), u]));

      for (const id of recipients) {
        const user = byId.get(id);
        if (!user) {
          results.failed.push({ id, reason: "Account unavailable" });
          continue;
        }
        if (blocked.has(id)) {
          results.failed.push({ id, username: user.username, reason: "Can't message this account" });
          continue;
        }
        if (!messageable.has(id)) {
          results.failed.push({
            id,
            username: user.username,
            reason: "They don't accept messages from you",
          });
          continue;
        }

        const fwd = await Message.create({
          sender: userId,
          receiver: user._id,
          conversation: Message.dmConversationKey(userId, user._id),
          ...copyFields,
        });
        await fwd.populate("sender", "username name profilePic isVerified");

        // Resolved for *this* recipient before it leaves the server, so a
        // private post they can't see arrives locked rather than in the clear.
        const forRecipient = JSON.parse(JSON.stringify(fwd.toObject()));
        await attachSharedContent([forRecipient], user._id);
        io.to(id).emit("receiveMessage", { ...forRecipient, isOwn: false });

        results.sent.push({ id, username: user.username });
      }
    }

    // ── Groups ──────────────────────────────────────────────────────────────
    for (const groupId of groups) {
      // Media rides along in the copy, so the group's media rules apply to a
      // forward exactly as they do to an ordinary send.
      const access = await resolveGroupSend(groupId, userId, { media: copyFields.media });
      if (!access.ok) {
        results.failed.push({ id: groupId, reason: access.reason });
        continue;
      }

      const fwd = await Message.create({
        sender: userId,
        group: groupId,
        isGroupMessage: true,
        conversation: Message.groupConversationKey(groupId),
        ...copyFields,
      });
      await fwd.populate("sender", "username name profilePic isVerified");

      // One emit reaches every member, so it can't be resolved per reader.
      // Strip it to a marker; each client gets the real card, evaluated
      // against them, on its next thread fetch.
      // Split so the forwarder's own copy is flagged as theirs. io.to includes
      // the sender, and without isOwn the client counts your own forward as an
      // unread message in that group.
      const outgoing = stripSharedSnapshot(fwd.toObject());
      io.to(groupId).except(userId.toString()).emit("receiveGroupMessage", outgoing);
      io.to(userId.toString()).emit("receiveGroupMessage", { ...outgoing, isOwn: true });

      results.sent.push({ id: groupId, isGroup: true });
    }

    const forwardedCount = results.sent.length;
    if (forwardedCount > 0) {
      /*
       * The original's own `forwardCount`, not its `forwardedFrom.forwardCount`.
       *
       * This used to `$inc` the latter, which describes where a message came
       * *from* — so forwarding an ordinary message gave it a `forwardedFrom` block
       * containing a count and nothing else: no `userId`, no
       * `originalMessageId`. Every read path then saw a message that claimed to be
       * a forward of nothing, and `isForwarded` said otherwise.
       */
      await Message.updateOne(
        { _id: originalMessage._id },
        { $inc: { forwardCount: forwardedCount } }
      );
    }

    res.status(200).json({
      message: forwardedCount ? "Message forwarded successfully" : "Couldn't forward to anyone",
      forwardedCount,
      ...results,
    });
  } catch (error) {
    console.error("forwardMessage error:", error);
    res.status(500).json({ error: "Failed to forward message" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Read receipts / unread counts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark a conversation read up to now.
 *
 * This used to load every matching message, flip `status` on all of them, and
 * upsert one receipt row each. For a thread with fifty thousand unread that was
 * fifty thousand hydrated documents and a hundred thousand writes, all
 * triggerable on demand. It is now a single upsert of one timestamp.
 *
 * `messageIds` is still accepted for compatibility, but a watermark can only
 * express "read up to here" — marking one message read necessarily marks
 * everything before it read, which is what opening a thread does anyway.
 */
export const markMessagesAsRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const { senderId, groupId, messageIds } = req.body;

    let conversation = null;

    if (groupId) {
      if (!(await isGroupMember(groupId, userId))) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      conversation = Message.groupConversationKey(groupId);
    } else if (senderId) {
      if (!mongoose.isValidObjectId(senderId)) {
        return res.status(400).json({ error: "Invalid senderId" });
      }
      // Derived from the caller, so it can only ever address a conversation
      // they are half of.
      conversation = Message.dmConversationKey(userId, senderId);
    } else if (messageIds?.length) {
      const ids = cleanIds(messageIds);
      if (!ids.length) return res.status(400).json({ error: "No valid message ids" });
      const newest = await Message.findOne({ _id: { $in: ids } })
        .sort({ createdAt: -1 })
        .select("conversation createdAt")
        .lean();
      if (!newest) return res.status(404).json({ error: "Message not found" });
      // Participation still has to hold: without it, marking a stranger's
      // message read would advance a watermark in their conversation.
      if (!(await isMessageParticipant(newest, userId))) {
        return res.status(404).json({ error: "Message not found" });
      }
      conversation = newest.conversation;
    } else {
      return res.status(400).json({ error: "senderId, groupId, or messageIds required" });
    }

    const readAt = await markConversationRead(userId, conversation);
    await notifyConversationRead({ io: getIO(), userId, conversation, readAt });

    res.status(200).json({ message: "Messages marked as read", conversation, readAt });
  } catch (error) {
    console.error("markMessagesAsRead error:", error);
    res.status(500).json({ error: "Failed to mark messages as read" });
  }
};

/**
 * How many conversations the badge will look inside.
 *
 * `unreadCountsByConversation` builds one `$or` clause per conversation, so this is a
 * real bound on the query it produces, not a display limit. Well past any plausible
 * number of simultaneously-unread threads — and when it does bite, the response says so
 * rather than quietly under-reporting.
 */
const MAX_UNREAD_CONVERSATIONS = 500;

/**
 * Total unread, and the per-conversation breakdown the chat list badge needs.
 *
 * The old version materialised every unread message with two populates and
 * counted them in JavaScript. This is one aggregation.
 */
export const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user._id;

    /*
     * Only the conversations that can *possibly* have unread.
     *
     * This used to start from `Message.distinct("conversation", {receiver: userId})` —
     * every DM the user had ever received, unbounded, against a 16MB result ceiling —
     * unioned with every watermark row, and then asked for counts across all of it. Since
     * unread is `createdAt > lastReadAt`, a conversation whose newest message is not
     * newer than the watermark cannot contribute, and the row now records both. So the
     * candidate set is one indexed read of the user's own rows with that comparison
     * applied, and the expensive count runs over a set that is already small.
     *
     * `$expr` over-matches by one case (newest message is the caller's own), which the
     * counts below resolve — an over-match costs a clause, an under-match would lose a
     * badge.
     *
     * This assumes rows exist for conversations with messages, which is what
     * `npm run chat:activity:backfill` guarantees for history written before the hook.
     */
    const [candidates, userGroupIds] = await Promise.all([
      ConversationRead.find({
        user: userId,
        lastMessageAt: { $ne: null },
        $expr: { $gt: ["$lastMessageAt", { $ifNull: ["$lastReadAt", EPOCH] }] },
      })
        .select("conversation lastReadAt")
        .limit(MAX_UNREAD_CONVERSATIONS + 1)
        .lean(),
      getUserGroupIds(userId),
    ]);

    const truncated = candidates.length > MAX_UNREAD_CONVERSATIONS;
    if (truncated) {
      console.warn("getUnreadCount: candidate set truncated", {
        user: userId.toString(),
        cap: MAX_UNREAD_CONVERSATIONS,
      });
    }
    const rows = truncated ? candidates.slice(0, MAX_UNREAD_CONVERSATIONS) : candidates;

    // Rows persist for conversations you've left, so intersect with what is still
    // reachable — otherwise a group you left keeps contributing to the total with no row
    // in the list to clear it.
    const groupKeys = new Set(userGroupIds.map((id) => Message.groupConversationKey(id)));
    const reachable = rows.filter((row) => !row.conversation.startsWith("g:") || groupKeys.has(row.conversation));

    const watermarks = watermarksFromRows(reachable);
    const counts = await unreadCountsByConversation(
      userId,
      reachable.map((row) => row.conversation),
      watermarks
    );

    /*
     * DM peers that still resolve.
     *
     * `getChats` drops a conversation whose peer no longer exists — a hard-deleted
     * account leaves messages behind with a `receiver` that populates to null, and
     * there is nothing to render a row for. This endpoint counted them anyway, so
     * the badge showed a number the list had no row to clear: the only way to get
     * rid of it was for the count to be wrong in the other direction. The group
     * half was already handled by intersecting with live memberships above.
     */
    const peerIds = [
      ...new Set(
        [...counts.keys()]
          .map((conversation) => dmPeerId(conversation, userId))
          .filter(Boolean)
      ),
    ];
    const livePeers = new Set(
      peerIds.length
        ? (
            await User.find({ _id: { $in: peerIds }, ...ACTIVE_ACCOUNT })
              .select("_id")
              .lean()
          ).map((u) => u._id.toString())
        : []
    );

    // Keyed the way the chat list is keyed, through the one shared mapper.
    const byChatId = {};
    let total = 0;
    for (const [conversation, count] of counts) {
      const peer = dmPeerId(conversation, userId);
      if (peer && !livePeers.has(peer)) continue;
      const chatId = chatIdForConversation(conversation, userId);
      if (!chatId) continue;
      byChatId[chatId] = count;
      total += count;
    }

    res.status(200).json({ byChatId, totalUnread: total, ...(truncated ? { truncated } : {}) });
  } catch (error) {
    console.error("getUnreadCount error:", error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

export const searchMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { username } = req.params;
    const { query, limit = 50, cursor } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);

    // `?query[]=x` arrives as an array; escapeRegex would throw on it.
    if (typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const receiver = await User.findOne({ username }).select("_id").lean();
    if (!receiver) return res.status(404).json({ error: "User not found" });

    // Search over a locked conversation is a read of that conversation.
    if (await answeredLocked(req, res, userId, `user_${receiver._id}`)) return;

    const conversationKey = Message.dmConversationKey(userId, receiver._id);
    const searchRx = new RegExp(escapeRegex(query), "i");

    // withCursor, not a spread: the content match below is an $or, and the
    // cursor predicate is also an $or. Spreading dropped the search itself.
    const messages = await Message.find(withCursor({
      conversation: conversationKey,
      isDeleted: { $ne: true },
      ...notDeletedForUser(userId),
      $or: [{ content: searchRx }, { "media.caption": searchRx }, { "poll.question": searchRx }],
    }, parsedCursor))
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic")
      .lean();

    const { items: pagedMessages, pageInfo } = buildCursorPageInfo(messages, limitNum);
    // Search matches on poll.question, so polls come back here — and an
    // anonymous one must not ship its voter list on this path either.
    applyPollViews(pagedMessages, userId);
    res.status(200).json({ messages: stripSharedSnapshots(pagedMessages), count: pagedMessages.length, pageInfo, hasMore: pageInfo.hasNextPage });
  } catch (error) {
    console.error("searchMessages error:", error);
    res.status(500).json({ error: "Failed to search messages" });
  }
};

export const globalSearch = async (req, res) => {
  try {
    const userId = req.user.id;
    const { query } = req.query;
    // `?query[]=x` arrives as an array and escapeRegex would throw on it; a
    // very long term is pointless and expensive against an unanchored regex.
    if (typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ error: "Search query is required" });
    }
    if (query.length > 100) {
      return res.status(400).json({ error: "Search query is too long" });
    }
    // Clamped, like every other list endpoint. It was `+limit` raw, so
    // `?limit=10000000` was honoured and `?limit=abc` produced limit(NaN).
    const limitNum = parseCursorLimit(req.query.limit, 20);

    const searchRx = new RegExp(escapeRegex(query), "i");
    const contentFilter = { $or: [{ content: searchRx }, { "media.caption": searchRx }] };

    const userGroupIds = await getUserGroupIds(userId);

    /*
     * Locked conversations are excluded, not gated.
     *
     * This was the hole in the lock: the five per-conversation reads verify an
     * unlock grant, and this one searches *across* conversations and had no check
     * at all — so `GET /chats/search/global?query=a` returned message bodies from
     * every locked chat with nothing but a session. A 423 makes no sense here
     * because the request isn't about one conversation, so the locked ones drop out
     * of the search instead. That is also the behaviour a user would expect: a
     * locked chat shouldn't surface in a global search on an unlocked screen.
     */
    const locked = await UserSettings.findOne({ user: userId })
      .select("chat.lockedChats")
      .lean();
    const lockedKeys = (locked?.chat?.lockedChats || [])
      .map((chatId) => conversationForChatId(chatId, userId))
      .filter(Boolean);
    const notLocked = lockedKeys.length ? { conversation: { $nin: lockedKeys } } : {};

    /*
     * Bounded by recency, and the bound is reported.
     *
     * An unanchored regex can't use an index, so the sender/receiver and group
     * indexes locate the caller's messages and then every one of them is matched
     * in memory. For anyone with a long history that is a full read of their
     * whole correspondence, on an endpoint a search box calls as you type. The
     * window turns it into a range scan of a known size.
     *
     * This costs coverage: a message older than the window is not findable here.
     * That's a real reduction and the response says so rather than presenting a
     * truncated result as a complete one — per-conversation search
     * (`/messages/:username/search`) is bounded by the conversation instead and
     * has no window, so it remains the way to reach old messages. Lifting this
     * properly needs a search index, which is a bigger decision than a fix.
     */
    const since = new Date(Date.now() - GLOBAL_SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    /*
     * Group history floors, per group, as a scoping predicate.
     *
     * This branch searches across every group the caller is in, and each one carries its
     * own `messageHistory` setting and its own `joinedAt` — so one shared `createdAt`
     * bound can't express it. Groups with no restriction stay in a single `$in`; each
     * floored group contributes a clause pairing its id with its own floor.
     *
     * Search is the bypass that matters most here. Flooring the thread and not this would
     * leave the entire hidden history readable a term at a time, by the member the setting
     * exists to keep out, from a box that queries as you type.
     */
    const floors = await historyFloors(userGroupIds, userId);
    const unrestricted = userGroupIds.filter((id) => !floors.get(id.toString()));
    const flooredClauses = userGroupIds
      .map((id) => [id, floors.get(id.toString())])
      .filter(([, floor]) => floor)
      .map(([id, floor]) => ({ group: id, createdAt: { $gte: floor } }));

    const groupScope = {
      $or: [{ group: { $in: unrestricted } }, ...flooredClauses],
    };

    const [personalMessages, groupMessages, users, groups] = await Promise.all([
      /*
       * `mergeFilters`, not a spread.
       *
       * This was `{ $or: [{sender}, {receiver}], ...contentFilter }` — and
       * `contentFilter` is *itself* `{ $or: [...] }`, so the spread overwrote the
       * first key and the predicate scoping the search to the caller's own
       * conversations simply vanished. `GET /chats/search/global?query=e` returned
       * every matching direct message in the collection, with both parties' names
       * and avatars, to any authenticated user. The query still returned rows, just
       * everybody's rows, which is why nothing looked broken.
       *
       * Exactly what `withCursor` exists to prevent, one collection over. Both
       * branches go through the merge now — the group one has only a single `$or`
       * today and would have broken silently the first time anyone added a second.
       */
      Message.find(
        mergeFilters(
          { $or: [{ sender: userId }, { receiver: userId }] },
          contentFilter,
          {
            createdAt: { $gte: since },
            isDeleted: { $ne: true },
            isGroupMessage: { $ne: true },
            ...notLocked,
            ...notDeletedForUser(userId),
          }
        )
      ).sort({ createdAt: -1 }).limit(limitNum).populate("sender receiver", "username name profilePic").lean(),

      // Three `$or`s now — the content match, the cursor-free group scope above, and
      // whatever `notLocked` adds — so `mergeFilters` is doing real work here.
      Message.find(
        mergeFilters(contentFilter, groupScope, {
          createdAt: { $gte: since },
          isGroupMessage: true,
          isDeleted: { $ne: true },
          ...notLocked,
          ...notDeletedForUser(userId),
        })
      ).sort({ createdAt: -1 }).limit(limitNum).populate("sender", "username name profilePic").populate("group", "name avatar").lean(),

      User.find({ $or: [{ username: searchRx }, { name: searchRx }], _id: { $ne: userId },
        // $nin, not equality: it also matches accounts created before
        // `accountStatus` existed, which equality silently excludes.
        accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] } })
        .select("username name profilePic isVerified").limit(10).lean(),

      // Scoped to the caller's groups in the query, not filtered afterwards:
      // taking the top ten name matches across every group in the database and
      // *then* dropping the ones you aren't in meant your own group returned
      // nothing whenever ten other groups matched the term first.
      Group.find({
        _id: { $in: userGroupIds },
        name: searchRx,
        isActive: { $ne: false },
        isDeleted: { $ne: true },
      })
        .select("name avatar counts")
        .limit(10)
        .lean(),
    ]);

    res.status(200).json({
      personalMessages, groupMessages, users, groups,
      totals: { personal: personalMessages.length, group: groupMessages.length, users: users.length, groups: groups.length },
      // So the client can say which messages were searched instead of implying
      // it searched all of them.
      messageWindow: { days: GLOBAL_SEARCH_WINDOW_DAYS, since },
    });
  } catch (error) {
    console.error("globalSearch error:", error);
    res.status(500).json({ error: "Failed to perform search" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Pin / Pinned messages / Media
// ─────────────────────────────────────────────────────────────────────────────

/*
 * How many messages one conversation may have pinned.
 *
 * There was no cap. The pinned bar renders them all and the pinned endpoint
 * pages through them, so an unbounded list is a way to make the top of a
 * conversation unusable for the other party — and in a group, for everyone.
 * Five is what the deleted Group.pinnedMessages field's own comment claimed was
 * "enforced in code" while nothing enforced anything.
 */
const MAX_PINNED_PER_CONVERSATION = 5;

/**
 * Pin or unpin.
 *
 * `pinned` in the body says which. Without it this was a pure toggle, so two
 * taps — or a double-click, or a retry after a slow response — netted zero and
 * the user was left believing the pin had failed. An explicit target state makes
 * the request idempotent: asking for the state it is already in succeeds and
 * changes nothing. It stays optional so an older client keeps toggling.
 *
 * In a DM either participant may unpin the other's pin. That is deliberate: the
 * pinned bar is one shared surface at the top of a conversation both people are
 * looking at, and a pin only the pinner can remove is a way to occupy the other
 * person's screen permanently. Group pins need the `pinMessages` permission,
 * which is where rank belongs.
 */
export const pinMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    let hasPermission = false;
    if (message.isGroupMessage) {
      // Through getPermissions rather than re-deriving from role and overrides
      // by hand. The two agree for every role today; the point is that the
      // inline copy would silently stop agreeing the moment the defaults in
      // GroupMember change.
      const membership = await groupMembership(message.group, userId);
      hasPermission = Boolean(membership?.getPermissions().pinMessages);
    } else {
      hasPermission = message.sender.toString() === userId || message.receiver?.toString() === userId;
    }

    if (!hasPermission) return res.status(404).json({ error: "Message not found" });

    const requested =
      typeof req.body?.pinned === "boolean" ? req.body.pinned : !message.isPinned;

    if (requested === message.isPinned) {
      return res.status(200).json({
        message: message.isPinned ? "Message pinned" : "Message unpinned",
        isPinned: message.isPinned,
      });
    }

    if (requested) {
      /*
       * Counts what the pinned list actually shows.
       *
       * `pinnedMessagesFor` filters out tombstones, so without the same filter here
       * five unsent-but-still-pinned messages would fill the cap with rows nothing
       * displays — and since there is no UI for unpinning an invisible message, that
       * conversation could never pin anything again. `unsendMessage` clears
       * `isPinned` now as well, so this is belt and braces for rows unsent before
       * that change.
       */
      const pinned = await Message.countDocuments({
        conversation: message.conversation,
        isPinned: true,
        isDeleted: { $ne: true },
      });
      if (pinned >= MAX_PINNED_PER_CONVERSATION) {
        return res.status(400).json({
          error: `Only ${MAX_PINNED_PER_CONVERSATION} messages can be pinned at once — unpin one first`,
        });
      }
    }

    message.isPinned = requested;
    message.pinnedAt = requested ? new Date() : null;
    message.pinnedBy = requested ? userId : null;
    await message.save();

    const io = getIO();
    io.to(conversationRoom(message)).emit("messagePinned", { messageId: message._id, isPinned: message.isPinned, pinnedBy: userId, pinnedAt: message.pinnedAt });

    res.status(200).json({ message: message.isPinned ? "Message pinned" : "Message unpinned", isPinned: message.isPinned });
  } catch (error) {
    console.error("pinMessage error:", error);
    res.status(500).json({ error: "Failed to pin message" });
  }
};

/**
 * Pinned messages for one conversation.
 *
 * `scope` comes from the route, not the client. The single handler that served
 * both routes always built a *DM* key — so `GET /groups/:id/pinned` computed
 * the caller-to-group-id DM key, matched nothing, and group pinned messages
 * came back empty every time.
 *
 * The DM branch needs no membership check because the key is built from the
 * caller: you can only ever address a conversation you are half of. The group
 * branch has no such property, so it checks.
 */
const pinnedMessagesFor = async (req, res, scope) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { limit = 50, cursor } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);

    if (!mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({ error: "Invalid conversation ID" });
    }

    let conversationKey;
    // `messageHistory: "hidden"` applies here too: pinning is not a way to publish a
    // pre-join message to members who joined after it.
    let floor = null;
    if (scope === "group") {
      if (!(await isGroupMember(conversationId, userId))) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      if (await answeredLocked(req, res, userId, `group_${conversationId.toLowerCase()}`)) return;
      conversationKey = Message.groupConversationKey(conversationId);
      floor = await historyFloor(conversationId, userId);
    } else {
      if (await answeredLocked(req, res, userId, `user_${conversationId.toLowerCase()}`)) return;
      conversationKey = Message.dmConversationKey(userId, conversationId);
    }

    /*
     * The cursor is built on `pinnedAt` because that is what the query sorts
     * by. It used to page on `createdAt` while sorting on `pinnedAt`, so the
     * boundary predicate had nothing to do with the ordering and page two both
     * skipped and repeated rows.
     */
    const query = mergeFilters(
      withCursor(
        {
          conversation: conversationKey,
          isPinned: true,
          isDeleted: { $ne: true },
          ...notDeletedForUser(userId),
        },
        parsedCursor
      ),
      historyFloorFilter(floor)
    );

    const pinnedMessages = await Message.find(query)
      .sort({ pinnedAt: -1, _id: -1 })
      .limit(limitNum + 1)
      .populate("sender", "username name profilePic")
      .populate("pinnedBy", "username name")
      .lean();

    const { items, pageInfo } = buildCursorPageInfo(pinnedMessages, limitNum, "pinnedAt");
    // A pinned poll is read by every member on page load — the one place an
    // anonymous poll's voter list would reach the widest audience.
    applyPollViews(items, userId);
    res.status(200).json({ pinnedMessages: stripSharedSnapshots(items), pageInfo, hasMore: pageInfo.hasNextPage });
  } catch (error) {
    console.error("getPinnedMessages error:", error);
    res.status(500).json({ error: "Failed to fetch pinned messages" });
  }
};

export const getPinnedMessages = (req, res) => pinnedMessagesFor(req, res, "dm");
export const getGroupPinnedMessages = (req, res) => pinnedMessagesFor(req, res, "group");

export const getConversationMedia = async (req, res) => {
  try {
    const userId = req.user.id;
    const { username } = req.params;
    const { type, limit = 50, cursor } = req.query;
    const limitNum = parseCursorLimit(limit, 50);
    const parsedCursor = decodeCursor(cursor);
    const typeFilter = typeof type === "string" && type ? type : null;

    const receiver = await User.findOne({ username }).select("_id").lean();
    if (!receiver) return res.status(404).json({ error: "User not found" });

    // The media grid is the conversation's attachments — same boundary.
    if (await answeredLocked(req, res, userId, `user_${receiver._id}`)) return;

    const conversationKey = Message.dmConversationKey(userId, receiver._id);
    const query = withCursor(
      {
        conversation: conversationKey,
        "media.0": { $exists: true },
        isDeleted: { $ne: true },
        ...notDeletedForUser(userId),
        ...(typeFilter ? { "media.type": typeFilter } : {}),
      },
      parsedCursor
    );

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .select("media createdAt sender")
      .populate("sender", "username name profilePic")
      .lean();

    /*
     * `limit` counts messages, not items — the cursor has to page the thing the
     * {conversation, createdAt} index sorts, and one message can carry several
     * attachments. So a page holds *at least* `limit` items and the count
     * varies. Clients must decide whether to offer "load more" from
     * `pageInfo.nextCursor`, never from how many items came back.
     *
     * The per-item filter is not redundant with `"media.type"` in the query:
     * that predicate matches a *message* containing one item of that type, and
     * returned everything else attached to it. Asking for videos handed back
     * the photos posted alongside them.
     */
    const { items: pagedMessages, pageInfo } = buildCursorPageInfo(messages, limitNum);
    const media = pagedMessages.flatMap((msg) =>
      (msg.media || [])
        .filter((m) => !typeFilter || m.type === typeFilter)
        .map((m) => ({ ...m, messageId: msg._id, timestamp: msg.createdAt, sender: msg.sender }))
    );

    /*
     * No `totalCount`. It was the length of the current page dressed up as a
     * total, which is worse than absent — a caller that trusted it would stop
     * paging as soon as it had "all" of them. An honest one means unwinding
     * every media array in the conversation on every request, and nothing
     * displays a total, so it isn't worth buying.
     */
    res.status(200).json({ media, pageInfo, hasMore: pageInfo.hasNextPage });
  } catch (error) {
    console.error("getConversationMedia error:", error);
    res.status(500).json({ error: "Failed to fetch media" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Media upload
// ─────────────────────────────────────────────────────────────────────────────

export const uploadChatMedia = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    /*
     * Size and type are both settled upstream now.
     *
     * There used to be a 100MB check here against multer's 50MB limit — dead
     * code, because nothing over 50MB ever reached the handler — and a
     * hand-written list of fourteen mimetypes that disagreed with multer's in
     * both directions: it rejected spreadsheets multer had already written to
     * disk, and multer rejected documents this list named. One list, in
     * multerConfig, is now the single answer to "what may be uploaded".
     */
    if (!CHAT_UPLOAD_TYPES.some((type) => req.file.mimetype.startsWith(type))) {
      return res.status(400).json({ error: "Invalid file type" });
    }

    let fileType = "document";
    if (req.file.mimetype.startsWith("image/")) fileType = "image";
    if (req.file.mimetype.startsWith("video/")) fileType = "video";
    if (req.file.mimetype.startsWith("audio/")) fileType = "audio";

    const result = await uploadToCloudinary(req.file.path, "chat_media");

    /*
     * A video's thumbnail is a generated still, never the video URL.
     *
     * Cloudinary returns no `thumbnail_url` for a video, so the `|| secure_url`
     * fallback made `thumbnail` the .mp4 for every chat video ever uploaded. That
     * is not merely useless, it is actively harmful to any consumer that expects an
     * image: a `<video poster>` pointed at it downloads a 200, fails to decode it,
     * and renders an empty box rather than falling back to the first frame — which
     * is precisely how videos stopped appearing in the thread.
     *
     * `videoStillUrl` returns null if it can't build one, and null is what gets
     * stored in that case. The client treats a missing thumbnail as "paint the
     * first frame yourself", which is a good outcome; it cannot do anything sensible
     * with a thumbnail that lies.
     */
    const thumbnail =
      fileType === "video"
        ? videoStillUrl(result)
        : result.thumbnail_url || result.secure_url;

    const descriptor = {
      url: result.secure_url, thumbnail: thumbnail || null,
      fileSize: req.file.size, type: fileType, filename: req.file.originalname,
      duration: result.duration || null,
      dimensions: result.width && result.height ? { width: result.width, height: result.height } : null,
    };
    // Signed so the send path can trust the type it derived here. Without it a
    // document relabelled as an image walks past a group's fileSharing rule.
    res.status(200).json({ ...descriptor, token: signMedia(descriptor) });
  } catch (error) {
    console.error("uploadChatMedia error:", error);
    res.status(500).json({ error: "Failed to upload media" });
  }
};

export const uploadVoiceNote = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ error: "Voice note too large" });
    if (!req.file.mimetype.startsWith("audio/")) return res.status(400).json({ error: "Invalid audio file" });

    const result = await uploadToCloudinary(req.file.path, "voice_notes");

    /*
     * The waveform comes from the recorder, not from a random number generator.
     *
     * This used to be `Array.from({length: points}, () => Math.random())` —
     * fabricated data, rendered to the listener as though it were the
     * amplitude envelope of what they were about to hear. A drawing of noise
     * that changes every time is worse than no drawing at all, because it
     * looks like information.
     *
     * The browser already has the real thing: the composer runs an
     * AnalyserNode while recording and draws a live waveform from it, so it
     * posts that alongside the audio. Decoding the file server-side would mean
     * ffmpeg for a decorative strip. Untrusted input, so it's clamped: numbers
     * only, 0..1, capped in length. Anything malformed yields an empty array
     * and the client draws its flat placeholder rather than a lie.
     */
    const MAX_WAVEFORM_POINTS = 200;
    let waveform = [];
    try {
      const raw = JSON.parse(req.body?.waveform ?? "[]");
      if (Array.isArray(raw)) {
        waveform = raw
          .slice(0, MAX_WAVEFORM_POINTS)
          .filter((n) => typeof n === "number" && Number.isFinite(n))
          .map((n) => Math.min(1, Math.max(0, n)));
      }
    } catch {
      waveform = [];
    }

    const descriptor = {
      url: result.secure_url,
      type: "voice",
      fileSize: req.file.size,
      duration: result.duration || 0,
      waveform,
    };
    res.status(200).json({ ...descriptor, token: signMedia(descriptor) });
  } catch (error) {
    console.error("uploadVoiceNote error:", error);
    res.status(500).json({ error: "Failed to upload voice note" });
  }
};

/**
 * Throw away uploads that were never sent.
 *
 * Attachments are uploaded one at a time before the message is sent, so a failure
 * on file five of six left the first four sitting in Cloudinary with nothing
 * pointing at them — and the client keeps the selection so the user can retry,
 * which uploads them a second time. Nothing ever deleted the first copies (CF28).
 *
 * The signature is the authorization. `verifyMedia` proves this server produced the
 * (url, type, size) triple, which is what stops this endpoint being a way to delete
 * arbitrary assets — a plain "delete this URL" endpoint would be exactly that. It
 * doesn't prove *who* uploaded it, so the worst a caller can do with a token of
 * their own is discard their own unsent upload, which is the point.
 *
 * Best effort throughout: this runs on an error path, and a failed cleanup must not
 * turn into a second error for the user to deal with.
 */
export const discardChatMedia = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Nothing to discard" });
    if (items.length > MAX_MEDIA_PER_MESSAGE) {
      return res.status(400).json({ error: "Too many items" });
    }

    let discarded = 0;
    for (const item of items) {
      if (!verifyMedia(item)) continue;
      if (await deleteFromCloudinary(item.url)) discarded += 1;
    }

    res.status(200).json({ discarded });
  } catch (error) {
    console.error("discardChatMedia error:", error);
    res.status(500).json({ error: "Failed to discard uploads" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Polls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post a poll into a DM or a group.
 *
 * This handler had no authorization of any kind: `receiverId` and `groupId`
 * came straight off the body and the message was created and broadcast. That
 * meant posting into any group by id — including one you'd been banned from —
 * and messaging anyone who had blocked you or who accepts no messages. It now
 * applies exactly the checks the send path applies.
 */
export const createPoll = async (req, res) => {
  try {
    const userId = req.user._id;
    const { receiverId, groupId, question, options, settings: pollSettings = {} } = req.body;

    const pollQuestion = typeof question === "string" ? question.trim() : "";
    if (!pollQuestion || !Array.isArray(options) || options.length < 2) return res.status(400).json({ error: "Question and at least 2 options are required" });
    if (options.length > 10) return res.status(400).json({ error: "Maximum 10 options allowed" });

    /*
     * Lengths, checked here because nothing checked them anywhere.
     *
     * `poll.question` had no cap on the schema either, so a ten-megabyte
     * question was a valid poll — stored, broadcast to every member of the
     * group, and re-sent in full on every vote. The options were only trimmed.
     */
    if (pollQuestion.length > MAX_POLL_QUESTION) {
      return res.status(400).json({ error: `Question must be ${MAX_POLL_QUESTION} characters or fewer` });
    }
    const optionTexts = options.map((text) => (typeof text === "string" ? text.trim() : ""));
    if (optionTexts.some((text) => !text)) {
      return res.status(400).json({ error: "Every option needs some text" });
    }
    if (optionTexts.some((text) => text.length > MAX_POLL_OPTION)) {
      return res.status(400).json({ error: `Options must be ${MAX_POLL_OPTION} characters or fewer` });
    }
    if (Boolean(receiverId) === Boolean(groupId)) {
      return res.status(400).json({ error: "Pick either a person or a group for this poll" });
    }

    /*
     * Polls are a group feature. Between two people a poll collapses into a
     * question you could just ask, and `settings.anonymous` becomes a promise the
     * conversation can't keep — with one possible voter, any vote identifies its
     * voter by elimination. The DM composer no longer offers the button; this is
     * the matching server rule, so removing the UI isn't the only thing standing
     * between a caller and a DM poll.
     *
     * Existing DM polls are untouched and stay votable: the socket vote handler
     * gates on `isMessageParticipant`, not on this route.
     */
    if (receiverId) {
      return res.status(400).json({ error: "Polls are only available in group chats" });
    }

    // Resolved before anything is written, and the conversation key is built
    // from the ids the database returned rather than the strings the client
    // sent — an uppercase-hex id would sort differently and produce a key
    // neither party's thread query would ever match.
    let receiver = null;
    let group = null;
    if (groupId) {
      const access = await resolveGroupSend(groupId, userId);
      if (!access.ok) return res.status(403).json({ error: access.reason });
      // The canonical id the lookup returned. Rooms and conversation keys are both
      // built from `group._id`, so an uppercase-hex `groupId` off the request body
      // produced a poll that was stored under one key and broadcast to a room name
      // nobody is in — it reached nobody live (CF35).
      group = access.group;
    } else {
      if (!mongoose.isValidObjectId(receiverId)) {
        return res.status(404).json({ error: "User not found" });
      }
      const objectIds = [new mongoose.Types.ObjectId(receiverId)];
      const [found, blocked, messageable] = await Promise.all([
        User.findOne({ _id: receiverId, ...ACTIVE_ACCOUNT }).select("_id username").lean(),
        blockedIdSet(userId, objectIds),
        messageableIdSet(userId, objectIds),
      ]);
      if (!found) return res.status(404).json({ error: "User not found" });
      if (blocked.has(found._id.toString())) {
        return res.status(403).json({ error: "Can't message this account" });
      }
      if (!messageable.has(found._id.toString())) {
        return res.status(403).json({ error: "They don't accept messages from you" });
      }
      receiver = found;
    }

    const pollData = {
      question: pollQuestion,
      options: optionTexts.map((text) => ({ id: uuidv4(), text, votes: [], voteCount: 0 })),
      allowMultipleAnswers: pollSettings.allowMultipleAnswers || false,
      isAnonymous: pollSettings.isAnonymous || false,
      expiresAt: pollSettings.expiresAt ? new Date(pollSettings.expiresAt) : null,
      settings: { allowAddingOptions: pollSettings.allowAddingOptions || false, showVoteCount: pollSettings.showVoteCount !== false },
    };

    const convKey = group
      ? Message.groupConversationKey(group._id)
      : Message.dmConversationKey(userId, receiver._id);

    const message = await Message.create({
      sender: userId,
      conversation: convKey,
      messageType: "poll",
      poll: pollData,
      ...(group ? { group: group._id, isGroupMessage: true } : { receiver: receiver._id }),
    });
    await message.populate("sender", "username name profilePic isVerified");

    const io = getIO();
    /*
     * A brand-new poll has no votes, so there is nothing to anonymise yet —
     * but it goes through the same view helper as every other read so the
     * shape the client receives is identical from the first render. Otherwise
     * the options gain a `votedByMe` field only after someone votes, and the
     * bubble has to handle both shapes.
     */
    const forEveryone = applyPollView(message.toObject(), null);
    if (group) io.to(group._id.toString()).emit("receiveGroupMessage", forEveryone);
    else {
      io.to(receiver._id.toString()).emit("receiveMessage", { ...forEveryone, isOwn: false });
      io.to(userId.toString()).emit("receiveMessage", {
        ...applyPollView(message.toObject(), userId),
        isOwn: true,
      });
    }

    res.status(201).json({
      message: "Poll created successfully",
      poll: applyPollView(message.toObject(), userId).poll,
    });
  } catch (error) {
    console.error("createPoll error:", error);
    res.status(500).json({ error: "Failed to create poll" });
  }
};

export default {
  getMessages, getGroupMessages, getChats, getChatPreferences,
  createChatCategory, reorderChatCategories, deleteChatCategory, assignChatCategory,
  toggleFavoriteChat, updateChatTheme, setDisappearingForChat, updateChatState, setChatLockPin,
  resetChatLockPin, verifyChatLockPin, getGroupPinnedMessages,
  archiveChat, deleteChat, unsendMessage, deleteMessageForMe, editMessage, toggleReaction,
  forwardMessage, uploadChatMedia, uploadVoiceNote, discardChatMedia,
  getUnreadCount, markMessagesAsRead,
  searchMessages, globalSearch, pinMessage, getPinnedMessages, getConversationMedia,
  createPoll, getUserGroups,
};
