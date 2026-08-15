import mongoose from "mongoose";
import Follow from "../models/Follow.js";
import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";
import User from "../models/User.js";
import UserRelation from "../models/UserRelation.js";
import UserSettings from "../models/UserSettings.js";

/**
 * Who is allowed to read, write and reach whom in chat.
 *
 * These checks used to live in three places: shareController had the careful
 * batched versions, chatController had partial hand-written copies, and the
 * socket layer had none at all on several handlers. The copies drifted — the
 * share path refused to pull a blocked account into a group while the socket
 * `createGroup` happily did, and `forwardMessage` never checked that the caller
 * could see the message it was copying. A permission check that exists twice is
 * a permission check that will eventually only be right once, so there is now
 * one of each and every path imports it.
 *
 * Nothing here writes. Every function answers a question and the caller decides
 * what to do with the answer.
 */

// Matches userController's ACTIVE_ACCOUNT_FILTER. An equality check on "active"
// would silently drop every account created before `accountStatus` existed,
// since $nin also matches a missing field.
export const ACTIVE_ACCOUNT = {
  accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] },
};

/** Ceiling on a single fan-out (share, forward, new group). */
export const MAX_RECIPIENTS = 25;

/**
 * Longest disappearing-message timer, matching the longest preset the settings
 * screen offers. The two have to agree: a preset the server silently rejects
 * makes the whole feature look broken.
 */
export const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

/** "user_<peerId>" / "group_<id>" for a conversation key, from one user's side. */
const chatIdForConversation = (conversation, userId) => {
  if (typeof conversation !== "string") return null;
  if (conversation.startsWith("g:")) return `group_${conversation.slice(2)}`;
  const me = userId.toString();
  const peer = conversation.split(":").find((id) => id !== me);
  return peer ? `user_${peer}` : null;
};

/**
 * `_id` as a string, whether the field is a raw ObjectId, a string, or a
 * populated document. The security checks below run against messages loaded by
 * several different call sites, and one of them populating `sender` should not
 * quietly turn an ownership test into a comparison against "[object Object]".
 */
export const idOf = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value._id) return value._id.toString();
  return value.toString();
};

/**
 * Valid, deduplicated, self-excluded ObjectId strings from untrusted input.
 * Anything that isn't an ObjectId is dropped rather than rejected — a client
 * sending junk in a list of twenty shouldn't fail the other nineteen.
 */
export const cleanIds = (ids, { exclude } = {}) => {
  const excluded = exclude ? idOf(exclude) : null;
  return [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => id.toString())
        .filter((id) => id !== excluded)
    ),
  ];
};

/** Ids the caller has blocked, or who have blocked the caller. Both directions. */
export const blockedIdSet = async (userId, otherIds) => {
  if (!otherIds.length) return new Set();
  const rows = await UserRelation.find({
    kind: "block",
    $or: [
      { from: userId, to: { $in: otherIds } },
      { from: { $in: otherIds }, to: userId },
    ],
  })
    .select("from to")
    .lean();

  const blocked = new Set();
  for (const row of rows) {
    const from = row.from.toString();
    blocked.add(from === userId.toString() ? row.to.toString() : from);
  }
  return blocked;
};

/**
 * Does `owner`'s audience setting let `viewer` see the thing it guards?
 *
 * `whoCanSeeOnlineStatus`, `whoCanSeeLastSeen` and `whoCanSeeReadReceipts` are
 * all `audienceEnum` and all, until now, read by nothing at all — the settings
 * screen wrote them and the server ignored them. featureGate.js states the rule
 * this broke: "a toggle that nothing reads is worse than no toggle".
 *
 * A block overrides everything, so callers check that separately and first.
 */
export const audienceAllows = async (viewerId, ownerId, policy) => {
  const viewer = idOf(viewerId);
  const owner = idOf(ownerId);
  if (!viewer || !owner) return false;
  if (viewer === owner) return true;

  switch (policy) {
    case "none":
      return false;
    case "followers":
      // The owner's followers: does the viewer follow the owner?
      return Follow.isFollowing(viewer, owner);
    case "followers_following": {
      const [viewerFollows, ownerFollows] = await Promise.all([
        Follow.isFollowing(viewer, owner),
        Follow.isFollowing(owner, viewer),
      ]);
      return viewerFollows || ownerFollows;
    }
    default:
      return true;
  }
};

