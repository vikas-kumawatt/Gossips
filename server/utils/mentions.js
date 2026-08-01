import User from "../models/User.js";
import UserSettings from "../models/UserSettings.js";
import Follow from "../models/Follow.js";
import UserRelation from "../models/UserRelation.js";
import { parseMentionUsernames } from "./richText.js";

export { parseMentionUsernames };

/**
 * Who may @mention whom.
 *
 * The check is `mentioner → mentioned`, and it belongs to the person being
 * mentioned: "Profiles you follow" means the accounts *they* follow may
 * mention them. It has nothing to do with who is reading, which is what makes
 * the next decision possible.
 *
 * Permission is resolved once, at write time, and the allowed set is stored on
 * the post. Two reasons. Re-checking on every read would be a settings lookup
 * per mention per row of every feed — and, more importantly, a mention is a
 * thing that happened. Tightening your setting shouldn't retroactively unlink
 * you from conversations you were already part of; it should govern who can
 * pull you into new ones. That's how Threads and Instagram behave, and it's
 * the reading that doesn't rewrite history.
 *
 * DMs skip all of this. A mention there is a convenience — a link to a profile
 * inside a private message between people who already chose to talk — not a way
 * to summon a stranger, so there's nothing to gate and nobody to notify.
 */

export const MENTION_AUDIENCES = ["everyone", "following", "none"];

/*
 * A cap. The parser will happily return a thousand handles from a pasted wall
 * of text, and each one costs a lookup and possibly a notification. Twenty is
 * far more than any real post uses, and mass-mentioning is a spam technique
 * rather than a use case.
 */
const MAX_MENTIONS = 20;

/**
 * Resolves @handles to accounts that both exist and permit the mention.
 *
 * @param {string} content
 * @param {ObjectId} mentionerId the author doing the mentioning
 * @returns {Promise<Array<{_id: ObjectId, username: string}>>}
 */
export const resolveAllowedMentions = async (content = "", mentionerId) => {
  const usernames = parseMentionUsernames(content);
  if (!usernames.length || !mentionerId) return [];

  const candidates = await User.find({
    username: { $in: usernames.slice(0, MAX_MENTIONS) },
    // Same set every discovery surface uses; a suspended account
    // shouldn't be linkable or notifiable.
    accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] },
  })
    .select("_id username")
    .lean();

  if (!candidates.length) return [];

  const mentioner = String(mentionerId);
  const ids = candidates.map((u) => u._id);

  const [settings, blocks, followEdges] = await Promise.all([
    UserSettings.find({ user: { $in: ids } })
      .select("user privacy.whoCanMention")
      .lean(),
    /*
     * Either direction. Mentioning someone who blocked you would put your
     * handle in their notifications, which is exactly the contact a block
     * prevents — and mentioning someone you blocked yourself is no more
     * coherent.
     */
    UserRelation.find({
      kind: "block",
      $or: [
        { from: mentionerId, to: { $in: ids } },
        { from: { $in: ids }, to: mentionerId },
      ],
    })
      .select("from to")
      .lean(),
    // "Profiles you follow": an edge from the mentioned account to the author.
    Follow.find({ follower: { $in: ids }, following: mentionerId, status: "accepted" })
      .select("follower")
      .lean(),
  ]);

  const audienceByUser = new Map(
    settings.map((s) => [String(s.user), s.privacy?.whoCanMention || "everyone"])
  );
  const blocked = new Set(
    blocks
      .flatMap((rel) => [String(rel.from), String(rel.to)])
      .filter((id) => id !== mentioner)
  );
  const followsMentioner = new Set(followEdges.map((edge) => String(edge.follower)));

  return candidates.filter((candidate) => {
    const id = String(candidate._id);

    // Mentioning yourself always links; it just never notifies.
    if (id === mentioner) return true;
    if (blocked.has(id)) return false;

    // No settings row — an account created before settings existed — reads as
    // the default, which is the permissive one.
    const audience = audienceByUser.get(id) || "everyone";
    if (audience === "none") return false;
    if (audience === "following") return followsMentioner.has(id);
    return true;
  });
};

/**
 * Every handle that resolves to a real account, permission ignored.
 *
 * For direct messages only, where the mention is a link rather than a summons.
 */
export const resolveMessageMentions = async (content = "") => {
  const usernames = parseMentionUsernames(content);
  if (!usernames.length) return [];

  return User.find({
    username: { $in: usernames.slice(0, MAX_MENTIONS) },
    // Same set every discovery surface uses; a suspended account
    // shouldn't be linkable or notifiable.
    accountStatus: { $nin: ["deleted", "deactivated", "suspended", "locked"] },
  })
    .select("_id username")
    .lean();
};
