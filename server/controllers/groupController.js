import mongoose from "mongoose";
import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import {
  ACTIVE_ACCOUNT,
  MAX_RECIPIENTS,
  blockedIdSet,
  cleanIds,
  idOf,
  messageableIdSet,
} from "../utils/chatAccess.js";
import { seedConversationRead } from "../utils/readState.js";
import { recomputeGroupCounts } from "../utils/groupCounts.js";
import { addUserToRoom, getIO, removeUserFromRoom } from "../config/socket.js";
import { parseCursorLimit } from "../utils/cursorPagination.js";

/**
 * Group management.
 *
 * There was none of this: one endpoint (`GET /groups/user`), no way to rename a
 * group, add or remove anyone, change a role, or leave. A group you were added
 * to was a room you could never get out of, and the only way to create one was
 * the share sheet. The schema has carried `role`, `permissionOverrides`,
 * `mutedUntil` and `isBanned` the whole time with nothing to write them.
 *
 * Two rules run through everything below:
 *
 *   - Permissions come from `membership.getPermissions()`, never from an
 *     inline role comparison. The roles already encode this and a second copy
 *     drifts — chatController had one that ignored `restricted` entirely.
 *   - Counts are *derived*, never arithmetic. Every path here ends in
 *     `recomputeGroupCounts`; see utils/groupCounts.js for the four different
 *     ways the arithmetic was wrong.
 */

const MAX_GROUP_MEMBERS = 512;

/** 404 rather than 403 for a group you're not in: don't confirm it exists. */
const loadMembership = async (groupId, userId) => {
  if (!mongoose.isValidObjectId(groupId)) return { error: 404 };

  const group = await Group.findOne({
    _id: groupId,
    isActive: { $ne: false },
    isDeleted: { $ne: true },
  });
  if (!group) return { error: 404 };

  const membership = await GroupMember.findOne({
    group: groupId,
    user: userId,
    isBanned: { $ne: true },
  });
  if (!membership) return { error: 404 };

  return { group, membership, permissions: membership.getPermissions() };
};

/**
 * The `:userId` route parameter, validated and canonicalised — or null.
 *
 * Lowercased, and that is the whole point. Uppercase hex is a valid ObjectId
 * string and Mongoose casts it happily, so the raw parameter was equal to the
 * caller's own id for database purposes and *not* equal to it for the
 * `targetId === idOf(req.user.id)` string comparisons that stop someone acting on
 * themselves. It also has to match the key `userSockets` uses, which is the
 * canonical lowercase form: a ban issued with uppercase hex wrote the row and then
 * called `removeUserFromRoom` with a key that matched nothing, leaving the banned
 * member's tabs in the group room receiving every message — the exact thing that
 * call exists to prevent. Same hazard as conversation keys, same fix.
 */
const targetUserId = (req) => {
  const raw = req.params.userId;
  if (!mongoose.isValidObjectId(raw)) return null;
  return String(raw).toLowerCase();
};

const publicMember = (row) => ({
  _id: row._id,
  user: row.user,
  role: row.role,
  joinedAt: row.joinedAt,
  mutedUntil: row.mutedUntil,
  isBanned: Boolean(row.isBanned),
  // Only present on a banned row, and only ever returned to callers who could
  // ban in the first place — see the `banned` branch of getGroupMembers.
  ...(row.isBanned
    ? { bannedAt: row.bannedAt ?? null, banReason: row.banReason ?? "" }
    : {}),
});