/*
 * The privacy block, cached.
 *
 * It is read on the busiest events in the app — once per typing keystroke burst,
 * once per read notification, once per contact in a presence fan-out, once per
 * peer in the connect snapshot — and it is the same five booleans-and-enums every
 * time. That was one `findOne` per event.
 *
 * Invalidated explicitly on a settings save rather than trusted to expire, because
 * the whole point of these settings is that turning one off takes effect. The TTL
 * is a backstop for a write that happens by some path that forgets to call
 * `invalidatePrivacy` — short, because being wrong here means leaking presence or
 * a read receipt somebody just turned off.
 */
const PRIVACY_TTL_MS = 60_000;
const privacyCache = new Map(); // userId -> { at, value }

export const invalidatePrivacy = (userId) => {
  if (userId) privacyCache.delete(String(userId));
};

/** Drop stale entries so the map tracks active users rather than every user. */
const sweepPrivacyCache = () => {
  const cutoff = Date.now() - PRIVACY_TTL_MS;
  for (const [key, entry] of privacyCache) {
    if (entry.at <= cutoff) privacyCache.delete(key);
  }
};
setInterval(sweepPrivacyCache, PRIVACY_TTL_MS).unref();

/**
 * The privacy block for one user, with the defaults already applied so callers
 * don't each have to remember what "unset" means.
 */
export const privacyOf = async (userId) => {
  const key = String(idOf(userId) ?? "");
  const cached = privacyCache.get(key);
  if (cached && Date.now() - cached.at < PRIVACY_TTL_MS) return cached.value;

  const row = await UserSettings.findOne({ user: userId }).select("privacy").lean();
  const p = row?.privacy || {};
  const value = {
    whoCanSeeOnlineStatus: p.whoCanSeeOnlineStatus || "everyone",
    whoCanSeeLastSeen: p.whoCanSeeLastSeen || "everyone",
    whoCanSeeReadReceipts: p.whoCanSeeReadReceipts || "everyone",
    readReceipts: p.readReceipts !== false,
    typingIndicator: p.typingIndicator !== false,
  };
  if (key) privacyCache.set(key, { at: Date.now(), value });
  return value;
};

/**
 * What `viewers` are allowed to know about `peerId`'s presence.
 *
 * The same two settings the socket's `getUserStatus` handler enforces, and the same order —
 * lifted out of it because there is now a second caller. Presence over REST is what the AI
 * bot DM inspection view uses: it has no socket of its own.
 *
 * ── Why this takes a list ───────────────────────────────────────────────────
 *
 * That view has *two* viewers and both have to be satisfied. The bot is the account in the
 * conversation, so the peer's privacy choice was made about it — pass only the owner and you
 * would show a last-seen the bot was never entitled to. But the human reading the screen is
 * the owner, and pass only the bot and you have built a way to launder presence: someone who
 * blocked me, or who limits last-seen to followers, becomes readable to me the moment my bot
 * gets a DM from them. Neither viewer alone is the right answer, so every viewer must allow
 * it and the strictest wins.
 *
 * Blocks are *not* covered here — `audienceAllows` says so explicitly — so callers check
 * those separately and first, for every viewer they pass.
 *
 * Both fields come back null rather than absent when the policy denies them, so a caller
 * that forgets to check still renders nothing instead of leaking a default.
 *
 * @param {Array<string|object>} viewers everyone who will see the answer; all must allow it.
 * @param {Function} isOnline async (userId) => boolean — injected because presence lives in
 *        the socket layer and importing it here would be a cycle.
 * @param {Date} [knownLastActiveAt] the peer's `lastActiveAt` if the caller already loaded
 *        it, which saves a query per peer on a list.
 * @returns {Promise<{isOnline: boolean, lastSeen: Date|null}>}
 */
