/**
 * Composers post as multipart/form-data, so every scalar arrives as a string —
 * `"false"` is truthy, which is exactly the bug that would silently label every
 * post as AI-generated. JSON routes send real booleans. Handle both.
 */
export const parseBooleanFlag = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
};
