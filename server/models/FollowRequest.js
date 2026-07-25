/**
 * FollowRequest — REMOVED.
 *
 * Follow requests are now stored in the Follow collection with status: "pending".
 * Import Follow from "./Follow.js" instead.
 *
 * This stub is kept only to surface a clear error if any old import is missed
 * during the migration rather than crashing with a cryptic "model not found".
 */
throw new Error(
  "[FollowRequest] This model has been removed. " +
  "Use the Follow model (server/models/Follow.js) with status: 'pending' for follow requests."
);