const emitToGroup = (groupId, event, payload) => {
  try {
    getIO().to(groupId.toString()).emit(event, payload);
  } catch {
    // The socket layer isn't up in every context (scripts, tests). A missed
    // live update is not a reason to fail the write that already happened.
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a group.
 *
 * There was no way to do this that wasn't attached to sharing a post: the only
 * paths were `shareController` (which needs a post to send) and a socket event
 * with no ack. So the Groups tab's empty state offered "Create a Group" and
 * navigated to `/create-group`, a route that doesn't exist — the user landed on
 * NotFoundPage.
 *
 * Same consent rules as everywhere else: a group must not be a way to reach
 * someone who has blocked you or who doesn't accept your messages.
 */
export const createGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "A group needs a name" });
    if (name.length > 100) {
      return res.status(400).json({ error: "Name must be 100 characters or fewer" });
    }

    const requested = cleanIds(req.body?.userIds, { exclude: userId });
    if (!requested.length) {
      return res.status(400).json({ error: "Pick someone to add to the group" });
    }
    if (requested.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `A group can start with up to ${MAX_RECIPIENTS} people` });
    }

    const objectIds = requested.map((id) => new mongoose.Types.ObjectId(id));
    const [existing, blocked, messageable] = await Promise.all([
      User.find({ _id: { $in: objectIds }, ...ACTIVE_ACCOUNT }).select("_id").lean(),
      blockedIdSet(userId, objectIds),
      messageableIdSet(userId, objectIds),
    ]);

    const usable = existing
      .map((u) => u._id.toString())
      .filter((id) => !blocked.has(id) && messageable.has(id));
    if (!usable.length) {
      return res.status(400).json({ error: "Nobody you picked can be added" });
    }

    const description =
      typeof req.body?.description === "string"
        ? req.body.description.trim().slice(0, 500)
        : "";

    const group = await Group.create({
      name,
      description,
      // No client-supplied avatar: it's rendered for every member and there is
      // no upload path behind it yet. The schema default applies.
      type: ["public", "private", "secret"].includes(req.body?.type)
        ? req.body.type
        : "private",
      createdBy: userId,
    });

    const memberDocs = [
      { group: group._id, user: userId, role: "super_admin", addedBy: userId },
      ...usable.map((id) => ({
        group: group._id,
        user: id,
        role: "member",
        addedBy: userId,
      })),
    ];

    try {
      await GroupMember.insertMany(memberDocs);
      await seedConversationRead(
        memberDocs.map((doc) => doc.user),
        Message.groupConversationKey(group._id)
      );
    } catch (insertError) {
      /*
       * Otherwise the Group survives with nobody in it: invisible to everyone
       * and impossible to clean up from inside the app. insertMany is ordered
       * by default, so rows before the failure did commit and have to go too,
       * or those users hold membership of a group that no longer exists and
       * get joined to a dead room on every connect.
       */
      await GroupMember.deleteMany({ group: group._id });
      await Group.deleteOne({ _id: group._id });
      throw insertError;
    }

    // From the rows that actually committed, not from the array we asked for.
    await recomputeGroupCounts(group._id);

    for (const doc of memberDocs) addUserToRoom(doc.user, group._id);

    const fresh = await Group.findById(group._id).lean();
    emitToGroup(group._id, "groupCreated", { group: fresh });

    res.status(201).json({
      group: fresh,
      // So the client can say "3 of the 5 you picked were added" rather than
      // silently dropping the rest.
      addedCount: usable.length,
      requestedCount: requested.length,
    });
  } catch (err) {
    console.error("createGroup error:", err);
    res.status(500).json({ error: "Failed to create group" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

export const getGroup = async (req, res) => {
  try {
    const { group, membership, permissions, error } = await loadMembership(
      req.params.groupId,
      req.user.id
    );
    if (error) return res.status(404).json({ error: "Group not found" });

    const creator = await User.findById(group.createdBy)
      .select("username name profilePic")
      .lean();

    res.status(200).json({
      group: {
        _id: group._id,
        name: group.name,
        description: group.description,
        avatar: group.avatar,
        type: group.type,
        settings: group.settings,
        counts: group.counts,
        createdBy: creator,
        createdAt: group.createdAt,
      },
      membership: {
        role: membership.role,
        joinedAt: membership.joinedAt,
        mutedUntil: membership.mutedUntil,
        permissions,
      },
    });
  } catch (err) {
    console.error("getGroup error:", err);
    res.status(500).json({ error: "Failed to load group" });
  }
};

export const getGroupMembers = async (req, res) => {
  try {
    const { permissions, error } = await loadMembership(req.params.groupId, req.user.id);
    if (error) return res.status(404).json({ error: "Group not found" });

    /*
     * `?banned=true` lists the banned rows instead of the active ones.
     *
     * Without it a ban is one-way from the UI: the banned row is filtered out of
     * every membership query, so there would be nothing to select and nothing to
     * lift the ban from. Gated on the same permission as banning, because the
     * list of who has been banned and why is moderation state, not member state.
     */
    const wantBanned = req.query.banned === "true";
    if (wantBanned && !permissions.removeMembers) {
      return res.status(403).json({ error: "You can't see this group's bans" });
    }

    const filter = {
      group: req.params.groupId,
      isBanned: wantBanned ? true : { $ne: true },
    };

    // Paginated by joinedAt, which {group, joinedAt} serves. A thousand-member
    // group returned in one response is the shape this collection exists to
    // avoid.
    const limit = parseCursorLimit(req.query.limit, 50);
    const skip = Math.max(0, Number.parseInt(req.query.skip, 10) || 0);

    const [rows, total] = await Promise.all([
      GroupMember.find(filter)
        .sort({ joinedAt: -1 })
        .skip(skip)
        .limit(limit + 1)
        .populate("user", "username name profilePic isVerified")
        .lean(),
      GroupMember.countDocuments(filter),
    ]);

    /*
     * Rows whose user no longer resolves are dropped.
     *
     * A hard-deleted account leaves the membership row behind with `user`
     * populating to null, and every consumer then has to guard `user._id` or
     * throw. There is nothing to render for such a row and nothing useful to do
     * with it, so it doesn't leave this endpoint.
     */
    const hasMore = rows.length > limit;
    const members = rows
      .slice(0, limit)
      .filter((row) => row.user)
      .map(publicMember);

    res.status(200).json({
      members,
      total,
      hasMore,
      nextSkip: hasMore ? skip + limit : null,
    });
  } catch (err) {
    console.error("getGroupMembers error:", err);
    res.status(500).json({ error: "Failed to load members" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Group info and settings
// ─────────────────────────────────────────────────────────────────────────────

export const updateGroup = async (req, res) => {
  try {
    const { group, permissions, error } = await loadMembership(
      req.params.groupId,
      req.user.id
    );
    if (error) return res.status(404).json({ error: "Group not found" });
    if (!permissions.changeGroupInfo) {
      return res.status(403).json({ error: "You can't change this group's details" });
    }

    const updates = {};
    if (typeof req.body?.name === "string") {
      const name = req.body.name.trim();
      // maxlength on the schema surfaces as a 500 through the generic catch;
      // the length is a client mistake and deserves a 400 that says so.
      if (!name) return res.status(400).json({ error: "A group needs a name" });
      if (name.length > 100) {
        return res.status(400).json({ error: "Name must be 100 characters or fewer" });
      }
      updates.name = name;
    }
    if (typeof req.body?.description === "string") {
      const description = req.body.description.trim();
      if (description.length > 500) {
        return res.status(400).json({ error: "Description must be 500 characters or fewer" });
      }
      updates.description = description;
    }
    if (["public", "private", "secret"].includes(req.body?.type)) {
      updates.type = req.body.type;
    }

    // Settings the code actually enforces, and only those.
    if (req.body?.settings && typeof req.body.settings === "object") {
      const { slowModeSeconds, mediaSharing, fileSharing, messageHistory } = req.body.settings;
      if (Number.isFinite(slowModeSeconds)) {
        updates["settings.slowModeSeconds"] = Math.min(
          Math.max(Math.trunc(slowModeSeconds), 0),
          3600
        );
      }
      if (typeof mediaSharing === "boolean") updates["settings.mediaSharing"] = mediaSharing;
      if (typeof fileSharing === "boolean") updates["settings.fileSharing"] = fileSharing;
      /*
       * Allowlisted, like `type` above, rather than passed through for the schema enum to
       * reject. A value that reaches the database unrecognised is one `historyFloorFor`
       * has to interpret, and it interprets it as `hidden` — so a typo here would silently
       * hide a group's history rather than answer 400.
       */
      if (["visible", "hidden"].includes(messageHistory)) {
        updates["settings.messageHistory"] = messageHistory;
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await Group.updateOne({ _id: group._id }, { $set: updates });
    const fresh = await Group.findById(group._id).lean();

    /*
     * Message-history visibility is audited; the other settings aren't.
     *
     * Flipping it to `visible` retroactively opens the whole archive to every member who
     * joined after it was hidden — an authorized action, but the only setting here whose
     * change grants access to data rather than restricting what people may do next. Ids
     * and the two values only, never content.
     */
    if (updates["settings.messageHistory"] !== undefined) {
      console.log("Group history visibility changed", {
        group: group._id.toString(),
        by: req.user.id.toString(),
        to: updates["settings.messageHistory"],
      });
    }

    emitToGroup(group._id, "groupUpdated", {
      groupId: group._id,
      name: fresh.name,
      description: fresh.description,
      avatar: fresh.avatar,
      type: fresh.type,
      settings: fresh.settings,
    });

    res.status(200).json({ group: fresh });
  } catch (err) {
    console.error("updateGroup error:", err);
    res.status(500).json({ error: "Failed to update group" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Membership
// ─────────────────────────────────────────────────────────────────────────────

export const addGroupMembers = async (req, res) => {
  try {
    const { group, permissions, error } = await loadMembership(
      req.params.groupId,
      req.user.id
    );
    if (error) return res.status(404).json({ error: "Group not found" });
    if (!permissions.addMembers) {
      return res.status(403).json({ error: "You can't add people to this group" });
    }

    const requested = cleanIds(req.body?.userIds, { exclude: req.user.id });
    if (!requested.length) return res.status(400).json({ error: "Pick someone to add" });
    if (requested.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `Up to ${MAX_RECIPIENTS} people at a time` });
    }

    const objectIds = requested.map((id) => new mongoose.Types.ObjectId(id));

    /*
     * The same consent rules as creating a group. Being added to a group must
     * not be a way around `whoCanMessage` or a block — otherwise anyone you've
     * refused can reach you by making a group and dragging you into it.
     */
    const [existing, blocked, messageable, already] = await Promise.all([
      User.find({ _id: { $in: objectIds }, ...ACTIVE_ACCOUNT }).select("_id").lean(),
      blockedIdSet(req.user.id, objectIds),
      messageableIdSet(req.user.id, objectIds),
      GroupMember.find({ group: group._id, user: { $in: objectIds } })
        .select("user isBanned")
        .lean(),
    ]);

    const alreadyIn = new Set(already.map((row) => row.user.toString()));
    const usable = existing
      .map((u) => u._id.toString())
      .filter(
        (id) => !blocked.has(id) && messageable.has(id) && !alreadyIn.has(id)
      );

    if (!usable.length) {
      return res.status(400).json({ error: "Nobody you picked can be added" });
    }

    const currentCount = await GroupMember.countDocuments({
      group: group._id,
      isBanned: { $ne: true },
    });
    if (currentCount + usable.length > MAX_GROUP_MEMBERS) {
      return res.status(400).json({
        error: `A group can hold ${MAX_GROUP_MEMBERS} people`,
      });
    }

    const docs = usable.map((id) => ({
      group: group._id,
      user: id,
      role: "member",
      addedBy: req.user.id,
    }));

    /*
     * ordered: false — one duplicate from a concurrent add shouldn't abort the
     * rest. E11000 on the {group, user} unique index is the expected collision.
     *
     * The count is recomputed rather than `$inc`'d by the number inserted. That
     * arithmetic was right in the happy path and in the E11000 path, and wrong in
     * the one that mattered: a *non*-11000 failure after a partial unordered
     * insert committed rows and rethrew before any `$inc` ran, leaving a permanent
     * undercount with nothing to correct it (CF32). Recomputing in a `finally`
     * means the rows and the number agree however this ends.
     */
    try {
      await GroupMember.insertMany(docs, { ordered: false });
    } catch (insertError) {
      if (insertError?.code !== 11000) throw insertError;
    } finally {
      await recomputeGroupCounts(group._id);
    }

    // Their unread starts here, not at the beginning of the group's history.
    await seedConversationRead(usable, Message.groupConversationKey(group._id));

    /*
     * Scoped to this request's own inserts.
     *
     * The re-query matched every membership row for those user ids, so a
     * concurrent add of the same people — or a row that already existed and lost
     * to E11000 — was reported back as though this request had created it.
     */
    const added = await GroupMember.find({
      group: group._id,
      user: { $in: usable.map((id) => new mongoose.Types.ObjectId(id)) },
      addedBy: req.user.id,
    })
      .populate("user", "username name profilePic isVerified")
      .lean();

    for (const row of added) {
      addUserToRoom(row.user._id, group._id);
    }
    emitToGroup(group._id, "groupMembersAdded", {
      groupId: group._id,
      members: added.map(publicMember),
    });

    res.status(201).json({ members: added.map(publicMember) });
  } catch (err) {
    console.error("addGroupMembers error:", err);
    res.status(500).json({ error: "Failed to add members" });
  }
};

export const removeGroupMember = async (req, res) => {
  try {
    const { group, membership, permissions, error } = await loadMembership(
      req.params.groupId,
      req.user.id
    );
    if (error) return res.status(404).json({ error: "Group not found" });

    const targetId = targetUserId(req);
    if (!targetId) return res.status(400).json({ error: "Invalid user id" });
    if (targetId === idOf(req.user.id)) {
      return res.status(400).json({ error: "Use leave to remove yourself" });
    }
    if (!permissions.removeMembers) {
      return res.status(403).json({ error: "You can't remove people from this group" });
    }

    const target = await GroupMember.findOne({ group: group._id, user: targetId });
    if (!target) return res.status(404).json({ error: "They're not in this group" });

    /*
     * Rank, not just the removeMembers bit. Without this an admin could remove
     * the super_admin — or another admin — and there would be no way back,
     * because promotion needs manageAdmins and only super_admin has it.
     */
    if (target.role === "super_admin") {
      return res.status(403).json({ error: "The group owner can't be removed" });
    }
    if (target.role === "admin" && membership.role !== "super_admin") {
      return res.status(403).json({ error: "Only the group owner can remove an admin" });
    }

    await GroupMember.deleteOne({ _id: target._id });
    await recomputeGroupCounts(group._id);

    // Out of the room, not just out of the table — see removeUserFromRoom.
    removeUserFromRoom(targetId, group._id);

    emitToGroup(group._id, "groupMemberRemoved", {
      groupId: group._id,
      userId: targetId,
      removedBy: req.user.id,
    });
    try {
      getIO().to(targetId.toString()).emit("removedFromGroup", {
        groupId: group._id,
        groupName: group.name,
      });
    } catch {
      /* socket layer down — the write still stands */
    }

    res.status(200).json({ message: "Member removed" });
  } catch (err) {
    console.error("removeGroupMember error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
};

/** Role, restriction and mute — everything about one member's standing. */
export const updateGroupMember = async (req, res) => {
  try {
    const { group, membership, permissions, error } = await loadMembership(
      req.params.groupId,
      req.user.id
    );
    if (error) return res.status(404).json({ error: "Group not found" });

    const targetId = targetUserId(req);
    if (!targetId) return res.status(400).json({ error: "Invalid user id" });
    if (targetId === idOf(req.user.id)) {
      return res.status(400).json({ error: "You can't change your own role" });
    }

    const target = await GroupMember.findOne({ group: group._id, user: targetId });
    if (!target) return res.status(404).json({ error: "They're not in this group" });
    if (target.role === "super_admin") {
      return res.status(403).json({ error: "The group owner's role can't be changed" });
    }

    const updates = {};

    if (req.body?.role !== undefined) {
      const role = req.body.role;
      // super_admin is not assignable: there is exactly one, it comes from
      // creating the group, and it moves only by succession on leave.
      if (!["admin", "member", "restricted"].includes(role)) {
        return res.status(400).json({ error: "Unknown role" });
      }
      if (!permissions.manageAdmins && (role === "admin" || target.role === "admin")) {
        return res.status(403).json({ error: "Only the group owner can manage admins" });
      }
      if (role !== "admin" && role !== target.role && !permissions.removeMembers) {
        return res.status(403).json({ error: "You can't change roles in this group" });
      }
      if (role !== target.role) updates.role = role;
    }

    if (req.body?.mutedUntil !== undefined) {
      if (!permissions.removeMembers) {
        return res.status(403).json({ error: "You can't mute people in this group" });
      }
      const raw = req.body.mutedUntil;
      if (raw === null) {
        updates.mutedUntil = null;
      } else {
        const until = new Date(raw);
        if (Number.isNaN(until.getTime())) {
          return res.status(400).json({ error: "Invalid mute expiry" });
        }
        // A year is already absurd; past dates are a no-op mute that reads as
        // one being in place.
        const cap = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        if (until <= new Date()) {
          return res.status(400).json({ error: "Mute expiry must be in the future" });
        }
        updates.mutedUntil = until > cap ? cap : until;
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    /*
     * Through the permission, not through the role.
     *
     * This was `membership.role !== "super_admin"`, which contradicts the rule at
     * the top of this file. It happens to give the right answer today only because
     * `manageAdmins` maps 1:1 onto `super_admin` in getDefaultPermissions — the
     * moment anyone writes a `permissionOverrides.manageAdmins`, the two
     * disagree and this guard starts refusing a caller the rest of the file
     * allows. (CF36.)
     */
    if (!permissions.manageAdmins && target.role === "admin") {
      return res.status(403).json({ error: "Only the group owner can change an admin" });
    }

    await GroupMember.updateOne({ _id: target._id }, { $set: updates });
    // `counts.admins` moves with a role change; derived rather than $inc'd for the
    // reasons in utils/groupCounts.js.
    if (updates.role) await recomputeGroupCounts(group._id);

    const fresh = await GroupMember.findById(target._id)
      .populate("user", "username name profilePic isVerified")
      .lean();

    emitToGroup(group._id, "groupMemberUpdated", {
      groupId: group._id,
      member: publicMember(fresh),
    });

    res.status(200).json({ member: publicMember(fresh) });
  } catch (err) {
    console.error("updateGroupMember error:", err);
    res.status(500).json({ error: "Failed to update member" });
  }
};

/**
 * Ban or unban a member.
 *
 * `GroupMember.isBanned` has been read on every membership lookup since the
 * collection existed and written by nothing at all — so the flag that keeps
 * someone out of the member list, the counts, the socket room and every send path
 * could never be set. This is the writer.
 *
 * A ban is not a removal. Removing deletes the row, and anyone with `addMembers`
 * can add that person straight back; banning keeps the row and marks it, so the
 * membership queries all skip it and re-adding is refused by the unique
 * `{group, user}` index until the ban is lifted. That difference is the reason
 * the field exists.
 *
 * Rank rules are the same as removal's, and for the same reason: without them an
 * admin could ban the owner, and there would be no way back because promotion
 * needs `manageAdmins`, which only the owner has.
 */
export const setGroupMemberBan = async (req, res) => {
  try {
    const { group, membership, permissions, error } = await loadMembership(
      req.params.groupId,
      req.user.id
    );
    if (error) return res.status(404).json({ error: "Group not found" });

    const targetId = targetUserId(req);
    if (!targetId) return res.status(400).json({ error: "Invalid user id" });
    if (targetId === idOf(req.user.id)) {
      // A self-ban is unrecoverable: the banned row fails every membership
      // lookup, including the one this endpoint needs to lift it.
      return res.status(400).json({ error: "You can't ban yourself" });
    }
    if (!permissions.removeMembers) {
      return res.status(403).json({ error: "You can't ban people from this group" });
    }

    const banned = req.body?.banned !== false;
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";

    /*
     * Not through loadMembership: that helper filters banned rows out, which is
     * right for the caller's own membership and wrong for the target — unbanning
     * needs to find precisely the row a ban is hiding.
     */
    const target = await GroupMember.findOne({ group: group._id, user: targetId });
    if (!target) return res.status(404).json({ error: "They're not in this group" });

    if (target.role === "super_admin") {
      return res.status(403).json({ error: "The group owner can't be banned" });
    }
    if (target.role === "admin" && membership.role !== "super_admin") {
      return res.status(403).json({ error: "Only the group owner can ban an admin" });
    }

    if (Boolean(target.isBanned) === banned) {
      /*
       * Already in the requested state. Answered with the same shape as the
       * success path — populated — because the client renders `member.user.username`
       * and an unpopulated row put a nameless, avatarless entry in the banned list
       * on any retry or concurrent second ban.
       */
      const already = await GroupMember.findById(target._id)
        .populate("user", "username name profilePic isVerified")
        .lean();
      return res.status(200).json({ member: publicMember(already), changed: false });
    }

    if (!banned) {
      // Unbanning is an add, so it has to respect the ceiling an add respects —
      // otherwise a group at capacity grows past it one lifted ban at a time.
      const current = await GroupMember.countDocuments({
        group: group._id,
        isBanned: { $ne: true },
      });
      if (current >= MAX_GROUP_MEMBERS) {
        return res.status(400).json({ error: `A group can hold ${MAX_GROUP_MEMBERS} people` });
      }
    }

    await GroupMember.updateOne(
      { _id: target._id },
      banned
        ? {
            $set: {
              isBanned: true,
              bannedAt: new Date(),
              bannedBy: req.user.id,
              ...(reason ? { banReason: reason } : {}),
              // A ban supersedes a mute; leaving one behind would silently
              // reapply it the moment the ban was lifted.
              mutedUntil: null,
            },
          }
        : { $set: { isBanned: false }, $unset: { bannedAt: "", bannedBy: "", banReason: "" } }
    );

    /*
     * Every membership query filters `isBanned: { $ne: true }`, so a banned row is
     * absent from the member list and has to be absent from the counts too, or the
     * badge disagrees with the list.
     */
    await recomputeGroupCounts(group._id);

    if (banned) {
      // Out of the room, not just out of the queries. Without this the banned
      // socket keeps receiving every message in the group until it happens to
      // disconnect, which with pingTimeout at 60s can be indefinite.
      removeUserFromRoom(targetId, group._id);
    } else {
      addUserToRoom(targetId, group._id);
    }

    const fresh = await GroupMember.findById(target._id)
      .populate("user", "username name profilePic isVerified")
      .lean();

    emitToGroup(group._id, banned ? "groupMemberRemoved" : "groupMembersAdded", {
      groupId: group._id,
      ...(banned
        ? { userId: targetId, bannedBy: req.user.id }
        : { members: [publicMember(fresh)] }),
    });
    try {
      getIO().to(targetId.toString()).emit(banned ? "removedFromGroup" : "addedToGroup", {
        groupId: group._id,
        groupName: group.name,
        ...(banned ? { banned: true } : {}),
      });
    } catch {
      /* socket layer down — the write still stands */
    }

    res.status(200).json({ member: publicMember(fresh), changed: true });
  } catch (err) {
    console.error("setGroupMemberBan error:", err);
    res.status(500).json({ error: "Failed to update ban" });
  }
};

/**
 * Leave a group.
 *
 * The interesting case is the last super_admin walking out. Doing nothing would
 * leave a group nobody can administer — no renames, no promotions, no removals,
 * permanently. So ownership passes to the longest-serving admin, or failing
 * that the longest-serving member. If there is nobody left at all the group is
 * soft-deleted rather than left as an empty shell in everyone's chat list.
 */
export const leaveGroup = async (req, res) => {
  try {
    const { group, membership, error } = await loadMembership(
      req.params.groupId,
      req.user.id
    );
    if (error) return res.status(404).json({ error: "Group not found" });

    const wasOwner = membership.role === "super_admin";

    await GroupMember.deleteOne({ _id: membership._id });
    removeUserFromRoom(req.user.id, group._id);

    const remaining = await GroupMember.countDocuments({
      group: group._id,
      isBanned: { $ne: true },
    });

    if (remaining === 0) {
      await Group.updateOne(
        { _id: group._id },
        { $set: { isActive: false, isDeleted: true, "counts.members": 0, "counts.admins": 0 } }
      );
      return res.status(200).json({ message: "You left the group", groupClosed: true });
    }

    let successor = null;
    if (wasOwner) {
      successor =
        (await GroupMember.findOne({
          group: group._id,
          role: "admin",
          isBanned: { $ne: true },
        }).sort({ joinedAt: 1 })) ||
        (await GroupMember.findOne({
          group: group._id,
          role: { $in: ["member", "restricted"] },
          isBanned: { $ne: true },
        }).sort({ joinedAt: 1 }));

      if (successor) {
        successor.role = "super_admin";
        await successor.save();
      }
    }

    /*
     * One recompute, after every row has moved.
     *
     * This was a read-then-`$inc` — the remaining count was read above and then
     * −1 applied unguarded, so two members leaving concurrently could each read
     * the same total and both decrement, taking `counts.members` to −1 on an
     * already soft-deleted group. `min: 0` is a schema validator and `updateOne`
     * doesn't run validators, so nothing caught it (CF31). Deriving the number
     * makes the race harmless: whichever recompute runs last is simply correct.
     */
    await recomputeGroupCounts(group._id);

    emitToGroup(group._id, "groupMemberRemoved", {
      groupId: group._id,
      userId: req.user.id,
      left: true,
      newOwnerId: successor?.user ?? null,
    });

    res.status(200).json({
      message: "You left the group",
      newOwnerId: successor?.user ?? null,
    });
  } catch (err) {
    console.error("leaveGroup error:", err);
    res.status(500).json({ error: "Failed to leave group" });
  }
};
