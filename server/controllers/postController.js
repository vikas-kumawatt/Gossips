import mongoose from "mongoose";
import { StatusCodes } from "http-status-codes";
import Post from "../models/Post.js";
import User from "../models/User.js";
import Comment from "../models/Comment.js";
import Notification from "../models/Notification.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import PostView from "../models/PostView.js";
import Saved from "../models/Saved.js";
import PollVote from "../models/PollVote.js";
import Follow from "../models/Follow.js";
import NotInterested from "../models/NotInterested.js";
import UserRelation from "../models/UserRelation.js";
import {
  buildCursorPageInfo,
  buildCursorQuery,
  decodeCursor,
  encodeCursor,
  parseCursorLimit,
} from "../utils/cursorPagination.js";
import { sendNotification } from "../utils/notifications.js";
import { uploadMedia } from "../utils/uploadFiles.js";
import { decorateContent, openPollClock, parseAttachments } from "../utils/attachments.js";
import { loadRepostFeedEntries, mergeFeedEntries } from "../utils/feedReposts.js";
import { normalizeMedia } from "../utils/mediaTypes.js";
import { getOrSet, del, CacheKeys } from "../utils/cache.js";
import { resolveMentions } from "../utils/mentions.js";
import { parseHashtags } from "../utils/hashtags.js";
import { MAX_CONTENT_LENGTH, buildVersionList } from "../utils/editHistory.js";
import { parseBooleanFlag } from "../utils/booleanFlag.js";
import {
  normalizeActivitySort,
  rankedActivityPage,
  rankActivityInMemory,
} from "../utils/activitySort.js";
import {
  canUserReplyToTarget,
  viewerCanReplyFromSets,
  normalizeWhoCanReply,
  replyDeniedMessage,
} from "../utils/replyPermission.js";
import {
  applyPostPublishEffects,
  captureQuotedSnapshot,
  parseScheduledFor,
} from "../utils/publishing.js";

// ── Author populate select (used in many queries) ─────────────────────────────
const AUTHOR_SELECT = "_id username name bio profilePic isVerified verificationBadge isPrivate";

// The shape a single post is returned in after create/edit.
const populatePost = (postId) =>
  Post.findById(postId)
    .populate("author", AUTHOR_SELECT)
    .populate({
      path: "quotedPost",
      populate: { path: "author", select: AUTHOR_SELECT },
    })
    .populate({
      path: "quotedComment",
      select: "content media poll location author createdAt post counts isEdited editedAt isAiGenerated",
      populate: { path: "author", select: AUTHOR_SELECT },
    })
    .lean();

/**
 * Reuses selected media from the caller's own saved draft. The client sends
 * URLs only as an allow-listed selection; the database remains the source of
 * the actual typed media payload, so this cannot be used to attach someone
 * else's or an arbitrary remote asset.
 */
const loadDraftMedia = async ({ sourceDraftId, sourceDraftMedia, userId }) => {
  if (!sourceDraftId) return { media: [] };
  if (!mongoose.isValidObjectId(sourceDraftId)) {
    return { error: "That draft isn't valid", status: StatusCodes.BAD_REQUEST };
  }

  let requestedUrls;
  try {
    requestedUrls = typeof sourceDraftMedia === "string"
      ? JSON.parse(sourceDraftMedia)
      : sourceDraftMedia;
  } catch {
    return { error: "That draft media isn't valid", status: StatusCodes.BAD_REQUEST };
  }
  if (!Array.isArray(requestedUrls) || !requestedUrls.length || requestedUrls.length > 5 ||
      requestedUrls.some((url) => typeof url !== "string" || !url)) {
    return { error: "That draft media isn't valid", status: StatusCodes.BAD_REQUEST };
  }

  const sourceDraft = await Post.findOne({
    _id: sourceDraftId,
    author: userId,
    isDraft: true,
    scheduleStatus: null,
  })
    .select("media")
    .lean();
  if (!sourceDraft) return { error: "That draft isn't available", status: StatusCodes.NOT_FOUND };

  const available = normalizeMedia(sourceDraft.media);
  const requested = new Set(requestedUrls);
  const media = available.filter((item) => requested.has(item.url));
  if (media.length !== requested.size || media.length !== requestedUrls.length) {
    return { error: "That draft media isn't available", status: StatusCodes.BAD_REQUEST };
  }
  return { media };
};

// ─────────────────────────────────────────────────────────────────────────────
// Create / Save-draft / Drafts
// ─────────────────────────────────────────────────────────────────────────────

