import mongoose from "mongoose";
import PlatformReport from "../models/PlatformReport.js";
import Report from "../models/Report.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Message from "../models/Message.js";
import GroupMember from "../models/GroupMember.js";
import User from "../models/User.js";
import { uploadToCloudinary } from "../config/cloudinary.js";
import {
  MAX_REPORT_DETAILS,
  REPORT_TARGET_TYPES,
  categoryRequiresDetails,
  validateReportReason,
} from "../utils/reportCategories.js";
import { contentVersionAt } from "../utils/editHistory.js";
import { normalizeTag } from "../utils/richText.js";

export const createPlatformReport = async (req, res) => {
  try {
    const { message, url, userAgent } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: "Please describe the problem" });
    }
    if (message.trim().length > 2000) {
      return res.status(400).json({ error: "Message must be under 2000 characters" });
    }

    let screenshotUrl = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.path);
      screenshotUrl = result.secure_url;
    }

    await PlatformReport.create({
      user: req.user?._id || null,
      message: message.trim(),
      screenshot: screenshotUrl,
      metadata: {
        url: url || null,
        userAgent: userAgent || null,
      },
    });

    return res.status(201).json({ message: "Report submitted. Thank you!" });
  } catch (error) {
    console.error("createPlatformReport error:", error);
    return res.status(500).json({ error: "Failed to submit report" });
  }
};

// Which identifier the client must send for each kind of target. Everything
// else is addressed by the peer's username.
const ID_TARGETS = new Set(["post", "comment", "message"]);

/**
 * Mongoose drops `undefined` from a filter and casts objects as operators, so
 * an absent or non-string identifier would otherwise match an arbitrary
 * document. Pin the shape down before it reaches a query.
 */
const validateTargetIdentifier = (targetType, targetId, username) => {
  if (ID_TARGETS.has(targetType)) {
    return mongoose.isValidObjectId(targetId) ? null : "Invalid report target";
  }
  // conversation and user use it as a handle; hashtag uses it as the tag.
  return typeof username === "string" && username.trim()
    ? null
    : "Invalid report target";
};

/**
 * Resolves what's being reported into { targetId, targetKey, targetOwner }, or
 * returns { error } if the target doesn't exist or isn't the reporter's to see.
 * `targetOwner` is the account responsible for the content, used for moderation
 * grouping.
 */
const resolveTarget = async (targetType, { targetId, username }, reporterId) => {
  switch (targetType) {
    case "post": {
      const post = await Post.findOne({ _id: targetId, isDeleted: { $ne: true } })
        .select("author editedAt createdAt")
        .lean();
      if (!post) return { error: "Post not found" };
      return {
        targetId: post._id,
        targetKey: null,
        targetOwner: post.author,
        versionAt: contentVersionAt(post),
      };
    }
    case "comment": {
      const comment = await Comment.findOne({ _id: targetId, isDeleted: { $ne: true } })
        .select("author editedAt createdAt")
        .lean();
      if (!comment) return { error: "Comment not found" };
      return {
        targetId: comment._id,
        targetKey: null,
        targetOwner: comment.author,
        versionAt: contentVersionAt(comment),
      };
    }
    case "message": {
      const message = await Message.findById(targetId)
        .select("sender receiver group isGroupMessage conversation editedAt createdAt")
        .lean();
      if (!message) return { error: "Message not found" };

      // You can only report a message you can actually see. Same 404 either
      // way, so probing for message ids tells an attacker nothing.
      const isParticipant = message.isGroupMessage
        ? !!(await GroupMember.exists({ group: message.group, user: reporterId }))
        : [message.sender, message.receiver].some((id) => id?.equals(reporterId));
      if (!isParticipant) return { error: "Message not found" };

      return {
        targetId: message._id,
        targetKey: message.conversation,
        targetOwner: message.sender,
        versionAt: contentVersionAt(message),
      };
    }
    case "conversation": {
      const peer = await User.findOne({ username }).select("_id").lean();
      if (!peer) return { error: "User not found" };

      const targetKey = Message.dmConversationKey(reporterId, peer._id);
      if (!(await Message.exists({ conversation: targetKey }))) {
        return { error: "Conversation not found" };
      }

      return { targetId: null, targetKey, targetOwner: peer._id };
    }
    case "user": {
      const user = await User.findOne({ username }).select("_id").lean();
      if (!user) return { error: "User not found" };
      return { targetId: user._id, targetKey: null, targetOwner: user._id };
    }
    /*
     * A hashtag has no document and no owner — it isn't anybody's, which is
     * rather the point of reporting one. Keyed by the tag, like a conversation
     * is keyed by its id, so repeat reports on the same tag group together in
     * the queue.
     *
     * The `username` field carries the tag: the request shape already has a
     * string slot for non-id targets, and adding a third identifier for one
     * case isn't worth it.
     */
    case "hashtag": {
      const tag = normalizeTag(username);
      if (!tag) return { error: "Invalid hashtag" };
      return { targetId: null, targetKey: `tag:${tag}`, targetOwner: null };
    }
    default:
      return { error: "Unknown report target" };
  }
};

