import User from "../models/User.js";

/**
 * Extract @username tokens from a content string.
 * Returns a deduped array of usernames (without the leading @).
 */
export const parseMentionUsernames = (content = "") => {
  if (!content || typeof content !== "string") return [];
  const matches = content.match(/@([a-zA-Z0-9_]+)/g) || [];
  const usernames = matches.map((m) => m.slice(1).toLowerCase());
  return [...new Set(usernames)];
};

/**
 * Resolve @mentions in `content` to existing User _ids.
 * Returns an array of ObjectIds (may be empty).
 */
export const resolveMentions = async (content = "") => {
  const usernames = parseMentionUsernames(content);
  if (!usernames.length) return [];

  const users = await User.find({
    username: { $in: usernames },
  })
    .select("_id")
    .lean();

  return users.map((u) => u._id);
};