export const createPost = async (req, res) => {
  try {
    const {
      content,
      icon,
      parentGossip,
      quotedPost,
      quotedComment,
      isQuoteRepost,
      isQuoteComment,
      isDraft,
      whoCanReply,
      isAiGenerated,
      scheduledFor,
      sourceDraftId,
      sourceDraftMedia,
    } = req.body;
    const userId = req.user.id;

    if (isDraft === "true") {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Use save-draft endpoint for drafts",
      });
    }

    const { at: scheduleAt, error: scheduleError } = parseScheduledFor(scheduledFor);
    if (scheduleError) {
      return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: scheduleError });
    }

    /*
     * Enforce the audience setting of the post/comment being quoted.
     *
     * The lookup excludes anything not yet public. Without that, the author of
     * a scheduled post could quote it themselves and the quote — which renders
     * a populated copy of its target in every feed — would publish its contents
     * hours early. A missing target is rejected outright rather than waved
     * through, so an id that resolves to nothing can't skip the audience check.
     */
    if (isQuoteRepost === "true" || isQuoteRepost === true) {
      if (quotedPost) {
        const target = await Post.findOne({
          _id: quotedPost,
          isDraft: { $ne: true },
          isDeleted: { $ne: true },
        })
          .select("author whoCanReply mentions")
          .lean();
        if (!target) {
          return res.status(StatusCodes.NOT_FOUND).json({
            success: false,
            message: "That post isn't available to quote",
          });
        }
        if (!(await canUserReplyToTarget(userId, target))) {
          return res.status(StatusCodes.FORBIDDEN).json({
            success: false,
            message: replyDeniedMessage(target.whoCanReply, "quote"),
          });
        }
      }
    }
    if (isQuoteComment === "true" || isQuoteComment === true) {
      if (quotedComment) {
        const target = await Comment.findOne({
          _id: quotedComment,
          isScheduled: { $ne: true },
          isDeleted: { $ne: true },
        })
          .select("author whoCanReply mentions")
          .lean();
        if (!target) {
          return res.status(StatusCodes.NOT_FOUND).json({
            success: false,
            message: "That comment isn't available to quote",
          });
        }
        if (!(await canUserReplyToTarget(userId, target))) {
          return res.status(StatusCodes.FORBIDDEN).json({
            success: false,
            message: replyDeniedMessage(target.whoCanReply, "quote"),
          });
        }
      }
    }

    // Uploads, GIF, poll and location, with the one-attachment rule applied.
    const attached = await parseAttachments({
      files: req.files || [],
      body: req.body,
      uploader: uploadMedia,
    });
    if (attached.error) {
      return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: attached.error });
    }

    const reused = !attached.media.length && !attached.poll
      ? await loadDraftMedia({ sourceDraftId, sourceDraftMedia, userId })
      : { media: [] };
    if (reused.error) {
      return res.status(reused.status).json({ success: false, message: reused.error });
    }
    const media = attached.media.length ? attached.media : reused.media;

    const newPost = {
      author: userId,
      content: content || "",
      icon: icon || "",
      parentGossip: parentGossip || null,
      quotedPost: quotedPost || null,
      quotedComment: quotedComment || null,
      isQuoteRepost: isQuoteRepost || false,
      isQuoteComment: isQuoteComment || false,
      whoCanReply: normalizeWhoCanReply(whoCanReply),
      mentions: await resolveMentions(content || ""),
      isAiGenerated: parseBooleanFlag(isAiGenerated),
      media,
      location: attached.location,
      // The poll's clock starts when the post goes public, so a scheduled poll
      // isn't already half over by the time anyone can see it. Immediate posts
      // start it right here; the publisher does it for scheduled ones.
      poll: attached.poll && !scheduleAt ? openPollClock(attached.poll) : attached.poll,
      // Enough for the scheduled-post card to render a preview. The version
      // that counts is re-captured at publish time, since that's when the
      // quote actually goes public.
      quotedSnapshot: await captureQuotedSnapshot(quotedPost, quotedComment),
      // A scheduled post rides the draft flag so every feed and profile query —
      // all of which already exclude drafts — hides it with no new filter.
      isDraft: Boolean(scheduleAt),
      scheduledFor: scheduleAt,
      scheduleStatus: scheduleAt ? "pending" : null,
    };

    // A poll or a location tag is content in its own right — a poll with no
    // caption is perfectly normal.
    const hasSomething =
      content || newPost.media.length || newPost.poll || newPost.location || quotedComment || quotedPost;
    if (!hasSomething) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Post must have content, media, a poll or a quote",
      });
    }

    const post = await Post.create(newPost);

    // A scheduled post is inert until the publisher picks it up: no counters,
    // no notifications, nothing visible. Those all happen at publish time.
    if (scheduleAt) {
      return res.status(StatusCodes.CREATED).json({
        success: true,
        scheduled: true,
        message: "Post scheduled",
        post: await decorateContent(await populatePost(post._id), userId),
      });
    }

    // Counters, quote notifications and the profile cache — the same routine
    // the scheduled publisher runs, so the two can't drift apart.
    await applyPostPublishEffects(post, { authorUsername: req.user.username });

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Post created successfully",
      post: await decorateContent(await populatePost(post._id), userId),
    });
  } catch (error) {
    console.error("createPost error:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to create post" });
  }
};

export const saveDraft = async (req, res) => {
  try {
    const {
      content,
      quotedPost,
      quotedComment,
      isQuoteRepost,
      isQuoteComment,
      whoCanReply,
      isAiGenerated,
      sourceDraftId,
      sourceDraftMedia,
    } = req.body;
    const userId = req.user.id;

    const attached = await parseAttachments({
      files: req.files || [],
      body: req.body,
      uploader: uploadMedia,
    });
    if (attached.error) {
      return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: attached.error });
    }

    const reused = !attached.media.length && !attached.poll
      ? await loadDraftMedia({ sourceDraftId, sourceDraftMedia, userId })
      : { media: [] };
    if (reused.error) {
      return res.status(reused.status).json({ success: false, message: reused.error });
    }
    const media = attached.media.length ? attached.media : reused.media;

    const newDraft = {
      author: userId,
      content: content || "",
      quotedPost: quotedPost || null,
      quotedComment: quotedComment || null,
      isQuoteRepost: isQuoteRepost || false,
      isQuoteComment: isQuoteComment || false,
      whoCanReply: normalizeWhoCanReply(whoCanReply),
      mentions: await resolveMentions(content || ""),
      media,
      location: attached.location,
      // Left unopened — a draft's poll starts counting down when it's posted,
      // however long it sits here first.
      poll: attached.poll,
      // So the draft card renders the version that was quoted. The published
      // post gets a fresh snapshot in createPost, since that's when the quote
      // actually goes public.
      quotedSnapshot: await captureQuotedSnapshot(quotedPost, quotedComment),
      isAiGenerated: parseBooleanFlag(isAiGenerated),
      isDraft: true,
    };

    const hasSomething =
      content || newDraft.media.length || newDraft.poll || newDraft.location || quotedPost || quotedComment;
    if (!hasSomething) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Draft must have content, media, a poll or a quote",
      });
    }

    const draft = await Post.create(newDraft);
    res.status(StatusCodes.CREATED).json({ success: true, message: "Draft saved successfully", draft });
  } catch (error) {
    console.error("saveDraft error:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to save draft" });
  }
};