export const visiblePresence = async (viewers, peerId, isOnline, knownLastActiveAt) => {
  const list = (Array.isArray(viewers) ? viewers : [viewers]).filter(Boolean);
  if (!list.length) return { isOnline: false, lastSeen: null };

  const privacy = await privacyOf(peerId);
  const verdicts = await Promise.all(
    list.flatMap((viewer) => [
      audienceAllows(viewer, peerId, privacy.whoCanSeeOnlineStatus),
      audienceAllows(viewer, peerId, privacy.whoCanSeeLastSeen),
    ])
  );
  const maySeeOnline = verdicts.filter((_, i) => i % 2 === 0).every(Boolean);
  const maySeeLastSeen = verdicts.filter((_, i) => i % 2 === 1).every(Boolean);

  if (!maySeeOnline && !maySeeLastSeen) return { isOnline: false, lastSeen: null };

  const online = await isOnline(peerId);
  let lastSeen = null;
  if (maySeeLastSeen) {
    if (online) lastSeen = new Date();
    else if (knownLastActiveAt !== undefined) lastSeen = knownLastActiveAt ?? null;
    else {
      const user = await User.findById(peerId).select("lastActiveAt").lean();
      lastSeen = user?.lastActiveAt ?? null;
    }
  }

  return { isOnline: maySeeOnline && online, lastSeen };
};

/**
 * How long messages in this conversation should live, in seconds, or null.
 *
 * `chat.disappearingByChat` is written by the conversation's settings screen
 * and, until now, read by absolutely nothing — the send path took an
 * `selfDestructTimer` off the client payload instead. So turning disappearing
 * messages on persisted a preference the server ignored, while a client could
 * set an arbitrary expiry on a message to someone who never asked for one.
 *
 * The shortest setting among the participants wins, which is the only reading
 * that doesn't let one side quietly override the other's choice. Storage is
 * per-user, so for a group only the sender's setting is consulted — polling two
 * hundred members on every send isn't worth it.
 */
export const conversationTtlSeconds = async (conversation, participantIds) => {
  const rows = await UserSettings.find({ user: { $in: participantIds } })
    .select("user chat.disappearingByChat")
    .lean();

  let shortest = null;
  for (const row of rows) {
    // The setting is stored per user, keyed by the *other* party
    // ("user_<peerId>") — the same chat-list id the settings screen writes, not
    // the conversation key. So each row has to be looked up under its own
    // owner's spelling: A's entry says user_B and B's says user_A for the very
    // same thread.
    const chatId = chatIdForConversation(conversation, row.user);
    if (!chatId) continue;

    const entry = (row.chat?.disappearingByChat || []).find((d) => d.chatId === chatId);
    const seconds = Number(entry?.seconds);
    if (!Number.isInteger(seconds) || seconds <= 0) continue;
    // Clamped on read as well as on write: an old row could predate the cap.
    const capped = Math.min(seconds, MAX_TTL_SECONDS);
    if (shortest === null || capped < shortest) shortest = capped;
  }
  return shortest;
};

/** Whether this user has muted this conversation. */
export const isConversationMuted = async (userId, chatId) => {
  const row = await UserSettings.findOne({ user: userId }).select("chat.mutedChats").lean();
  return (row?.chat?.mutedChats || []).includes(chatId);
};

/**
 * Which of `recipientIds` will accept a DM from `senderId`, honouring
 * `privacy.whoCanMessage`. Batched — the socket send path does this one user at
 * a time, which is fine for a single send but not for a forward to twenty.
 */
