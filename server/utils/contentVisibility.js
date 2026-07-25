import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";

/**
 * Can `viewerId` see content written by `author`?
 *
 * Private authors are visible only to accepted followers, and a block in
 * either direction hides the content both ways. Used both when someone tries
 * to share something and when a reader loads a share out of a chat — the same
 * rule has to hold at both ends, or sharing becomes a way to launder content
 * past its own privacy.
 */
export const canViewAuthorContent = async (viewerId, author) => {
  if (!author?._id) return false;

  const authorId = author._id.toString();
  if (authorId === viewerId.toString()) return true;

  if (await UserRelation.eitherBlocks(viewerId, author._id)) return false;

  if (author.isPrivate) {
    const follows = await Follow.findOne({
      follower: viewerId,
      following: author._id,
      status: "accepted",
    }).lean();
    if (!follows) return false;
  }

  return true;
};

/**
 * Loads a post/comment only if `viewerId` is allowed to see it.
 *
 * For a comment this also checks the parent post's author: a public reply
 * underneath a private account's post is only visible to that account's
 * followers, and skipping that check would leak the thread.
 */
export const loadVisibleContent = async (viewerId, kind, id) => {
  const Model = kind === "comment" ? Comment : Post;

  const doc = await Model.findOne({
    _id: id,
    isDeleted: { $ne: true },
    // Not yet public: a post waiting for its scheduled time is a draft, a
    // reply waiting for its scheduled time is flagged directly.
    ...(kind === "post" ? { isDraft: { $ne: true } } : { isScheduled: { $ne: true } }),
  })
    .select("content media author createdAt post")
    .populate("author", "username name profilePic isPrivate")
    .lean();

  if (!doc) return { error: "That content is no longer available" };
  if (!(await canViewAuthorContent(viewerId, doc.author))) {
    // Same message as "missing" — confirming existence would tell an outsider
    // that a specific private post is real.
    return { error: "That content is no longer available" };
  }

  if (kind === "comment" && doc.post) {
    const parent = await Post.findById(doc.post)
      .select("author isDeleted")
      .populate("author", "isPrivate")
      .lean();
    if (!parent || parent.isDeleted) {
      return { error: "That content is no longer available" };
    }
    if (!(await canViewAuthorContent(viewerId, parent.author))) {
      return { error: "That content is no longer available" };
    }
  }

  return { doc };
};