export const getDrafts = async (req, res) => {
  try {
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    // Scheduled posts are stored as drafts too, but they have their own page —
    // they'd be confusing here, and deleting one from Drafts would silently
    // cancel a schedule.
    const draftsRaw = await Post.find({
      author: req.user.id,
      isDraft: true,
      scheduleStatus: null,
      ...cursorQuery,
    })
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "quotedPost",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .populate({
        path: "quotedComment",
        select: "content media poll location author createdAt post counts isEdited editedAt isAiGenerated",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const { items: drafts, pageInfo } = buildCursorPageInfo(draftsRaw, limitNum);
    // Your own drafts, so the poll projection always reveals — you're the author.
    res.status(200).json({ drafts: await decorateContent(drafts, req.user.id), pageInfo });
  } catch (error) {
    console.error("getDrafts error:", error);
    res.status(500).json({ error: "Failed to fetch drafts" });
  }
};

export const deleteDraft = async (req, res) => {
  try {
    const draft = await Post.findOne({
      _id: req.params.id,
      author: req.user.id,
      isDraft: true,
      scheduleStatus: null,
    });
    if (!draft) return res.status(StatusCodes.NOT_FOUND).json({ message: "Draft not found" });

    await Post.findByIdAndDelete(req.params.id);
    res.status(StatusCodes.OK).json({ message: "Draft deleted successfully" });
  } catch (error) {
    console.error("deleteDraft error:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to delete draft" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Feed
// ─────────────────────────────────────────────────────────────────────────────

export const getHomeFeed = async (req, res) => {
  try {
    const userId = req.user._id;
    const { type, cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    // Viewer's following list
    const followEdges = await Follow.find({ follower: userId, status: "accepted" })
      .select("following").lean();
    const followingIds = followEdges.map((e) => e.following);
    const followingSet = new Set(followingIds.map((id) => id.toString()));

    // "Not interested" feedback: dismissed posts are hidden, and the authors /
    // hashtags from those posts become negative signals used to down-rank similar
    // posts within each page.
    const niRows = await NotInterested.find({ user: userId })
      .select("post author hashtags")
      .lean();
    const dismissedPostIds = niRows.map((r) => r.post);
    const negativeAuthors = new Set(niRows.map((r) => r.author?.toString()).filter(Boolean));
    const negativeHashtags = new Set(niRows.flatMap((r) => r.hashtags || []));

    // Hidden authors:
    //  - accounts the viewer muted or blocked  (from: viewer)
    //  - accounts that blocked the viewer       (to: viewer, kind: block)
    const [outgoingHidden, incomingBlocks] = await Promise.all([
      UserRelation.find({ from: userId, kind: { $in: ["mute", "block"] } }).select("to").lean(),
      UserRelation.find({ to: userId, kind: "block" }).select("from").lean(),
    ]);
    const hiddenAuthorIds = [
      ...outgoingHidden.map((r) => r.to),
      ...incomingBlocks.map((r) => r.from),
    ];

    let query = { isDraft: { $ne: true }, isDeleted: { $ne: true } };
    if (dismissedPostIds.length) query._id = { $nin: dismissedPostIds };
    // Use $and for the author exclusion so it survives the type-based
    // `query.author = { $in: ... }` assignment below (mute/block must always apply).
    if (hiddenAuthorIds.length) query.$and = [{ author: { $nin: hiddenAuthorIds } }];

    if (type === "following" || type === "latest") {
      query.author = { $in: followingIds };
    } else if (type === "favorites") {
      // Favorites are stored in UserSettings.chat.favoriteChats — import lazily to avoid circular dep
      const { default: UserSettings } = await import("../models/UserSettings.js");
      const settings = await UserSettings.findOne({ user: userId })
        .select("chat.favoriteChats").lean();
      const raw = settings?.chat?.favoriteChats || [];
      const { Types } = await import("mongoose");
      const favoriteAuthorIds = raw
        .map((id) => {
          const s = typeof id === "string" ? id : id?.toString?.();
          if (!s || !s.startsWith("user_")) return null;
          const hex = s.slice(5);
          return Types.ObjectId.isValid(hex) ? new Types.ObjectId(hex) : null;
        })
        .filter(Boolean);
      if (!favoriteAuthorIds.length) {
        return res.status(200).json({ posts: [], pageInfo: { hasNextPage: false, nextCursor: null } });
      }
      query.author = { $in: favoriteAuthorIds };
    }

    const [feedMeta] = await Post.aggregate([
      { $match: query },
      {
        $lookup: {
          from: "users",
          localField: "author",
          foreignField: "_id",
          as: "authorDoc",
        },
      },
      { $unwind: "$authorDoc" },
      {
        $match: {
          $or: [
            { "authorDoc.isPrivate": false },
            { author: userId },
            { author: { $in: followingIds } },
          ],
        },
      },
      {
        $facet: {
          paginatedIds: [
            // `_id` matches the merge's tiebreak, so which posts the facet
            // returns under a same-millisecond tie is deterministic.
            { $sort: { createdAt: -1, _id: -1 } },
            { $match: cursorQuery },
            { $limit: limitNum + 1 },
            { $project: { _id: 1, createdAt: 1 } },
          ],
        },
      },
    ]);

    /*
     * Reposts from the accounts this tab is scoped to, merged into the same
     * stream. An original sits at its own createdAt; a repost sits at the
     * moment it was reposted, so the two are separate chronologies that
     * merge-sort into one — see utils/feedReposts.js for why that's exact
     * rather than approximate.
     *
     * "all" has no author scope of its own, so reposts there come from the
     * people you follow, which is the only sensible reading of "reposts in my
     * feed" on an unscoped tab.
     */
    const hiddenSet = new Set(hiddenAuthorIds.map((id) => id.toString()));
    const reposterIds = (
      type === "favorites" ? query.author?.$in || [] : followingIds
    ).filter((id) => !hiddenSet.has(id.toString()));

    const { entries: repostEntries, floor: repostFloor } = await loadRepostFeedEntries({
      reposterIds,
      cursorQuery,
      limit: limitNum,
      visibility: {
        viewerId: userId,
        followingIds,
        excludedAuthorIds: hiddenAuthorIds,
        dismissedPostIds: dismissedPostIds.filter(Boolean),
      },
    });

    const postEntries = (feedMeta?.paginatedIds || []).map((d) => ({
      sortAt: d.createdAt,
      sortId: d._id,
      postId: d._id.toString(),
      repostedBy: null,
    }));

    const entries = mergeFeedEntries(postEntries, repostEntries, limitNum);

    /*
     * Saturation of either source decides whether there's more, not the length
     * of the merged page. The merge drops duplicate posts, so a viral post
     * reposted by eleven followees collapses to one entry — reading that as
     * "nothing left" would end the feed after a single card.
     */
    const hasNextPage =
      entries.length > limitNum ||
      postEntries.length > limitNum ||
      repostEntries.length > limitNum;

    let visibleEntries = entries.slice(0, limitNum);

    /*
     * The repost window was examined only down to `repostFloor`; anything
     * older is unseen. Letting the cursor past it would skip those reposts
     * permanently, so the page stops there instead — short, but complete.
     */
    if (repostFloor) {
      const floorTime = new Date(repostFloor).getTime();
      const clamped = visibleEntries.filter(
        (e) => new Date(e.sortAt).getTime() >= floorTime
      );
      // Never clamp to nothing, or paging can't advance at all.
      if (clamped.length) visibleEntries = clamped;
    }
    const orderedIds = [...new Set(visibleEntries.map((e) => e.postId))];

    const posts = orderedIds.length
      ? await Post.find({ _id: { $in: orderedIds } })
          .select("_id author content icon media poll location counts quotedPost quotedComment quotedSnapshot isQuoteRepost isQuoteComment createdAt hideLikeShareCount whoCanReply mentions isEdited editedAt isAiGenerated")
          .populate("author", AUTHOR_SELECT)
          .populate({
            path: "quotedPost",
            select: "_id author content media poll location counts isQuoteRepost isQuoteComment createdAt hideLikeShareCount isEdited editedAt isAiGenerated",
            populate: { path: "author", select: AUTHOR_SELECT },
          })
          .populate({
            path: "quotedComment",
            select: "_id content media poll location counts author createdAt post hideLikeShareCount isEdited editedAt isAiGenerated",
            populate: { path: "author", select: AUTHOR_SELECT },
          })
          .lean()
      : [];

    const postMap = new Map(posts.map((p) => [p._id.toString(), p]));

    /*
     * A repost renders the original post with an attribution line, so the
     * fields are stamped onto the post itself rather than wrapping it — the
     * feed response stays a flat array of posts, and PostCard already reads
     * `isRepost` / `reposterUsername` off the item.
     *
     * `feedId` is what makes an entry unique: the same post can legitimately
     * appear as someone's repost and, later, on its own. Keying the client's
     * dedupe on the post id would silently drop the second one.
     */
    const orderedPosts = visibleEntries
      .map((entry) => {
        const post = postMap.get(entry.postId);
        if (!post) return null;
        if (!entry.repostedBy) return { ...post, feedId: post._id.toString() };
        return {
          ...post,
          feedId: entry.sortId.toString(),
          isRepost: true,
          reposterUsername: entry.repostedBy.username,
          reposterName: entry.repostedBy.name || "",
          reposterProfilePic: entry.repostedBy.profilePic || "",
          repostedAt: entry.sortAt,
        };
      })
      .filter(Boolean);

    // Batch viewer like/repost/save status
    const [likedEdges, repostedEdges, savedEdges] = orderedPosts.length
      ? await Promise.all([
          Like.find({ user: userId, targetType: "Post", target: { $in: orderedIds } }).select("target").lean(),
          Repost.find({ user: userId, targetType: "Post", target: { $in: orderedIds } }).select("target").lean(),
          Saved.find({ user: userId, post: { $in: orderedIds } }).select("post").lean(),
        ])
      : [[], [], []];

    const likedSet = new Set(likedEdges.map((l) => l.target.toString()));
    const repostedSet = new Set(repostedEdges.map((r) => r.target.toString()));
    const savedSet = new Set(savedEdges.map((s) => s.post.toString()));

    // Batched follow-back lookup for the "following" reply audience (author → viewer),
    // scoped to the authors on this page. `followingSet` (viewer → author) already
    // covers the "followers" audience, so no per-post DB lookups are needed.
    const pageAuthorIds = [
      ...new Set(
        orderedPosts.map((p) => (p.author?._id ?? p.author)?.toString()).filter(Boolean)
      ),
    ];
    const followBackEdges = pageAuthorIds.length
      ? await Follow.find({
          follower: { $in: pageAuthorIds },
          following: userId,
          status: "accepted",
        })
          .select("follower")
          .lean()
      : [];
    const followerSet = new Set(followBackEdges.map((e) => e.follower.toString()));

    const postsWithViewer = orderedPosts.map((p) => ({
      ...p,
      viewerHasLiked: likedSet.has(p._id.toString()),
      viewerHasReposted: repostedSet.has(p._id.toString()),
      viewerHasSaved: savedSet.has(p._id.toString()),
      viewerIsFollowingAuthor: followingSet.has((p.author?._id ?? p.author)?.toString()),
      viewerCanReply: viewerCanReplyFromSets(p, userId, { followingSet, followerSet }),
    }));

    /*
     * The boundary is the last entry in merged order, before the down-rank
     * shuffle. For a repost that's the repost's own date and id, not the
     * post's — using the post's would rewind the cursor to whenever the
     * original was written and re-serve everything since.
     */
    const lastEntry = visibleEntries[visibleEntries.length - 1];
    const cursorSource = lastEntry
      ? { createdAt: lastEntry.sortAt, _id: lastEntry.sortId }
      : null;

    // Soft down-rank: stable-partition posts matching a negative author/hashtag
    // signal to the bottom of the page (they're shown less prominently, not removed).
    const isDownRanked = (p) => {
      const authorId = (p.author?._id ?? p.author)?.toString();
      if (negativeAuthors.has(authorId)) return true;
      if (negativeHashtags.size) {
        const tags = parseHashtags(p.content || "");
        if (tags.some((t) => negativeHashtags.has(t))) return true;
      }
      return false;
    };
    const rankedPosts =
      negativeAuthors.size || negativeHashtags.size
        ? [
            ...postsWithViewer.filter((p) => !isDownRanked(p)),
            ...postsWithViewer.filter((p) => isDownRanked(p)),
          ]
        : postsWithViewer;

    res.status(200).json({
      // Typed media, and poll results reduced to what this reader may see.
      posts: await decorateContent(rankedPosts, userId),
      pageInfo: {
        hasNextPage,
        nextCursor: hasNextPage && cursorSource ? encodeCursor(cursorSource) : null,
      },
    });
  } catch (error) {
    console.error("getHomeFeed error:", error);
    res.status(500).json({ error: "Failed to fetch home feed" });
  }
};

export const getUserPosts = async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const isFirstPage = !cursor;

    // Block gating: if either side blocks, the viewer can't load these posts.
    const profileUser = await User.findOne({ username }).select("_id").lean();
    if (!profileUser) return res.status(404).json({ error: "User not found" });
    const requesterId = req.user?._id ?? req.user?.id;
    if (
      requesterId &&
      profileUser._id.toString() !== requesterId.toString() &&
      (await UserRelation.eitherBlocks(requesterId, profileUser._id))
    ) {
      return res.status(200).json({ posts: [], pageInfo: { hasNextPage: false, nextCursor: null } });
    }

    const fetchPage = async () => {
      const user = await User.findOne({ username }).select("_id").lean();
      if (!user) return null;

      const parsedCursor = decodeCursor(cursor);
      const cursorQuery = buildCursorQuery(parsedCursor);

      const posts = await Post.find({
        author: user._id,
        isDraft: { $ne: true },
        isDeleted: { $ne: true },
        ...cursorQuery,
      })
        .populate("author", AUTHOR_SELECT)
        .populate({
          path: "quotedPost",
          populate: { path: "author", select: AUTHOR_SELECT },
        })
        .populate({
          path: "quotedComment",
          select: "content media poll location author createdAt post counts isEdited editedAt isAiGenerated",
          populate: { path: "author", select: AUTHOR_SELECT },
        })
        .sort({ createdAt: -1 })
        .limit(limitNum + 1)
        .lean();

      const { items: pagedPosts, pageInfo } = buildCursorPageInfo(posts, limitNum);
      return { posts: pagedPosts, pageInfo };
    };

    const result = isFirstPage
      ? await getOrSet(CacheKeys.userPosts(username), 30, fetchPage)
      : await fetchPage();

    if (!result) return res.status(404).json({ error: "User not found" });

    /*
     * Decorated after the cache, never inside it. The cached page is shared by
     * every reader, so a poll projection baked into it would show one person's
     * "you voted for B" to everyone else.
     */
    result.posts = await decorateContent(result.posts, req.user?._id);

    // Attach viewer like/repost/save status
    const viewerId = req.user?._id;
    if (viewerId && result.posts?.length) {
      const postIds = result.posts.map((p) => p._id.toString());
      const authorId = result.posts[0].author?._id ?? result.posts[0].author;
      // All posts here share one author, so the two follow edges (viewer → author
      // and author → viewer) fully determine the "followers"/"following" audiences
      // for the whole page — no per-post DB lookups.
      const [likedEdges, repostedEdges, savedEdges, followEdge, followBackEdge] = await Promise.all([
        Like.find({ user: viewerId, targetType: "Post", target: { $in: postIds } }).select("target").lean(),
        Repost.find({ user: viewerId, targetType: "Post", target: { $in: postIds } }).select("target").lean(),
        Saved.find({ user: viewerId, post: { $in: postIds } }).select("post").lean(),
        authorId
          ? Follow.findOne({ follower: viewerId, following: authorId, status: "accepted" }).lean()
          : Promise.resolve(null),
        authorId
          ? Follow.findOne({ follower: authorId, following: viewerId, status: "accepted" }).lean()
          : Promise.resolve(null),
      ]);
      const likedSet = new Set(likedEdges.map((l) => l.target.toString()));
      const repostedSet = new Set(repostedEdges.map((r) => r.target.toString()));
      const savedSet = new Set(savedEdges.map((s) => s.post.toString()));
      const viewerIsFollowingAuthor = Boolean(followEdge);
      const authorIdStr = authorId?.toString();
      const followingSet = viewerIsFollowingAuthor ? new Set([authorIdStr]) : new Set();
      const followerSet = followBackEdge ? new Set([authorIdStr]) : new Set();
      result.posts = result.posts.map((p) => ({
        ...p,
        viewerHasLiked: likedSet.has(p._id.toString()),
        viewerHasReposted: repostedSet.has(p._id.toString()),
        viewerHasSaved: savedSet.has(p._id.toString()),
        viewerIsFollowingAuthor,
        viewerCanReply: viewerCanReplyFromSets(p, viewerId, { followingSet, followerSet }),
      }));
    }

    res.status(200).json(result);
  } catch (error) {
    console.error("getUserPosts error:", error);
    res.status(500).json({ error: "Failed to fetch user posts" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get / View
// ─────────────────────────────────────────────────────────────────────────────

export const getPost = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user?.id;

    // Fetching by id is the one path that doesn't come from a filtered list,
    // so the not-yet-public exclusions have to be stated here.
    const post = await Post.findOne({
      _id: postId,
      isDeleted: { $ne: true },
      isDraft: { $ne: true },
    })
      .select("-views")
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "quotedPost",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .populate({
        path: "quotedComment",
        select: "content media poll location author createdAt post counts isEdited editedAt isAiGenerated",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .lean();

    if (!post) return res.status(404).json({ error: "Post not found" });

    // Block gating: if either side blocks, the post is not viewable.
    const postAuthorId = post.author?._id ?? post.author;
    if (
      userId &&
      postAuthorId &&
      postAuthorId.toString() !== userId.toString() &&
      (await UserRelation.eitherBlocks(userId, postAuthorId))
    ) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Record view (non-owner, deduplicated via unique index)
    if (userId && post.author?._id?.toString() !== userId.toString()) {
      const isNew = await PostView.recordView(userId, postId);
      if (isNew) {
        await Post.updateOne({ _id: postId }, { $inc: { "counts.views": 1 } });
      }
    }

    // Attach viewer interaction flags (same pattern as feed endpoints)
    let viewerHasLiked = false;
    let viewerHasReposted = false;
    let viewerHasSaved = false;
    let viewerIsFollowingAuthor = false;
    if (userId) {
      const authorId = post.author?._id ?? post.author;
      const [likedEdge, repostedEdge, savedEdge, followEdge] = await Promise.all([
        Like.findOne({ user: userId, targetType: "Post", target: postId }).lean(),
        Repost.findOne({ user: userId, targetType: "Post", target: postId }).lean(),
        Saved.findOne({ user: userId, post: postId }).lean(),
        authorId && authorId.toString() !== userId.toString()
          ? Follow.findOne({ follower: userId, following: authorId, status: "accepted" }).lean()
          : Promise.resolve(null),
      ]);
      viewerHasLiked = Boolean(likedEdge);
      viewerHasReposted = Boolean(repostedEdge);
      viewerHasSaved = Boolean(savedEdge);
      viewerIsFollowingAuthor = Boolean(followEdge);
    }

    const viewerCanReply = userId ? await canUserReplyToTarget(userId, post) : true;

    res.status(200).json({
      ...(await decorateContent(post, userId)),
      viewerHasLiked,
      viewerHasReposted,
      viewerHasSaved,
      viewerIsFollowingAuthor,
      viewerCanReply,
    });
  } catch (error) {
    console.error("getPost error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const trackPostView = async (req, res) => {
  try {
    const { id: postId } = req.params;
    const userId = req.user?.id;

    const post = await Post.findOne({ _id: postId, isDraft: { $ne: true } })
      .select("author counts")
      .lean();
    if (!post) {
      return res.status(StatusCodes.NOT_FOUND).json({ success: false, message: "Post not found" });
    }

    if (userId && post.author?.toString() !== userId.toString()) {
      const isNew = await PostView.recordView(userId, postId);
      if (isNew) {
        await Post.updateOne({ _id: postId }, { $inc: { "counts.views": 1 } });
      }
    }

    const updated = await Post.findById(postId).select("counts").lean();
    return res.status(StatusCodes.OK).json({
      success: true,
      postId,
      viewCount: updated?.counts?.views ?? 0,
    });
  } catch (error) {
    console.error("trackPostView error:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to track post view" });
  }
};

export const trackBulkPostViews = async (req, res) => {
  try {
    const userId = req.user?.id;
    const postIds = Array.isArray(req.body?.postIds) ? req.body.postIds : [];

    if (!userId) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ success: false, message: "Unauthorized" });
    }
    if (!postIds.length) {
      return res.status(StatusCodes.OK).json({ success: true, trackedCount: 0 });
    }

    const unique = [...new Set(postIds.filter(Boolean).map((id) => id.toString()))];
    const posts = await Post.find({ _id: { $in: unique } }).select("_id author").lean();
    const trackable = posts
      .filter((p) => p.author?.toString() !== userId.toString())
      .map((p) => p._id.toString());

    let trackedCount = 0;
    for (const postId of trackable) {
      const isNew = await PostView.recordView(userId, postId);
      if (isNew) {
        await Post.updateOne({ _id: postId }, { $inc: { "counts.views": 1 } });
        trackedCount++;
      }
    }

    return res.status(StatusCodes.OK).json({ success: true, trackedCount });
  } catch (error) {
    console.error("trackBulkPostViews error:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to track post views" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────────────────────────────────────

export const deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const post = await Post.findById(id).select("author isDeleted isDraft scheduleStatus").lean();
    if (!post) return res.status(404).json({ message: "Post not found" });
    if (post.author.toString() !== userId) {
      return res.status(403).json({ message: "You are not authorized to delete this post" });
    }

    // Soft-delete the post and all reposts
    await Post.updateOne({ _id: id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    const deletedReposts = await Post.updateMany(
      { quotedPost: id, isQuoteRepost: false, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );

    // Delete all comments under the post and reposts
    const relatedPostIds = [id];
    const repostDocs = await Post.find({ quotedPost: id, isQuoteRepost: false }).select("_id").lean();
    repostDocs.forEach((r) => relatedPostIds.push(r._id.toString()));

    await Comment.deleteMany({ post: { $in: relatedPostIds } });
    await Notification.deleteMany({ entity: { $in: relatedPostIds }, entityType: "Post" });
    // Votes outlive the post otherwise, and the unique index would then stop
    // anyone voting again if the id were ever reused.
    await PollVote.deleteMany({ target: { $in: relatedPostIds } });

    // Only published posts were ever counted. Decrementing for a draft or a
    // still-pending scheduled post would push the author's total below what
    // they actually have.
    if (!post.isDraft) {
      await User.updateOne({ _id: userId }, { $inc: { "counts.posts": -1 } });
    }

    await del(CacheKeys.userPosts(req.user.username));
    res.status(200).json({
      message: "Post and associated content deleted",
      deletedRepostCount: deletedReposts.modifiedCount,
    });
  } catch (error) {
    console.error("deletePost error:", error);
    res.status(500).json({ error: "Server error while deleting post" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Like
// ─────────────────────────────────────────────────────────────────────────────

export const likePost = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const post = await Post.findById(postId).select("author counts hideLikeShareCount isDeleted").lean();
    if (!post || post.isDeleted) return res.status(404).json({ message: "Post not found" });

    const existing = await Like.findOne({ user: userId, targetType: "Post", target: postId });

    let liked;
    if (existing) {
      await Like.deleteOne({ _id: existing._id });
      await Post.updateOne({ _id: postId }, { $inc: { "counts.likes": -1 } });
      liked = false;
    } else {
      await Like.create({ user: userId, targetType: "Post", target: postId });
      await Post.updateOne({ _id: postId }, { $inc: { "counts.likes": 1 } });
      liked = true;

      if (post.author.toString() !== userId.toString()) {
        await sendNotification(post.author, userId, "like", { entity: postId, entityType: "Post" });
      }
    }

    const updated = await Post.findById(postId).select("counts hideLikeShareCount").lean();
    res.status(200).json({
      message: liked ? "Post liked successfully" : "Post unliked successfully",
      liked,
      counts: updated.counts,
    });
  } catch (error) {
    console.error("likePost error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getPostLikes = async (req, res) => {
  try {
    const { postId } = req.params;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const sort = normalizeActivitySort(req.query.sort);

    const post = await Post.findById(postId).select("_id").lean();
    if (!post) return res.status(404).json({ error: "Post not found" });

    if (sort === "default") {
      const { items, pageInfo } = await rankedActivityPage({
        Model: Like,
        match: { targetType: "Post", target: new mongoose.Types.ObjectId(postId) },
        userField: "user",
        viewerId: req.user._id,
        limit: limitNum,
        cursor,
      });
      return res.status(200).json({
        users: items.map((l) => ({ ...l.actor, likedAt: l.createdAt })),
        pageInfo,
      });
    }

    const parsedCursor = decodeCursor(cursor);
    const cursorFilter = parsedCursor
      ? { createdAt: { $lt: new Date(parsedCursor.createdAt) } }
      : {};

    const likes = await Like.find({ targetType: "Post", target: postId, ...cursorFilter })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("user", "username name profilePic isVerified verificationBadge")
      .lean();

    const { items, pageInfo } = buildCursorPageInfo(likes, limitNum, "createdAt");
    res.status(200).json({ users: items.map((l) => ({ ...l.user, likedAt: l.createdAt })), pageInfo });
  } catch (error) {
    console.error("getPostLikes error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Repost
// ─────────────────────────────────────────────────────────────────────────────

export const repostPost = async (req, res) => {
  try {
    const userId = req.user._id;
    const postId = req.params.id;

    const post = await Post.findById(postId).select("author counts isDeleted").lean();
    if (!post || post.isDeleted) return res.status(404).json({ message: "Post not found" });

    const existing = await Repost.findOne({ user: userId, targetType: "Post", target: postId });

    if (existing) {
      await Repost.deleteOne({ _id: existing._id });
      await Post.updateOne({ _id: postId }, { $inc: { "counts.reposts": -1 } });
      const updated = await Post.findById(postId).select("counts").lean();
      return res.status(200).json({ message: "Repost removed successfully", reposted: false, counts: updated?.counts });
    }

    await Repost.create({ user: userId, targetType: "Post", target: postId });
    await Post.updateOne({ _id: postId }, { $inc: { "counts.reposts": 1 } });

    if (post.author.toString() !== userId.toString()) {
      await sendNotification(post.author, userId, "repost", { entity: postId, entityType: "Post" });
    }

    const updated = await Post.findById(postId).select("counts").lean();
    return res.status(201).json({ message: "Post reposted successfully", reposted: true, counts: updated?.counts });
  } catch (error) {
    console.error("repostPost error:", error);
    res.status(500).json({ error: "Server error while processing repost" });
  }
};

export const getPostReposts = async (req, res) => {
  try {
    const { postId } = req.params;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const sort = normalizeActivitySort(req.query.sort);

    const post = await Post.findById(postId).select("_id").lean();
    if (!post) return res.status(404).json({ error: "Post not found" });

    if (sort === "default") {
      const { items, pageInfo } = await rankedActivityPage({
        Model: Repost,
        match: { targetType: "Post", target: new mongoose.Types.ObjectId(postId) },
        userField: "user",
        viewerId: req.user._id,
        limit: limitNum,
        cursor,
      });
      return res.status(200).json({
        users: items.map((r) => ({ ...r.actor, repostedAt: r.createdAt })),
        pageInfo,
      });
    }

    const parsedCursor = decodeCursor(cursor);
    const cursorFilter = parsedCursor
      ? { createdAt: { $lt: new Date(parsedCursor.createdAt) } }
      : {};

    const reposts = await Repost.find({ targetType: "Post", target: postId, ...cursorFilter })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .populate("user", "username name profilePic isVerified verificationBadge")
      .lean();

    const { items, pageInfo } = buildCursorPageInfo(reposts, limitNum, "createdAt");
    res.status(200).json({ users: items.map((r) => ({ ...r.user, repostedAt: r.createdAt })), pageInfo });
  } catch (error) {
    console.error("getPostReposts error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getPostQuotes = async (req, res) => {
  try {
    const { postId } = req.params;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const sort = normalizeActivitySort(req.query.sort);

    if (sort === "default") {
      const { items, pageInfo } = await rankedActivityPage({
        Model: Post,
        match: {
          quotedPost: new mongoose.Types.ObjectId(postId),
          isQuoteRepost: true,
          isDeleted: { $ne: true },
        },
        userField: "author",
        viewerId: req.user._id,
        limit: limitNum,
        cursor,
      });
      return res.status(200).json({
        users: items.map((q) => ({
          ...q.actor,
          content: q.content,
          quotePostId: q._id,
          createdAt: q.createdAt,
        })),
        pageInfo,
      });
    }

    const parsedCursor = decodeCursor(cursor);
    const cursorQuery = buildCursorQuery(parsedCursor);

    const quotes = await Post.find({ quotedPost: postId, isQuoteRepost: true, isDeleted: { $ne: true }, ...cursorQuery })
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "quotedPost",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limitNum + 1)
      .lean();

    const { items: pagedQuotes, pageInfo } = buildCursorPageInfo(quotes, limitNum);
    res.status(200).json({
      users: pagedQuotes.map((q) => ({
        ...q.author,
        content: q.content,
        quotePostId: q._id,
        createdAt: q.createdAt,
      })),
      pageInfo,
    });
  } catch (error) {
    console.error("getPostQuotes error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getPostActivity = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId).select("_id isDeleted").lean();
    if (!post || post.isDeleted) return res.status(404).json({ error: "Post not found" });

    const [likes, reposts, quotes] = await Promise.all([
      Like.find({ targetType: "Post", target: postId })
        .populate("user", "username name profilePic isVerified counts.followers")
        .lean(),
      Repost.find({ targetType: "Post", target: postId })
        .populate("user", "username name profilePic isVerified counts.followers")
        .lean(),
      Post.find({ quotedPost: postId, isQuoteRepost: true, isDeleted: { $ne: true } })
        .populate("author", "username name profilePic isVerified counts.followers")
        .lean(),
    ]);

    const merged = [
      ...likes.map((l) => ({ type: "like", user: l.user, timestamp: l.createdAt })),
      ...reposts.map((r) => ({ type: "repost", user: r.user, timestamp: r.createdAt })),
      ...quotes.map((q) => ({
        type: "quote",
        user: q.author,
        content: q.content,
        timestamp: q.createdAt,
        quotePostId: q._id,
      })),
      // An actor whose account has since been removed leaves a null user.
    ].filter((entry) => entry.user);

    const sort = normalizeActivitySort(req.query.sort);
    let activity;

    if (sort === "recent") {
      activity = merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } else {
      // This list isn't paginated, so relevance is ranked in memory — one
      // lookup for the viewer's follow edges across the actors on the page.
      const actorIds = [...new Set(merged.map((e) => e.user._id))];
      const edges = actorIds.length
        ? await Follow.find({
            follower: req.user._id,
            following: { $in: actorIds },
            status: "accepted",
          })
            .select("following")
            .lean()
        : [];
      activity = rankActivityInMemory(merged, edges.map((e) => e.following));
    }

    res.status(200).json({ activity, sort });
  } catch (error) {
    console.error("getPostActivity error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────

export const toggleHideLikeShareCount = async (req, res) => {
  try {
    const { id } = req.params;
    const post = await Post.findById(id).select("author hideLikeShareCount isDeleted").lean();
    if (!post || post.isDeleted) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: "Post not found" });
    }
    if (post.author.toString() !== req.user.id.toString()) {
      return res.status(StatusCodes.FORBIDDEN).json({ message: "Not authorized" });
    }

    const updated = await Post.findByIdAndUpdate(
      id,
      [{ $set: { hideLikeShareCount: { $not: "$hideLikeShareCount" } } }],
      { new: true }
    ).select("hideLikeShareCount");

    return res.status(StatusCodes.OK).json({
      success: true,
      hideLikeShareCount: updated.hideLikeShareCount,
      message: updated.hideLikeShareCount ? "Like and share counts hidden" : "Like and share counts visible",
    });
  } catch (error) {
    console.error("toggleHideLikeShareCount error:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to update count visibility" });
  }
};

// Update who can reply to / quote a post (author only)
export const updatePostWhoCanReply = async (req, res) => {
  try {
    const { id } = req.params;
    const { whoCanReply } = req.body;

    const post = await Post.findById(id).select("author isDeleted").lean();
    if (!post || post.isDeleted) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: "Post not found" });
    }
    if (post.author.toString() !== req.user.id.toString()) {
      return res.status(StatusCodes.FORBIDDEN).json({ message: "Not authorized" });
    }

    const value = normalizeWhoCanReply(whoCanReply);
    await Post.updateOne({ _id: id }, { $set: { whoCanReply: value } });

    return res.status(StatusCodes.OK).json({
      success: true,
      whoCanReply: value,
      message: "Reply audience updated",
    });
  } catch (error) {
    console.error("updatePostWhoCanReply error:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to update reply audience" });
  }
};

/**
 * PATCH /posts/:id/edit — change a post's text.
 *
 * Text only: media is fixed at creation, so nothing here touches Cloudinary.
 * No time limit. Deliberately does NOT touch counts, quote counts or
 * notifications — an edit isn't a new post. Mentions are re-resolved because
 * whoCanReply === "mentioned" reads them.
 */
export const editPost = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, isAiGenerated } = req.body;

    if (typeof content !== "string" || !content.trim()) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Post can't be empty",
      });
    }
    const trimmed = content.trim();
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: `Post must be under ${MAX_CONTENT_LENGTH} characters`,
      });
    }

    // editHistory is select:false, so ask for it explicitly.
    const post = await Post.findById(id).select("+editHistory");
    if (!post || post.isDeleted) {
      return res.status(StatusCodes.NOT_FOUND).json({ success: false, message: "Post not found" });
    }
    if (post.author.toString() !== req.user.id.toString()) {
      return res.status(StatusCodes.FORBIDDEN).json({ success: false, message: "Not authorized" });
    }
    if (post.isDraft) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Use save-draft to change a draft",
      });
    }
    // Only a genuine change counts. Compare trimmed-to-trimmed: createPost
    // stores content unmodified, so a post saved with stray whitespace would
    // otherwise be marked "edited" for re-submitting identical visible text.
    const contentChanged = (post.content || "").trim() !== trimmed;
    if (contentChanged) {
      await post.editContent(trimmed, await resolveMentions(trimmed));
    }

    // The AI label rides along with the edit but is tracked separately: adding
    // or removing a disclosure isn't a change to what the post says, so it
    // doesn't earn a history entry or the "edited" marker.
    if (typeof isAiGenerated === "boolean" && isAiGenerated !== post.isAiGenerated) {
      post.isAiGenerated = isAiGenerated;
      await post.save();
    }

    if (contentChanged || typeof isAiGenerated === "boolean") {
      await del(CacheKeys.userPosts(req.user.username));
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Post updated",
      post: await decorateContent(await populatePost(id), req.user.id),
    });
  } catch (error) {
    console.error("editPost error:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to update post" });
  }
};

