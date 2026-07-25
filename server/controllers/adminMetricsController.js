import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import User from "../models/User.js";
import Message from "../models/Message.js";
import Report from "../models/Report.js";
import PlatformReport from "../models/PlatformReport.js";
import Like from "../models/Like.js";
import Follow from "../models/Follow.js";
import Group from "../models/Group.js";
import { REPORT_CATEGORIES } from "../utils/reportCategories.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

/** Clamp a caller-supplied window so nobody can ask for a 10-year scan. */
const parseRange = (value, fallback = 30) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 365);
};

/** YYYY-MM-DD in UTC — the bucket key every timeseries groups by. */
const dayKey = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };

/**
 * Aggregations only return days that had data. Charts need an unbroken axis,
 * so gaps are filled with zeroes.
 */
const fillDays = (rows, days) => {
  const byDay = new Map(rows.map((r) => [r._id, r.count]));
  const out = [];
  const start = new Date(Date.now() - (days - 1) * DAY_MS);

  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: byDay.get(key) || 0 });
  }
  return out;
};

const countPerDay = async (Model, days, extraMatch = {}) => {
  const rows = await Model.aggregate([
    { $match: { createdAt: { $gte: daysAgo(days) }, ...extraMatch } },
    { $group: { _id: dayKey, count: { $sum: 1 } } },
  ]);
  return fillDays(rows, days);
};

/** Percentage change between two windows, guarding division by zero. */
const trend = (current, previous) => {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
};

const LIVE_POST = { isDeleted: { $ne: true }, isDraft: { $ne: true } };
// Mirrors LIVE_POST: a reply waiting for its scheduled time isn't in the
// thread yet, so counting it would inflate today's total and then count it
// again on the day it actually publishes.
const LIVE_COMMENT = { isDeleted: { $ne: true }, isScheduled: { $ne: true } };

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/metrics/overview
// ─────────────────────────────────────────────────────────────────────────────

