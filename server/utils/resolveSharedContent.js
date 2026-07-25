import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";

/**
 * Hydrates `post_share` messages with the live post/comment, evaluated for the
 * person reading the thread.
 *
 * The share is a reference, not a copy, so the card shows the current version
 * and edits appear. Two things can change after sending:
 *
 *  - the original is deleted → fall back to the stored snapshot, marked
 *    unavailable, so the bubble still reads sensibly instead of going blank;
 *  - the reader can't see it (author went private, or a block exists either
 *    way) → return a locked card with no content. Resolved per read rather
 *    than at send time, so it stays correct as relationships change.
 */
export const attachSharedContent = async (messages, viewerId) => {
  const shares = messages.filter((m) => m.messageType === "post_share" && m.sharedContent);
  if (!shares.length) return messages;

  const postIds = [];
  const commentIds = [];
  for (const m of shares) {
    if (m.sharedContent.kind === "comment" && m.sharedContent.comment) {
      commentIds.push(m.sharedContent.comment);
    } else if (m.sharedContent.post) {
      postIds.push(m.sharedContent.post);
    }
  }

  const [posts, comments] = await Promise.all([
    postIds.length
      ? Post.find({ _id: { $in: postIds }, isDeleted: { $ne: true }, isDraft: { $ne: true } })
          .select("content media counts createdAt isEdited isAiGenerated author")
          .populate("author", "username name profilePic isVerified isPrivate")
          .lean()
      : [],
    commentIds.length
      ? Comment.find({
          _id: { $in: commentIds },
          isDeleted: { $ne: true },
          isScheduled: { $ne: true },
        })
          .select("content media counts createdAt isEdited isAiGenerated author post")
          .populate("author", "username name profilePic isVerified isPrivate")
          .lean()
      : [],
  ]);

  const liveById = new Map();
  posts.forEach((p) => liveById.set(p._id.toString(), p));
  comments.forEach((c) => liveById.set(c._id.toString(), c));

  // Work out visibility once per distinct author rather than per message.
  const authorIds = [...new Set([...posts, ...comments].map((d) => d.author?._id?.toString()).filter(Boolean))];

  const viewerKey = viewerId.toString();
  const foreignAuthors = authorIds.filter((id) => id !== viewerKey);

  const [blockRows, followRows] = await Promise.all([
    foreignAuthors.length
      ? UserRelation.find({
          kind: "block",
          $or: [
            { from: viewerId, to: { $in: foreignAuthors } },
            { from: { $in: foreignAuthors }, to: viewerId },
          ],
        })
          .select("from to")
          .lean()
      : [],
    foreignAuthors.length
      ? Follow.find({
          follower: viewerId,
          following: { $in: foreignAuthors },
          status: "accepted",
        })
          .select("following")
          .lean()
      : [],
  ]);

  const blocked = new Set();
  for (const row of blockRows) {
    const from = row.from.toString();
    blocked.add(from === viewerKey ? row.to.toString() : from);
  }
  const follows = new Set(followRows.map((f) => f.following.toString()));

  const canView = (author) => {
    if (!author) return false;
    const authorId = author._id.toString();
    if (authorId === viewerKey) return true;
    if (blocked.has(authorId)) return false;
    if (author.isPrivate && !follows.has(authorId)) return false;
    return true;
  };

  for (const message of shares) {
    const { kind, post, comment, snapshot } = message.sharedContent;
    const refId = (kind === "comment" ? comment : post)?.toString();
    const live = refId ? liveById.get(refId) : null;

    if (!live) {
      message.sharedContent.resolved = {
        available: false,
        locked: false,
        kind,
        id: refId || null,
        // Only the author survives; the text of a deleted post isn't shown.
        authorUsername: snapshot?.authorUsername || "",
        content: "",
      };
      delete message.sharedContent.snapshot;
      continue;
    }

    if (!canView(live.author)) {
      message.sharedContent.resolved = {
        available: true,
        locked: true,
        kind,
        id: refId,
        authorUsername: live.author?.username || snapshot?.authorUsername || "",
        authorPic: live.author?.profilePic || "",
        content: "",
      };
      // The lock has to be enforced in the payload, not just in the render.
      // Leaving the snapshot attached would ship the private post's full text
      // and media URLs to a reader who isn't allowed to see them.
      delete message.sharedContent.snapshot;
      continue;
    }

    message.sharedContent.resolved = {
      available: true,
      locked: false,
      kind,
      id: refId,
      postId: kind === "comment" ? live.post?.toString() || null : refId,
      author: live.author,
      authorUsername: live.author?.username || "",
      content: live.content || "",
      media: Array.isArray(live.media) ? live.media : [],
      counts: live.counts || {},
      isEdited: !!live.isEdited,
      isAiGenerated: !!live.isAiGenerated,
      createdAt: live.createdAt,
    };
    // The live copy is authoritative; the snapshot is dead weight on the wire.
    delete message.sharedContent.snapshot;
  }

  return messages;
};

/**
 * For responses that carry messages without resolving them per reader — chat
 * lists, search, pinned, and the live socket fan-out to a group.
 *
 * Removes the snapshot and leaves only "a post was shared here". The client
 * renders a neutral placeholder and gets the real card on the next thread
 * fetch, which is the only place visibility is actually evaluated.
 */
export const stripSharedSnapshot = (message) => {
  if (!message?.sharedContent || message.messageType !== "post_share") return message;
  delete message.sharedContent.snapshot;
  delete message.sharedContent.resolved;
  return message;
};

/** Same, for a list. Safe on messages of any type. */
export const stripSharedSnapshots = (messages = []) => {
  messages.forEach(stripSharedSnapshot);
  return messages;
};
