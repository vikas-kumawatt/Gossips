import Hashtag from "../models/Hashtag.js";
import { sendNotification } from "./notifications.js";
import UserSettings from "../models/UserSettings.js";
import { parseHashtags } from "./richText.js";
import { allowedHashtags } from "./blockedHashtags.js";
import { resolveAllowedMentions } from "./mentions.js";

/**
 * Everything that has to happen to a piece of text before it's stored.
 *
 * Posts, replies, edits and bios all need the same three things — resolve the
 * mentions that are permitted, keep the hashtags that aren't blocked, and
 * maintain the tag counters — and they were going to grow three slightly
 * different versions of it. One function, six call sites.
 */

/**
 * @param {string} content
 * @param {ObjectId} authorId
 * @returns {Promise<{mentions: Array, mentionIds: Array, hashtags: string[]}>}
 */
export const indexContent = async (content = "", authorId) => {
  const [mentions, tags] = await Promise.all([
    resolveAllowedMentions(content, authorId),
    allowedHashtags(parseHashtags(content)),
  ]);

  return {
    // Full docs, so callers can notify without a second lookup.
    mentions,
    mentionIds: mentions.map((m) => m._id),
    hashtags: tags,
  };
};

/**
 * Moves the postCount on a set of tags.
 *
 * Called with the difference on an edit, not the whole list — a post that
 * keeps #coffee through an edit shouldn't count twice. Upserts, because the
 * first use of a tag is also when its row is created.
 *
 * Deliberately not awaited by its callers: a counter used for trending is not
 * worth failing a post over, and it self-corrects on the next write.
 */
export const bumpHashtagCounts = async (tags = [], delta = 1) => {
  if (!tags.length) return;

  try {
    await Hashtag.bulkWrite(
      tags.map((tag) => ({
        updateOne: {
          filter: { tag },
          update: {
            $inc: { postCount: delta },
            $set: { lastUsedAt: new Date() },
            $setOnInsert: { tag },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    // A count can only go negative through a bug or a double-delete, and a
    // negative trending score is worse than a slightly stale one.
    if (delta < 0) {
      await Hashtag.updateMany({ tag: { $in: tags }, postCount: { $lt: 0 } }, {
        $set: { postCount: 0 },
      });
    }
  } catch (error) {
    console.error("bumpHashtagCounts error:", error);
  }
};

/** What an edit added and removed, so the counters move by the difference. */
export const hashtagDelta = (before = [], after = []) => {
  const had = new Set(before);
  const has = new Set(after);
  return {
    added: after.filter((tag) => !had.has(tag)),
    removed: before.filter((tag) => !has.has(tag)),
  };
};

/**
 * Tells the mentioned people, once.
 *
 * Skips the author — being told you mentioned yourself is noise — and skips
 * anyone who has turned mention notifications off. `alreadyNotified` is for
 * the reply case, where the post's author is getting a "replied to you"
 * notification already and shouldn't also get "mentioned you" for the same
 * text.
 *
 * Failures are logged, not thrown: a notification that didn't send must not
 * roll back a post that did.
 */
export const notifyMentions = async ({
  mentions = [],
  authorId,
  type = "mention",
  entity,
  entityType,
  alreadyNotified = [],
}) => {
  const author = String(authorId);
  const skip = new Set([author, ...alreadyNotified.map(String)]);

  const recipients = mentions.filter((m) => !skip.has(String(m._id)));
  if (!recipients.length) return;

  try {
    const settings = await UserSettings.find({ user: { $in: recipients.map((r) => r._id) } })
      .select("user notifications.mentions")
      .lean();

    const muted = new Set(
      settings
        .filter((s) => s.notifications?.mentions === false)
        .map((s) => String(s.user))
    );

    await Promise.all(
      recipients
        .filter((r) => !muted.has(String(r._id)))
        .map((r) => sendNotification(r._id, authorId, type, { entity, entityType }))
    );
  } catch (error) {
    console.error("notifyMentions error:", error);
  }
};
