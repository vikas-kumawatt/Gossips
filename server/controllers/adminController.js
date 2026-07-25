import mongoose from "mongoose";
import User from "../models/User.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Report from "../models/Report.js";
import PlatformReport from "../models/PlatformReport.js";
import AuditLog from "../models/AuditLog.js";
import UserSession from "../models/UserSession.js";
import AppSettings, { EDITABLE_SETTINGS, SETTINGS_KEY } from "../models/AppSettings.js";
import { getSettings, invalidateSettingsCache } from "../utils/settings.js";
import { recordAudit } from "../utils/audit.js";
import { getReasonLabelServer } from "../utils/reportCategories.js";
import { escapeRegex } from "../utils/respond.js";
import { roleOf } from "../utils/roles.js";
import { del, CacheKeys } from "../utils/cache.js";

const ADMIN_USER_SELECT =
  "username name email profilePic bio role accountStatus isVerified verificationBadge suspensionReason suspensionEndsAt counts createdAt lastActiveAt isPrivate";

const parsePage = (value) => Math.max(Number.parseInt(value, 10) || 1, 1);
const parseLimit = (value, fallback = 25) =>
  Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), 100);

const excerpt = (text, length = 80) => {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/session — the client's guard calls this on mount so access is
 * decided by the server, not by whatever role is sitting in localStorage.
 */
export const getAdminSession = async (req, res) => {
  const [pendingReports, openPlatformReports] = await Promise.all([
    Report.countDocuments({ status: { $in: ["pending", "reviewing"] } }),
    PlatformReport.countDocuments({ status: "pending" }),
  ]);

  return res.status(200).json({
    id: req.user._id,
    username: req.user.username,
    name: req.user.name,
    profilePic: req.user.profilePic,
    role: roleOf(req.user),
    isSuperAdmin: roleOf(req.user) === "super_admin",
    badges: { pendingReports, openPlatformReports },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

export const listUsers = async (req, res) => {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { search, status, role, verified, sort = "recent" } = req.query;

    const query = {};

    if (search?.trim()) {
      const rx = new RegExp(escapeRegex(search.trim()), "i");
      query.$or = [{ username: rx }, { name: rx }, { email: rx }];
    }
    if (status && status !== "all") query.accountStatus = status;
    // `null` in $in also matches documents where the field is absent, which
    // covers accounts written before `role` existed.
    if (role && role !== "all") {
      query.role = role === "user" ? { $in: ["user", null] } : role;
    }
    if (verified === "true") query.isVerified = true;
    if (verified === "false") query.isVerified = false;

    const sortMap = {
      recent: { createdAt: -1 },
      oldest: { createdAt: 1 },
      followers: { "counts.followers": -1 },
      posts: { "counts.posts": -1 },
      active: { lastActiveAt: -1 },
    };

    const [users, total] = await Promise.all([
      User.find(query)
        .select(ADMIN_USER_SELECT)
        .sort(sortMap[sort] || sortMap.recent)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    return res.status(200).json({
      // Normalised so the client never has to guard against a missing role.
      users: users.map((u) => ({ ...u, role: roleOf(u) })),
      pageInfo: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("listUsers error:", error);
    return res.status(500).json({ error: "Failed to load users" });
  }
};

export const getUserDetail = async (req, res) => {
  try {
    const { username } = req.params;
    const found = await User.findOne({ username }).select(ADMIN_USER_SELECT).lean();
    if (!found) return res.status(404).json({ error: "User not found" });
    const user = { ...found, role: roleOf(found) };

    const [posts, comments, reportsAgainst, reportsFiled, recentPosts, actions] =
      await Promise.all([
        Post.countDocuments({ author: user._id, isDeleted: { $ne: true } }),
        Comment.countDocuments({
          author: user._id,
          isDeleted: { $ne: true },
          isScheduled: { $ne: true },
        }),
        Report.countDocuments({ targetOwner: user._id }),
        Report.countDocuments({ reporter: user._id }),
        Post.find({ author: user._id, isDeleted: { $ne: true } })
          .sort({ createdAt: -1 })
          .limit(5)
          .select("content media counts createdAt isEdited")
          .lean(),
        AuditLog.find({ targetType: "user", targetId: user._id })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
      ]);

    return res.status(200).json({
      user,
      stats: { posts, comments, reportsAgainst, reportsFiled },
      recentPosts,
      actions,
    });
  } catch (error) {
    console.error("getUserDetail error:", error);
    return res.status(500).json({ error: "Failed to load user" });
  }
};

/**
 * Shared guard for anything that acts on another account. Blocks self-targeting
 * and stops an admin from acting on a peer or a super_admin — only a
 * super_admin outranks staff.
 */
const loadActionTarget = async (req, res, username) => {
  const target = await User.findOne({ username }).select(
    "_id username name role accountStatus isVerified verificationBadge suspensionReason suspensionEndsAt"
  );

  if (!target) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (target._id.equals(req.user._id)) {
    res.status(400).json({ error: "You can't perform this action on yourself" });
    return null;
  }
  // roleOf, not target.role: undefined would read as "not a user" and make
  // every legacy account untouchable.
  if (roleOf(target) !== "user" && roleOf(req.user) !== "super_admin") {
    res.status(403).json({ error: "Only a super admin can act on staff accounts" });
    return null;
  }
  return target;
};

export const suspendUser = async (req, res) => {
  try {
    const target = await loadActionTarget(req, res, req.params.username);
    if (!target) return undefined;

    const { reason, days } = req.body;
    if (!reason?.trim()) {
      return res.status(400).json({ error: "A reason is required" });
    }

    // 0 or absent means indefinite.
    const durationDays = Number.parseInt(days, 10);
    const endsAt =
      Number.isFinite(durationDays) && durationDays > 0
        ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
        : null;

    target.accountStatus = "suspended";
    target.suspensionReason = reason.trim().slice(0, 500);
    target.suspensionEndsAt = endsAt;
    await target.save();

    // A suspension that leaves live sessions running isn't a suspension.
    await UserSession.deleteMany({ user: target._id });

    await recordAudit(req, {
      action: "user.suspend",
      targetType: "user",
      targetId: target._id,
      targetLabel: `@${target.username}`,
      details: { reason: target.suspensionReason, durationDays: durationDays || null },
    });

    return res.status(200).json({ message: `@${target.username} suspended` });
  } catch (error) {
    console.error("suspendUser error:", error);
    return res.status(500).json({ error: "Failed to suspend user" });
  }
};

export const unsuspendUser = async (req, res) => {
  try {
    const target = await loadActionTarget(req, res, req.params.username);
    if (!target) return undefined;

    if (target.accountStatus !== "suspended") {
      return res.status(400).json({ error: "That account isn't suspended" });
    }

    target.accountStatus = "active";
    target.suspensionReason = undefined;
    target.suspensionEndsAt = undefined;
    await target.save();

    await recordAudit(req, {
      action: "user.unsuspend",
      targetType: "user",
      targetId: target._id,
      targetLabel: `@${target.username}`,
    });

    return res.status(200).json({ message: `@${target.username} reinstated` });
  } catch (error) {
    console.error("unsuspendUser error:", error);
    return res.status(500).json({ error: "Failed to reinstate user" });
  }
};

const VERIFICATION_BADGES = ["none", "blue", "gold", "gray"];

export const setVerification = async (req, res) => {
  try {
    const target = await loadActionTarget(req, res, req.params.username);
    if (!target) return undefined;

    const { badge } = req.body;
    if (!VERIFICATION_BADGES.includes(badge)) {
      return res.status(400).json({ error: "Unknown verification badge" });
    }

    const previous = target.verificationBadge;
    target.verificationBadge = badge;
    target.isVerified = badge !== "none";
    await target.save();

    await recordAudit(req, {
      action: badge === "none" ? "user.unverify" : "user.verify",
      targetType: "user",
      targetId: target._id,
      targetLabel: `@${target.username}`,
      details: { from: previous, to: badge },
    });

    return res.status(200).json({
      message: badge === "none" ? "Verification removed" : `Verified (${badge})`,
    });
  } catch (error) {
    console.error("setVerification error:", error);
    return res.status(500).json({ error: "Failed to update verification" });
  }
};

/** super_admin only — see the route definition. */
export const setUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!["user", "admin", "super_admin"].includes(role)) {
      return res.status(400).json({ error: "Unknown role" });
    }

    const target = await User.findOne({ username: req.params.username }).select(
      "_id username role"
    );
    if (!target) return res.status(404).json({ error: "User not found" });

    // Guard against a super_admin demoting themselves and locking everyone out.
    if (target._id.equals(req.user._id)) {
      return res.status(400).json({ error: "You can't change your own role" });
    }

    if (roleOf(target) === role) {
      return res.status(400).json({ error: `@${target.username} is already ${role}` });
    }

    const previous = roleOf(target);
    target.role = role;
    await target.save();

    // Demoting someone should end their staff session immediately. The role is
    // read live from the database on every request, so this is belt-and-braces.
    if (role === "user") await UserSession.deleteMany({ user: target._id });

    await recordAudit(req, {
      action: "user.role_change",
      targetType: "user",
      targetId: target._id,
      targetLabel: `@${target.username}`,
      details: { from: previous, to: role },
    });

    return res.status(200).json({ message: `@${target.username} is now ${role}` });
  } catch (error) {
    console.error("setUserRole error:", error);
    return res.status(500).json({ error: "Failed to change role" });
  }
};

export const forceLogout = async (req, res) => {
  try {
    const target = await loadActionTarget(req, res, req.params.username);
    if (!target) return undefined;

    const { deletedCount } = await UserSession.deleteMany({ user: target._id });

    await recordAudit(req, {
      action: "user.force_logout",
      targetType: "user",
      targetId: target._id,
      targetLabel: `@${target.username}`,
      details: { sessionsRevoked: deletedCount },
    });

    return res
      .status(200)
      .json({ message: `Signed @${target.username} out of ${deletedCount} session(s)` });
  } catch (error) {
    console.error("forceLogout error:", error);
    return res.status(500).json({ error: "Failed to sign the user out" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Content
// ─────────────────────────────────────────────────────────────────────────────

export const listContent = async (req, res) => {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { search, type = "post", sort = "recent", reportedOnly } = req.query;

    const isComment = type === "comment";
    const Model = isComment ? Comment : Post;

    const query = { isDeleted: { $ne: true } };
    if (!isComment) query.isDraft = { $ne: true };
    if (search?.trim()) query.content = new RegExp(escapeRegex(search.trim()), "i");

    // Restrict to content that has actually been reported.
    if (reportedOnly === "true") {
      const ids = await Report.distinct("targetId", {
        targetType: isComment ? "comment" : "post",
      });
      query._id = { $in: ids };
    }

    const sortMap = {
      recent: { createdAt: -1 },
      oldest: { createdAt: 1 },
      likes: { "counts.likes": -1 },
      replies: { "counts.replies": -1 },
    };

    const [items, total] = await Promise.all([
      Model.find(query)
        .sort(sortMap[sort] || sortMap.recent)
        .skip((page - 1) * limit)
        .limit(limit)
        .select("content media counts createdAt isEdited editedAt isAiGenerated author post")
        .populate("author", "username name profilePic isVerified accountStatus")
        .lean(),
      Model.countDocuments(query),
    ]);

    // Report counts for just this page, so the table can flag hot items.
    const reportCounts = await Report.aggregate([
      {
        $match: {
          targetType: isComment ? "comment" : "post",
          targetId: { $in: items.map((i) => i._id) },
        },
      },
      { $group: { _id: "$targetId", count: { $sum: 1 } } },
    ]);
    const byId = new Map(reportCounts.map((r) => [r._id.toString(), r.count]));

    return res.status(200).json({
      items: items.map((i) => ({ ...i, reportCount: byId.get(i._id.toString()) || 0 })),
      pageInfo: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("listContent error:", error);
    return res.status(500).json({ error: "Failed to load content" });
  }
};

export const removeContent = async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!["post", "comment"].includes(type)) {
      return res.status(400).json({ error: "Unknown content type" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const { reason } = req.body;
    const Model = type === "comment" ? Comment : Post;

    const doc = await Model.findById(id).select("content author isDeleted");
    if (!doc || doc.isDeleted) {
      return res.status(404).json({ error: "Content not found" });
    }

    // Same staff protection as the user actions: an ordinary admin shouldn't be
    // able to delete a super_admin's content.
    const author = await User.findById(doc.author).select("username role");
    if (author && roleOf(author) !== "user" && roleOf(req.user) !== "super_admin") {
      return res.status(403).json({ error: "Only a super admin can remove staff content" });
    }

    // Soft delete, matching how authors delete their own posts — keeps thread
    // integrity and leaves the evidence in place for any linked reports.
    doc.isDeleted = true;
    doc.deletedAt = new Date();
    await doc.save();

    // Mirror the author-delete path, or the count stays inflated and the
    // profile cache keeps serving the removed post for up to 30s.
    if (type === "post") {
      await User.updateOne({ _id: doc.author }, { $inc: { "counts.posts": -1 } });
      if (author?.username) {
        await del(CacheKeys.userPosts(author.username)).catch(() => {});
      }
    }

    await recordAudit(req, {
      action: type === "comment" ? "comment.delete" : "post.delete",
      targetType: type,
      targetId: doc._id,
      targetLabel: excerpt(doc.content),
      details: { reason: reason?.trim()?.slice(0, 500) || null, author: doc.author },
    });

    return res.status(200).json({ message: `${type === "comment" ? "Comment" : "Post"} removed` });
  } catch (error) {
    console.error("removeContent error:", error);
    return res.status(500).json({ error: "Failed to remove content" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────

export const listReports = async (req, res) => {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status = "pending", category, targetType, sort = "recent" } = req.query;

    const query = {};
    if (status && status !== "all") query.status = status;
    if (category && category !== "all") query.category = category;
    if (targetType && targetType !== "all") query.targetType = targetType;

    const [reports, total] = await Promise.all([
      Report.find(query)
        .sort(sort === "oldest" ? { createdAt: 1 } : { createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("reporter", "username name profilePic")
        .populate("targetOwner", "username name profilePic accountStatus")
        .lean(),
      Report.countDocuments(query),
    ]);

    const settings = await getSettings();

    // How many total reports each of these targets has drawn — one report is
    // noise, eight is a pattern.
    const grouped = await Report.aggregate([
      { $match: { targetId: { $in: reports.map((r) => r.targetId).filter(Boolean) } } },
      { $group: { _id: "$targetId", count: { $sum: 1 } } },
    ]);
    const countByTarget = new Map(grouped.map((g) => [g._id.toString(), g.count]));

    const enriched = reports.map((r) => {
      const targetReports = r.targetId ? countByTarget.get(r.targetId.toString()) || 1 : 1;
      return {
        ...r,
        reasonLabel: getReasonLabelServer(r.category, r.subcategory),
        targetReports,
        urgent: targetReports >= settings.autoFlagReportThreshold,
      };
    });

    return res.status(200).json({
      reports: enriched,
      pageInfo: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("listReports error:", error);
    return res.status(500).json({ error: "Failed to load reports" });
  }
};

/** Fetches the reported content itself so a moderator can judge in context. */
export const getReportDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const report = await Report.findById(id)
      .populate("reporter", "username name profilePic")
      .populate("targetOwner", "username name profilePic accountStatus counts createdAt")
      .lean();
    if (!report) return res.status(404).json({ error: "Report not found" });

    let target = null;
    if (report.targetType === "post" && report.targetId) {
      target = await Post.findById(report.targetId)
        .select("content media counts createdAt isDeleted isEdited")
        .lean();
    } else if (report.targetType === "comment" && report.targetId) {
      target = await Comment.findById(report.targetId)
        .select("content media counts createdAt isDeleted isEdited post")
        .lean();
    }

    const siblings = await Report.find({
      targetType: report.targetType,
      targetId: report.targetId,
      targetKey: report.targetKey,
      _id: { $ne: report._id },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("reporter", "username profilePic")
      .lean();

    return res.status(200).json({
      report: {
        ...report,
        reasonLabel: getReasonLabelServer(report.category, report.subcategory),
      },
      target,
      siblings: siblings.map((s) => ({
        ...s,
        reasonLabel: getReasonLabelServer(s.category, s.subcategory),
      })),
    });
  } catch (error) {
    console.error("getReportDetail error:", error);
    return res.status(500).json({ error: "Failed to load report" });
  }
};

export const updateReportStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note, applyToAll } = req.body;

    if (!["pending", "reviewing", "actioned", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "Unknown status" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const report = await Report.findById(id);
    if (!report) return res.status(404).json({ error: "Report not found" });

    const previous = report.status;
    report.status = status;
    await report.save();

    // Resolving one report on a target usually means resolving all of them.
    let alsoUpdated = 0;
    if (applyToAll && ["actioned", "dismissed"].includes(status)) {
      const result = await Report.updateMany(
        {
          targetType: report.targetType,
          targetId: report.targetId,
          targetKey: report.targetKey,
          status: { $in: ["pending", "reviewing"] },
          _id: { $ne: report._id },
        },
        { $set: { status } }
      );
      alsoUpdated = result.modifiedCount || 0;
    }

    await recordAudit(req, {
      action: "report.status_change",
      targetType: "report",
      targetId: report._id,
      targetLabel: getReasonLabelServer(report.category, report.subcategory),
      details: {
        from: previous,
        to: status,
        note: note?.trim()?.slice(0, 500) || null,
        alsoUpdated,
      },
    });

    return res.status(200).json({
      message: alsoUpdated
        ? `Report ${status} — and ${alsoUpdated} other report(s) on the same target`
        : `Report ${status}`,
    });
  } catch (error) {
    console.error("updateReportStatus error:", error);
    return res.status(500).json({ error: "Failed to update report" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Platform (bug) reports
// ─────────────────────────────────────────────────────────────────────────────

export const listPlatformReports = async (req, res) => {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status = "pending" } = req.query;

    const query = status && status !== "all" ? { status } : {};

    const [reports, total] = await Promise.all([
      PlatformReport.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("user", "username name profilePic")
        .lean(),
      PlatformReport.countDocuments(query),
    ]);

    return res.status(200).json({
      reports,
      pageInfo: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("listPlatformReports error:", error);
    return res.status(500).json({ error: "Failed to load platform reports" });
  }
};

export const updatePlatformReportStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["pending", "reviewed", "resolved"].includes(status)) {
      return res.status(400).json({ error: "Unknown status" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const report = await PlatformReport.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true }
    ).lean();
    if (!report) return res.status(404).json({ error: "Report not found" });

    await recordAudit(req, {
      action: "report.status_change",
      targetType: "report",
      targetId: report._id,
      targetLabel: excerpt(report.message),
      details: { to: status, kind: "platform" },
    });

    return res.status(200).json({ message: `Marked ${status}` });
  } catch (error) {
    console.error("updatePlatformReportStatus error:", error);
    return res.status(500).json({ error: "Failed to update report" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

export const readSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    return res.status(200).json({ settings });
  } catch (error) {
    console.error("readSettings error:", error);
    return res.status(500).json({ error: "Failed to load settings" });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const current = await getSettings();
    const updates = {};
    const changed = [];

    // Only known keys, only correct types — anything else is dropped.
    for (const [key, type] of Object.entries(EDITABLE_SETTINGS)) {
      if (!(key in req.body)) continue;
      const value = req.body[key];

      if (type === "boolean") {
        if (typeof value !== "boolean") continue;
      } else if (type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
      } else if (typeof value !== "string") {
        continue;
      }

      if (current[key] !== value) {
        updates[key] = value;
        changed.push({ key, from: current[key], to: value });
      }
    }

    if (!changed.length) {
      return res.status(200).json({ message: "No changes", settings: current });
    }

    updates.updatedBy = req.user._id;

    const settings = await AppSettings.findOneAndUpdate(
      { key: SETTINGS_KEY },
      { $set: updates },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    invalidateSettingsCache();

    await recordAudit(req, {
      action: "settings.update",
      targetType: "settings",
      targetLabel: changed.map((c) => c.key).join(", "),
      details: { changed },
    });

    return res.status(200).json({ message: "Settings saved", settings });
  } catch (error) {
    console.error("updateSettings error:", error);
    return res.status(500).json({ error: "Failed to save settings" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

export const listAuditLog = async (req, res) => {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit, 50);
    const { action, actor, targetType } = req.query;

    const query = {};
    if (action && action !== "all") query.action = action;
    if (targetType && targetType !== "all") query.targetType = targetType;
    if (actor?.trim()) query.actorUsername = new RegExp(escapeRegex(actor.trim()), "i");

    const [entries, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("actor", "username name profilePic")
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return res.status(200).json({
      entries,
      pageInfo: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("listAuditLog error:", error);
    return res.status(500).json({ error: "Failed to load audit log" });
  }
};