/**
 * GET /posts/:id/edit-history — every version oldest first, current one last.
 * Readable by anyone who can read the post; edits are public on X and hiding
 * them would defeat the "a new version is available" prompt.
 */
export const getPostEditHistory = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .select("+editHistory author content createdAt editedAt isEdited isDeleted")
      .lean();
    if (!post || post.isDeleted) {
      return res.status(StatusCodes.NOT_FOUND).json({ success: false, message: "Post not found" });
    }

    // Same block gating as getPost — "public" means public to whoever can see
    // the post, not to anyone holding its id.
    const userId = req.user?.id;
    if (
      userId &&
      post.author &&
      post.author.toString() !== userId.toString() &&
      (await UserRelation.eitherBlocks(userId, post.author))
    ) {
      return res.status(StatusCodes.NOT_FOUND).json({ success: false, message: "Post not found" });
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      ...buildVersionList(post),
    });
  } catch (error) {
    console.error("getPostEditHistory error:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to load edit history" });
  }
};

// "Not interested" — record negative feedback for a post (hide + down-rank signals)
export const markNotInterested = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const post = await Post.findById(id).select("author content isDeleted").lean();
    if (!post || post.isDeleted) {
      return res.status(StatusCodes.NOT_FOUND).json({ success: false, message: "Post not found" });
    }

    await NotInterested.updateOne(
      { user: userId, post: id },
      {
        $set: {
          author: post.author,
          hashtags: parseHashtags(post.content || ""),
        },
      },
      { upsert: true }
    );

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "You'll see fewer posts like this",
    });
  } catch (error) {
    console.error("markNotInterested error:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to record feedback" });
  }
};