export const messageableIdSet = async (senderId, recipientIds) => {
  if (!recipientIds.length) return new Set();

  const settings = await UserSettings.find({ user: { $in: recipientIds } })
    .select("user privacy.whoCanMessage")
    .lean();

  const policyByUser = new Map(
    settings.map((s) => [s.user.toString(), s.privacy?.whoCanMessage || "everyone"])
  );

  // Only resolve follow edges if some recipient actually restricts messaging.
  const restricted = recipientIds.filter((id) => {
    const policy = policyByUser.get(id.toString()) || "everyone";
    return policy === "followers" || policy === "followers_following";
  });

  let recipientFollowsSender = new Set();
  let senderFollowsRecipient = new Set();

  if (restricted.length) {
    const [inbound, outbound] = await Promise.all([
      Follow.find({
        follower: { $in: restricted },
        following: senderId,
        status: "accepted",
      })
        .select("follower")
        .lean(),
      Follow.find({
        follower: senderId,
        following: { $in: restricted },
        status: "accepted",
      })
        .select("following")
        .lean(),
    ]);
    recipientFollowsSender = new Set(inbound.map((f) => f.follower.toString()));
    senderFollowsRecipient = new Set(outbound.map((f) => f.following.toString()));
  }

  const allowed = new Set();
  for (const id of recipientIds) {
    const key = id.toString();
    switch (policyByUser.get(key) || "everyone") {
      case "none":
        break;
      case "followers":
        if (recipientFollowsSender.has(key)) allowed.add(key);
        break;
      case "followers_following":
        if (recipientFollowsSender.has(key) || senderFollowsRecipient.has(key)) {
          allowed.add(key);
        }
        break;
      default:
        allowed.add(key);
    }
  }
  return allowed;
};

/**
 * May `callerId` place a call to `calleeId`?
 *
 * Lives here rather than inline in the call handler for the reason stated at the top
 * of this file: a permission check that exists twice is one that will eventually only
 * be right once. It was inline in `initiateCall`, hand-rolling the same three
 * `audienceEnum` branches `audienceAllows` already implements.
 *
 * Returns a *reason*, not a boolean, because the caller has to be told which rule
 * stopped them — "they don't accept calls" and "you've blocked each other" need
 * different words on screen, and the handler previously collapsed both into
 * "Failed to initiate call".
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export const canCall = async (callerId, calleeId) => {
  const caller = idOf(callerId);
  const callee = idOf(calleeId);
  if (!caller || !callee) return { ok: false, reason: "User not found" };
  if (caller === callee) return { ok: false, reason: "You can't call yourself" };

  if (await UserRelation.eitherBlocks(caller, callee)) {
    return { ok: false, reason: "You can't call this account" };
  }

  const settings = await UserSettings.findOne({ user: callee })
    .select("privacy.whoCanCall")
    .lean();
  const policy = settings?.privacy?.whoCanCall || "everyone";

  if (policy === "none") {
    return { ok: false, reason: "This account doesn't accept calls" };
  }
  /*
   * `audienceAllows` implements `followers` as "the owner is followed by the viewer"
   * — the same direction the inline version used — and `followers_following` as
   * either direction. One implementation, already covered by the privacy tests.
   */
  if (!(await audienceAllows(caller, callee, policy))) {
    return {
      ok: false,
      reason:
        policy === "followers"
          ? "This account only accepts calls from people it follows"
          : "This account doesn't accept calls from you",
    };
  }

  return { ok: true };
};

/**
 * The caller's membership row, or null.
 *
 * `isBanned: { $ne: true }` rather than `false` — the flag was added after the
 * collection existed, and an equality check misses every row written before it.
 */
export const groupMembership = async (groupId, userId) => {
  if (!mongoose.isValidObjectId(groupId) || !mongoose.isValidObjectId(idOf(userId))) {
    return null;
  }
  try {
    return await GroupMember.findOne({
      group: groupId,
      user: userId,
      isBanned: { $ne: true },
    });
  } catch {
    return null;
  }
};

export const isGroupMember = async (groupId, userId) =>
  Boolean(await groupMembership(groupId, userId));

/**
 * May `userId` read this conversation key?
 *
 * Most handlers build the key from the caller plus a target, which is
 * self-scoping — you can only ever address a conversation you're half of. This
 * is for the ones that accept a key from the client instead.
 */
