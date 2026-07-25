/**
 * Shared helpers for post/comment content edits.
 */

// Mirrors the `maxlength: 500` on the Post and Comment content paths. Checked
// explicitly so an over-long edit gets a clear 400 rather than a cast error.
export const MAX_CONTENT_LENGTH = 500;

// Must match MAX_EDIT_HISTORY on the Post and Comment schemas.
const MAX_EDIT_HISTORY = 20;

/**
 * Flattens stored history plus the current text into an ordered list of
 * versions, oldest first. Each `editHistory` entry is stamped with when that
 * version came into existence, so the result reads as a straight timeline.
 *
 * Index 0 is always the true original — the cap drops versions from the middle,
 * never the first. `truncated` says middle versions may be missing, so the
 * client shows a gap after the original rather than implying an unbroken run.
 * It's deliberately conservative: at exactly the cap nothing has necessarily
 * been dropped yet, but we can't tell without storing a total edit count.
 *
 * Requires the document to have been loaded with `.select("+editHistory")`.
 */
export const buildVersionList = (doc) => {
  const history = doc.editHistory || [];

  const previous = history.map((entry) => ({
    content: entry.content || "",
    at: entry.editedAt || doc.createdAt,
    isCurrent: false,
  }));

  return {
    versions: [
      ...previous,
      {
        content: doc.content || "",
        at: doc.editedAt || doc.createdAt,
        isCurrent: true,
      },
    ],
    truncated: history.length >= MAX_EDIT_HISTORY,
  };
};

/**
 * The marker identifying which version of a document is current. Compared
 * against a quote's `quotedSnapshot.versionAt` to detect a newer version, and
 * against a report's `createdAt` to decide whether re-reporting is warranted.
 */
export const contentVersionAt = (doc) => doc?.editedAt || doc?.createdAt || null;
