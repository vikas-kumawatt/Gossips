/**
 * Parse #hashtags from a content string.
 * Returns a deduped array of lowercased tags (without the leading #).
 */
export const parseHashtags = (content = "") => {
  if (!content || typeof content !== "string") return [];
  const matches = content.match(/#([a-zA-Z0-9_]+)/g) || [];
  const tags = matches.map((m) => m.slice(1).toLowerCase());
  return [...new Set(tags)];
};