export const canReadConversation = async (conversation, userId) => {
  if (typeof conversation !== "string") return false;
  const me = idOf(userId);
  if (!me) return false;

  if (conversation.startsWith("g:")) {
    return isGroupMember(conversation.slice(2), me);
  }
  const parts = conversation.split(":");
  return parts.length === 2 && parts.includes(me);
};

/* ── Group message-history visibility ───────────────────────────────────────────
 *
 * `Group.settings.messageHistory: "hidden"` means a member reads nothing from before
 * their own `GroupMember.joinedAt`. This is the one definition of that rule; the eight
 * read paths that honour it all get their floor from here.
 *
 * It is a *read* rule, so it belongs beside `canSeeMessage` and deliberately not in
 * `isMessageParticipant`. That distinction already exists in this file and it matters:
 * marking a conversation read, and deleting-for-me a message you have already thrown
 * away, stay valid on a message you may no longer *read*. Flooring participation instead
 * of visibility would break both.
 */

/**
 * The rule itself, as a pure function, so the fail-closed cases are testable.
 *
 * @returns a `Date` floor, or `null` for "no restriction".
 */
export const historyFloorFor = (messageHistory, joinedAt) => {
  /*
   * Absent reads as `visible`, and that is not laziness about a missing value.
   *
   * The schema defaults to `visible`, but a default only applies to documents Mongoose
   * writes — every group that existed before this field did has no `settings.messageHistory`
   * at all. Treating absent as anything else would hide every existing group's entire
   * history the moment this deployed, which is a far worse failure than the one
   * fail-closed is protecting against here.
   */
  if (messageHistory == null || messageHistory === "visible") return null;

  /*
   * Anything that isn't `visible` floors, including a value this code doesn't recognise.
   *
   * `updateGroup` allowlists the enum, so an unrecognised value can only arrive by a
   * direct database write — and at that point "I don't know what this setting means" must
   * not resolve to "show everything".
   */
  if (joinedAt instanceof Date) return joinedAt;
  const parsed = joinedAt ? new Date(joinedAt) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;

  /*
   * Hidden, but we don't know when they joined.
   *
   * `joinedAt` has a schema default so this shouldn't happen; if it does, the floor is
   * *now* — they read nothing that already exists. Failing open here would hand the whole
   * history to exactly the row we know least about.
   */
  return new Date();
};

/**
 * Floors for several groups at once, for one reader.
 *
 * Batched because `getChats` needs it for every group on a page and a per-conversation
 * lookup would put two queries per row on the app's hottest endpoint. The single-group
 * helper below delegates here so there is one query shape and one rule.
 *
 * @returns `Map<groupId, Date|null>`. A group the caller is not a member of is absent —
 *   callers must already have established membership; this answers "how far back", not
 *   "may they read at all".
 */
export const historyFloors = async (groupIds, userId) => {
  const floors = new Map();
  const ids = cleanIds(groupIds);
  const me = idOf(userId);
  if (!ids.length || !me) return floors;

  const [groups, memberships] = await Promise.all([
    Group.find({ _id: { $in: ids } }).select("settings.messageHistory").lean(),
    GroupMember.find({ group: { $in: ids }, user: me, isBanned: { $ne: true } })
      .select("group joinedAt")
      .lean(),
  ]);

  const joinedByGroup = new Map(memberships.map((m) => [idOf(m.group), m.joinedAt]));
  const settingByGroup = new Map(groups.map((g) => [idOf(g._id), g.settings?.messageHistory]));

  /*
   * Keyed over the *requested* ids, not the groups that came back.
   *
   * Iterating the query result left a caller's `floors.get(id)` returning `undefined` for
   * any id that didn't resolve, and every call site reads a falsy floor as "no
   * restriction" — so a group missing from the lookup silently became unrestricted. That
   * is a fail-open branch in an access control, and the kind that survives review because
   * `undefined` and `null` behave identically at the call site until one day they don't.
   *
   * A group that genuinely doesn't resolve still ends up unrestricted, and that is
   * deliberate rather than accidental: "no group document" and "group with no setting"
   * are indistinguishable here, and flooring the latter would hide every existing group's
   * history. Deleting a group also deletes its GroupMember rows, so a caller cannot reach
   * this branch for a group they still appear to be in.
   *
   * A member with no membership row for a `hidden` group is a different matter, and
   * `historyFloorFor` resolves that one closed — the floor becomes "now".
   */
  for (const id of ids) {
    const key = idOf(id);
    floors.set(key, historyFloorFor(settingByGroup.get(key), joinedByGroup.get(key)));
  }
  return floors;
};