// Undo "Not interested"
export const undoNotInterested = async (req, res) => {
  try {
    const { id } = req.params;
    await NotInterested.deleteOne({ user: req.user.id, post: id });
    return res.status(StatusCodes.OK).json({ success: true, message: "Undone" });
  } catch (error) {
    console.error("undoNotInterested error:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to undo feedback" });
  }
};

export const toggleSavePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    const existing = await Saved.findOne({ user: userId, post: postId });
    if (existing) {
      await Saved.deleteOne({ _id: existing._id });
      return res.status(200).json({ message: "Post unsaved successfully", saved: false });
    }

    await Saved.create({ user: userId, post: postId });
    return res.status(200).json({ message: "Post saved successfully", saved: true });
  } catch (error) {
    console.error("toggleSavePost error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getSavedPosts = async (req, res) => {
  try {
    const userId = req.user.id;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);

    const cursorFilter = parsedCursor
      ? { createdAt: { $lt: new Date(parsedCursor.createdAt) } }
      : {};

    const savedEdges = await Saved.find({ user: userId, ...cursorFilter })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const { items: pageEdges, pageInfo } = buildCursorPageInfo(savedEdges, limitNum, "createdAt");
    const postIds = pageEdges.map((e) => e.post);

    const posts = await Post.find({
      _id: { $in: postIds },
      isDeleted: { $ne: true },
      isDraft: { $ne: true },
    })
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "quotedPost",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .lean();

    const postMap = new Map(posts.map((p) => [p._id.toString(), p]));
    const orderedPosts = postIds.map((id) => postMap.get(id.toString())).filter(Boolean);

    // Attach viewer interaction flags — saved is true by definition, batch like/repost/follow
    const batchIds = orderedPosts.map((p) => p._id);
    const authorIds = [...new Set(orderedPosts.map((p) => (p.author?._id ?? p.author)?.toString()).filter(Boolean))];
    const [likedEdges, repostedEdges, followedEdges] = batchIds.length
      ? await Promise.all([
          Like.find({ user: userId, targetType: "Post", target: { $in: batchIds } }).select("target").lean(),
          Repost.find({ user: userId, targetType: "Post", target: { $in: batchIds } }).select("target").lean(),
          Follow.find({ follower: userId, following: { $in: authorIds }, status: "accepted" }).select("following").lean(),
        ])
      : [[], [], []];
    const likedSet = new Set(likedEdges.map((l) => l.target.toString()));
    const repostedSet = new Set(repostedEdges.map((r) => r.target.toString()));
    const followedAuthorSet = new Set(followedEdges.map((f) => f.following.toString()));
    const postsWithViewer = orderedPosts.map((p) => ({
      ...p,
      // Same entry identity the home feed stamps: these lists never contain
      // reposts, so an entry is just the post.
      feedId: p._id.toString(),
      viewerHasLiked: likedSet.has(p._id.toString()),
      viewerHasReposted: repostedSet.has(p._id.toString()),
      viewerHasSaved: true,
      viewerIsFollowingAuthor: followedAuthorSet.has((p.author?._id ?? p.author)?.toString()),
    }));

    res.status(200).json({ posts: await decorateContent(postsWithViewer, userId), pageInfo });
  } catch (error) {
    console.error("getSavedPosts error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getLikedPosts = async (req, res) => {
  try {
    const userId = req.user.id;
    const { cursor, limit = 10 } = req.query;
    const limitNum = parseCursorLimit(limit, 10);
    const parsedCursor = decodeCursor(cursor);

    const cursorFilter = parsedCursor
      ? { createdAt: { $lt: new Date(parsedCursor.createdAt) } }
      : {};

    const likeEdges = await Like.find({
      user: userId,
      targetType: "Post",
      ...cursorFilter,
    })
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const { items: pageEdges, pageInfo } = buildCursorPageInfo(likeEdges, limitNum, "createdAt");
    const postIds = pageEdges.map((e) => e.target);

    // Viewer's following list for privacy filter
    const followEdges = await Follow.find({ follower: userId, status: "accepted" })
      .select("following").lean();
    const followingIds = new Set(followEdges.map((e) => e.following.toString()));

    const posts = await Post.find({ _id: { $in: postIds }, isDraft: { $ne: true }, isDeleted: { $ne: true } })
      .populate("author", AUTHOR_SELECT)
      .populate({
        path: "quotedPost",
        populate: { path: "author", select: AUTHOR_SELECT },
      })
      .lean();

    const visiblePosts = posts.filter((post) => {
      const authorId = (post.author?._id || post.author)?.toString();
      if (!authorId) return false;
      if (!post.author?.isPrivate) return true;
      return authorId === userId.toString() || followingIds.has(authorId);
    });

    const postMap = new Map(visiblePosts.map((p) => [p._id.toString(), p]));
    const orderedPosts = postIds
      .map((id) => postMap.get(id.toString()))
      .filter(Boolean);

    // Attach viewer interaction flags — liked is true by definition, batch repost/save
    const batchIds = orderedPosts.map((p) => p._id);
    const [repostedEdges, savedEdges] = batchIds.length
      ? await Promise.all([
          Repost.find({ user: userId, targetType: "Post", target: { $in: batchIds } }).select("target").lean(),
          Saved.find({ user: userId, post: { $in: batchIds } }).select("post").lean(),
        ])
      : [[], []];
    const repostedSet = new Set(repostedEdges.map((r) => r.target.toString()));
    const savedSet = new Set(savedEdges.map((s) => s.post.toString()));
    const postsWithViewer = orderedPosts.map((p) => ({
      ...p,
      feedId: p._id.toString(),
      viewerHasLiked: true,
      viewerHasReposted: repostedSet.has(p._id.toString()),
      viewerHasSaved: savedSet.has(p._id.toString()),
      viewerIsFollowingAuthor: followingIds.has((p.author?._id ?? p.author)?.toString()),
    }));

    res.status(200).json({ posts: await decorateContent(postsWithViewer, userId), pageInfo });
  } catch (error) {
    console.error("getLikedPosts error:", error);
    res.status(500).json({ error: "Server error" });
  }
};