export const getOverview = async (req, res) => {
  try {
    const days = parseRange(req.query.days, 30);
    const since = daysAgo(days);
    const prevSince = daysAgo(days * 2);

    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      newUsers,
      prevNewUsers,
      totalPosts,
      newPosts,
      prevNewPosts,
      totalComments,
      newComments,
      totalMessages,
      newMessages,
      pendingReports,
      reportsInReview,
      resolvedReports,
      openPlatformReports,
      totalGroups,
      dau,
      wau,
      mau,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] } }),
      User.countDocuments({ accountStatus: "suspended" }),
      User.countDocuments({ createdAt: { $gte: since } }),
      User.countDocuments({ createdAt: { $gte: prevSince, $lt: since } }),
      Post.countDocuments(LIVE_POST),
      Post.countDocuments({ ...LIVE_POST, createdAt: { $gte: since } }),
      Post.countDocuments({ ...LIVE_POST, createdAt: { $gte: prevSince, $lt: since } }),
      Comment.countDocuments(LIVE_COMMENT),
      Comment.countDocuments({ ...LIVE_COMMENT, createdAt: { $gte: since } }),
      Message.countDocuments({}),
      Message.countDocuments({ createdAt: { $gte: since } }),
      Report.countDocuments({ status: "pending" }),
      Report.countDocuments({ status: "reviewing" }),
      Report.countDocuments({ status: { $in: ["actioned", "dismissed"] } }),
      PlatformReport.countDocuments({ status: "pending" }),
      Group.countDocuments({}),
      User.countDocuments({ lastActiveAt: { $gte: daysAgo(1) } }),
      User.countDocuments({ lastActiveAt: { $gte: daysAgo(7) } }),
      User.countDocuments({ lastActiveAt: { $gte: daysAgo(30) } }),
    ]);

    return res.status(200).json({
      range: days,
      totals: {
        users: totalUsers,
        activeUsers,
        suspendedUsers,
        posts: totalPosts,
        comments: totalComments,
        messages: totalMessages,
        groups: totalGroups,
      },
      period: {
        newUsers,
        newPosts,
        newComments,
        newMessages,
      },
      trends: {
        users: trend(newUsers, prevNewUsers),
        posts: trend(newPosts, prevNewPosts),
      },
      activity: {
        dau,
        wau,
        mau,
        // Classic stickiness: what share of monthly actives show up daily.
        stickiness: mau ? Math.round((dau / mau) * 1000) / 10 : 0,
      },
      moderation: {
        pendingReports,
        reportsInReview,
        resolvedReports,
        openPlatformReports,
        queueDepth: pendingReports + reportsInReview,
      },
    });
  } catch (error) {
    console.error("getOverview error:", error);
    return res.status(500).json({ error: "Failed to load overview" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/metrics/growth
// ─────────────────────────────────────────────────────────────────────────────

export const getGrowth = async (req, res) => {
  try {
    const days = parseRange(req.query.days, 30);

    const [signups, posts, comments, messages, reports] = await Promise.all([
      countPerDay(User, days),
      countPerDay(Post, days, LIVE_POST),
      countPerDay(Comment, days, LIVE_COMMENT),
      countPerDay(Message, days),
      countPerDay(Report, days),
    ]);

    // Running total of accounts, seeded with everyone who existed before the
    // window so the curve starts at the real number rather than zero.
    const priorUsers = await User.countDocuments({ createdAt: { $lt: daysAgo(days) } });
    let running = priorUsers;
    const cumulativeUsers = signups.map((d) => {
      running += d.count;
      return { date: d.date, count: running };
    });

    return res.status(200).json({
      range: days,
      signups,
      posts,
      comments,
      messages,
      reports,
      cumulativeUsers,
    });
  } catch (error) {
    console.error("getGrowth error:", error);
    return res.status(500).json({ error: "Failed to load growth data" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/metrics/engagement
// ─────────────────────────────────────────────────────────────────────────────

export const getEngagement = async (req, res) => {
  try {
    const days = parseRange(req.query.days, 30);
    const since = daysAgo(days);

    const [likes, follows, hourly, topPosts, topAuthors, mediaSplit] = await Promise.all([
      countPerDay(Like, days),
      countPerDay(Follow, days, { status: "accepted" }),

      // Posting volume by hour of day — shows when the app is actually used.
      Post.aggregate([
        { $match: { ...LIVE_POST, createdAt: { $gte: since } } },
        { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      Post.find({ ...LIVE_POST, createdAt: { $gte: since } })
        .sort({ "counts.likes": -1, "counts.replies": -1 })
        .limit(10)
        .select("content counts createdAt author media")
        .populate("author", "username name profilePic isVerified")
        .lean(),

      Post.aggregate([
        { $match: { ...LIVE_POST, createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$author",
            posts: { $sum: 1 },
            likes: { $sum: "$counts.likes" },
            replies: { $sum: "$counts.replies" },
          },
        },
        { $sort: { posts: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "author",
            pipeline: [{ $project: { username: 1, name: 1, profilePic: 1, isVerified: 1 } }],
          },
        },
        { $unwind: { path: "$author", preserveNullAndEmptyArrays: true } },
      ]),

      Post.aggregate([
        { $match: { ...LIVE_POST, createdAt: { $gte: since } } },
        {
          $group: {
            _id: {
              $cond: [{ $gt: [{ $size: { $ifNull: ["$media", []] } }, 0] }, "media", "text"],
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    // Every hour present, so the bar chart has 24 columns.
    const byHour = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hourly.find((h) => h._id === hour)?.count || 0,
    }));

    return res.status(200).json({
      range: days,
      likes,
      follows,
      byHour,
      topPosts,
      topAuthors,
      mediaSplit: {
        media: mediaSplit.find((m) => m._id === "media")?.count || 0,
        text: mediaSplit.find((m) => m._id === "text")?.count || 0,
      },
    });
  } catch (error) {
    console.error("getEngagement error:", error);
    return res.status(500).json({ error: "Failed to load engagement data" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/metrics/moderation
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_LABELS = new Map(REPORT_CATEGORIES.map((c) => [c.id, c.label]));

export const getModerationMetrics = async (req, res) => {
  try {
    const days = parseRange(req.query.days, 30);
    const since = daysAgo(days);

    const [byCategory, byTargetType, byStatus, perDay, resolutionTimes, repeatOffenders] =
      await Promise.all([
        Report.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: "$category", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),

        Report.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: "$targetType", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),

        Report.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),

        countPerDay(Report, days),

        // Mean hours from report to resolution, for reports closed in-window.
        Report.aggregate([
          {
            $match: {
              status: { $in: ["actioned", "dismissed"] },
              updatedAt: { $gte: since },
            },
          },
          {
            $project: {
              hours: {
                $divide: [{ $subtract: ["$updatedAt", "$createdAt"] }, 1000 * 60 * 60],
              },
            },
          },
          { $group: { _id: null, avgHours: { $avg: "$hours" }, resolved: { $sum: 1 } } },
        ]),

        // Accounts drawing the most reports — the queue's real signal.
        Report.aggregate([
          { $match: { createdAt: { $gte: since }, targetOwner: { $ne: null } } },
          { $group: { _id: "$targetOwner", reports: { $sum: 1 } } },
          { $sort: { reports: -1 } },
          { $limit: 10 },
          {
            $lookup: {
              from: "users",
              localField: "_id",
              foreignField: "_id",
              as: "user",
              pipeline: [
                {
                  $project: {
                    username: 1,
                    name: 1,
                    profilePic: 1,
                    accountStatus: 1,
                    isVerified: 1,
                  },
                },
              ],
            },
          },
          { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        ]),
      ]);

    return res.status(200).json({
      range: days,
      byCategory: byCategory.map((c) => ({
        id: c._id,
        label: CATEGORY_LABELS.get(c._id) || c._id,
        count: c.count,
      })),
      byTargetType: byTargetType.map((t) => ({ id: t._id, count: t.count })),
      byStatus: ["pending", "reviewing", "actioned", "dismissed"].map((status) => ({
        status,
        count: byStatus.find((s) => s._id === status)?.count || 0,
      })),
      perDay,
      avgResolutionHours: resolutionTimes[0]?.avgHours
        ? Math.round(resolutionTimes[0].avgHours * 10) / 10
        : 0,
      resolvedInPeriod: resolutionTimes[0]?.resolved || 0,
      repeatOffenders,
    });
  } catch (error) {
    console.error("getModerationMetrics error:", error);
    return res.status(500).json({ error: "Failed to load moderation data" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/metrics/retention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weekly signup cohorts and how many of each are still active, using
 * `lastActiveAt`. A true event-based retention curve would need a per-day
 * activity log we don't keep; this is the honest approximation available.
 */
export const getRetention = async (req, res) => {
  try {
    const weeks = Math.min(Math.max(Number.parseInt(req.query.weeks, 10) || 8, 1), 26);
    const activeSince = daysAgo(7);

    // All windows in parallel — serially this was up to 52 round-trips.
    const cohorts = await Promise.all(
      Array.from({ length: weeks }, (_, idx) => {
        const i = weeks - 1 - idx;
        const start = daysAgo((i + 1) * 7);
        const end = daysAgo(i * 7);

        return Promise.all([
          User.countDocuments({ createdAt: { $gte: start, $lt: end } }),
          User.countDocuments({
            createdAt: { $gte: start, $lt: end },
            lastActiveAt: { $gte: activeSince },
            accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] },
          }),
        ]).then(([size, stillActive]) => ({
          weekStart: start.toISOString().slice(0, 10),
          size,
          stillActive,
          retention: size ? Math.round((stillActive / size) * 1000) / 10 : 0,
        }));
      })
    );

    return res.status(200).json({ weeks, cohorts });
  } catch (error) {
    console.error("getRetention error:", error);
    return res.status(500).json({ error: "Failed to load retention data" });
  }
};