// A report still in the queue blocks a repeat outright.
const OPEN_STATUSES = ["pending", "reviewing"];

/**
 * May this person report this target again?
 *
 * No previous report → yes. One still open → no. Otherwise the decision stands
 * unless the content has actually been edited since they reported it — that's
 * a different thing to what was reviewed, so it deserves a fresh look.
 *
 * Targets with no editable content (accounts, whole conversations) have no
 * `versionAt`; a decision there is final for that reporter.
 */
const canReportAgain = (report, target) => {
  if (!report) return true;
  if (OPEN_STATUSES.includes(report.status)) return false;
  if (!target.versionAt) return false;
  return new Date(target.versionAt) > new Date(report.createdAt);
};

const targetFilter = (reporterId, targetType, target) => ({
  reporter: reporterId,
  targetType,
  targetId: target.targetId,
  targetKey: target.targetKey,
});

// Most recent report whatever its status — what the status screen shows.
const findLatestReport = (reporterId, targetType, target) =>
  Report.findOne(targetFilter(reporterId, targetType, target))
    .select("status category subcategory createdAt")
    .sort({ createdAt: -1 })
    .lean();

/**
 * GET /reports/status — has the caller already reported this thing, where did
 * it get to, and may they report it again? Drives the "Awaiting review" /
 * "Decision made" screen.
 */
export const getReportStatus = async (req, res) => {
  try {
    const { targetType, targetId, username } = req.query;

    if (!REPORT_TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: "Unknown report target" });
    }
    const idError = validateTargetIdentifier(targetType, targetId, username);
    if (idError) return res.status(400).json({ error: idError });

    const target = await resolveTarget(targetType, { targetId, username }, req.user._id);
    if (target.error) return res.status(404).json({ error: target.error });

    const report = await findLatestReport(req.user._id, targetType, target);
    return res.status(200).json({
      report: report || null,
      canReportAgain: canReportAgain(report, target),
    });
  } catch (error) {
    console.error("getReportStatus error:", error);
    return res.status(500).json({ error: "Failed to load report status" });
  }
};

export const createReport = async (req, res) => {
  try {
    const { targetType, targetId, username, category, subcategory, details, url } = req.body;

    const reasonError = validateReportReason(targetType, category, subcategory || null);
    if (reasonError) return res.status(400).json({ error: reasonError });

    const idError = validateTargetIdentifier(targetType, targetId, username);
    if (idError) return res.status(400).json({ error: idError });

    const trimmedDetails = details?.trim() || null;
    if (trimmedDetails && trimmedDetails.length > MAX_REPORT_DETAILS) {
      return res
        .status(400)
        .json({ error: `Details must be under ${MAX_REPORT_DETAILS} characters` });
    }
    if (categoryRequiresDetails(category) && !trimmedDetails) {
      return res.status(400).json({ error: "Please tell us what's wrong" });
    }

    const target = await resolveTarget(targetType, { targetId, username }, req.user._id);
    if (target.error) return res.status(404).json({ error: target.error });

    if (target.targetOwner && target.targetOwner.equals(req.user._id)) {
      return res.status(400).json({ error: "You can't report your own content" });
    }

    // Same rule the status screen shows, enforced here so it can't be bypassed.
    const latest = await findLatestReport(req.user._id, targetType, target);
    if (!canReportAgain(latest, target)) {
      return res.status(200).json({ alreadyReported: true, report: latest });
    }

    await Report.create({
      reporter: req.user._id,
      targetType,
      targetId: target.targetId,
      targetKey: target.targetKey,
      targetOwner: target.targetOwner,
      category,
      subcategory: subcategory || null,
      details: trimmedDetails,
      metadata: {
        url: url || null,
        userAgent: req.get("user-agent") || null,
      },
    });

    return res.status(201).json({ message: "Thanks for reporting." });
  } catch (error) {
    console.error("createReport error:", error);
    return res.status(500).json({ error: "Failed to submit report" });
  }
};