/** One group's floor. `null` means no restriction. */
export const historyFloor = async (groupId, userId) => {
  const key = idOf(groupId);
  if (!key) return null;
  const floors = await historyFloors([key], userId);
  // A group that doesn't exist has no history to restrict; the caller's own membership
  // check is what refuses the read.
  return floors.has(key) ? floors.get(key) : null;
};

/** `{createdAt: {$gte: floor}}`, or `{}` — for merging into a message query. */
export const historyFloorFilter = (floor) =>
  floor ? { createdAt: { $gte: floor } } : {};

/**
 * The socket rooms a message's conversation occupies: the group room for a
 * group message, both participants' personal rooms for a DM.
 *
 * `receiver` is optional on the schema, and the inline `.toString()` the call
 * sites used to do would throw on a row without one — after the write had
 * already committed, so the client saw a failure for something that succeeded.
 */
export const conversationRoom = (message) =>
  message.isGroupMessage
    ? idOf(message.group)
    : [idOf(message.sender), idOf(message.receiver)].filter(Boolean);

/**
 * Is `userId` one of the two people in this DM, or a member of this group?
 *
 * The participation test behind every per-message action. Reactions, receipts,
 * poll votes and delete-for-me all need it and several of them had nothing.
 */
export const isMessageParticipant = async (message, userId) => {
  if (!message) return false;
  const me = idOf(userId);
  if (!me) return false;

  if (idOf(message.sender) === me) return true;
  if (message.isGroupMessage) return isGroupMember(message.group, me);
  return idOf(message.receiver) === me;
};

/**
 * Can `userId` read this message right now?
 *
 * Participation, plus the caller's own delete-for-me — a message you threw away
 * shouldn't be forwardable back out of your own history — plus the group's
 * message-history floor. Use `isMessageParticipant` instead for actions that
 * stay valid on a hidden message, such as deleting it for yourself twice.
 *
 * The floor here is what stops a member forwarding a pre-join message out of a
 * `hidden` group, and what makes `resolveReplyTo` refuse to point a new reply at
 * one. Both take a message id from the client, so neither is covered by flooring
 * the list queries.
 *
 * `createdAt` is required for the check, so a caller passing a projection
 * without it would silently skip the floor. Treated as unreadable rather than
 * readable: this is a deny gate, and the two callers both select it.
 */
export const canSeeMessage = async (message, userId) => {
  if (!message) return false;
  const me = idOf(userId);
  if (!me) return false;

  const deletedFor = Array.isArray(message.deletedFor) ? message.deletedFor : [];
  if (deletedFor.some((id) => idOf(id) === me)) return false;

  if (!(await isMessageParticipant(message, me))) return false;
  if (!message.isGroupMessage || !message.group) return true;

  const floor = await historyFloor(message.group, me);
  if (!floor) return true;
  if (!message.createdAt) return false;
  return new Date(message.createdAt) >= floor;
};

/**
 * Everything that has to be true before `userId` may put a message into a
 * group: they're a member, they're not banned, the group still exists, their
 * role allows posting, they aren't muted, the group allows this kind of
 * attachment, and slow mode isn't holding them.
 *
 * One gate rather than two. The socket send path grew its own copy of these
 * checks while `/share`, `/polls` and forwarding kept the older, thinner
 * version — which meant a muted member couldn't post but could forward, and
 * slow mode was bypassed by sharing. Every group write goes through here now.
 *
 * Returns a reason rather than throwing, so fan-out callers can record a
 * per-target failure and carry on with the rest.
 */
export const resolveGroupSend = async (groupId, userId, { media = [] } = {}) => {
  const membership = await groupMembership(groupId, userId);
  if (!membership) return { ok: false, reason: "You're not in that group" };

  const group = await Group.findById(groupId)
    .select("name avatar isActive isDeleted settings")
    .lean();
  if (!group || group.isDeleted || group.isActive === false) {
    return { ok: false, reason: "That group is no longer active" };
  }

  const perms = membership.getPermissions();
  if (!perms.sendMessages) return { ok: false, reason: "You can't post in that group" };

  // Mute is a more fundamental state than any per-attachment permission, so it
  // is reported first — telling a muted member they can't send *media* would
  // send them looking for the wrong setting.
  if (membership.mutedUntil && membership.mutedUntil > new Date()) {
    return { ok: false, reason: "You're muted in this group" };
  }

  const items = Array.isArray(media) ? media : [];
  const settings = group.settings || {};

  if (items.length) {
    // Only bites for an explicit permissionOverrides.sendMedia — the
    // `restricted` role already fails the sendMessages check above.
    if (!perms.sendMedia) return { ok: false, reason: "You can't send media in this group" };
    if (settings.mediaSharing === false) {
      return { ok: false, reason: "Media sharing is turned off in this group" };
    }
    /*
     * There is no `fileSharing` rule any more.
     *
     * It gated `type === "document"`, and documents were removed from the product — no
     * client can produce one and the upload endpoint refuses every document mimetype. A
     * check that can never fire is worse than no check: it reads as protection.
     * `mediaSharing` above still covers photos, videos and voice notes.
     */
  }

  // Admins are exempt: someone who turns on a five-minute slow mode shouldn't
  // be the first person it locks out.
  const isGroupStaff = ["admin", "super_admin"].includes(membership.role);
  const slowSeconds = Number(settings.slowModeSeconds) || 0;

  if (slowSeconds > 0 && !isGroupStaff) {
    const since = new Date(Date.now() - slowSeconds * 1000);
    // Bounded by the window, so the existing {conversation, createdAt} index
    // serves it as a short range scan and the Message collection — the highest
    // insert volume in the app — doesn't need an extra index for a setting
    // that defaults to off. It's an existence check, nothing more.
    const Message = mongoose.model("Message");
    const recent = await Message.findOne({
      conversation: Message.groupConversationKey(group._id),
      sender: userId,
      createdAt: { $gte: since },
    })
      .select("createdAt")
      .lean();

    if (recent) {
      const elapsed = Date.now() - new Date(recent.createdAt).getTime();
      // Clamped: a document with a future createdAt would otherwise produce an
      // arbitrarily long lockout.
      const waitMs = Math.min(slowSeconds * 1000 - elapsed, slowSeconds * 1000);
      if (waitMs > 0) {
        return { ok: false, reason: `Slow mode is on — wait ${Math.ceil(waitMs / 1000)}s` };
      }
    }
  }

  return { ok: true, membership, group };
};

/**
 * Whether `replyTo` is a message the caller may quote *in this conversation*.
 *
 * Without this the field was a read primitive: `replyTo` was stored verbatim
 * from the payload and `getMessages` populates it with `content` and `sender`,
 * so pointing it at a stranger's message id handed back the text of a
 * conversation the caller was never part of. In a group it was broadcast to
 * every member.
 */
export const resolveReplyTo = async (replyTo, { conversation, userId }) => {
  if (!replyTo) return null;
  const id = idOf(replyTo);
  if (!mongoose.isValidObjectId(id)) return null;

  const Message = mongoose.model("Message");
  const parent = await Message.findById(id)
    // `createdAt` is here for `canSeeMessage`'s history floor, which denies rather than
    // guesses when it is absent — without it, replying to anything in a group with
    // `messageHistory: "hidden"` would be refused outright.
    .select("conversation sender receiver group isGroupMessage deletedFor createdAt")
    .lean();

  if (!parent || parent.conversation !== conversation) return null;
  if (!(await canSeeMessage(parent, userId))) return null;
  return parent._id;
};
