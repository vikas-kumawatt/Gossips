/**
 * Two-level threading.
 *
 * A comment thread is only ever two deep: a top-level comment, and a flat,
 * time-sorted list of replies under it. When a user replies to something, we
 * anchor the new reply to the *top-level* comment of whatever they replied to,
 * never to a reply. This is derived on the server from the replied-to comment
 * so a client can't anchor a reply under an arbitrary comment (which would
 * corrupt that comment's reply count and leak the reply into another thread).
 *
 * @param {{ parent?: any }} target  The comment being replied to (lean).
 * @param {any} targetId             Its id (the client-supplied commentId).
 * @returns {{ parent: any, replyTo: any }}
 *   parent  — the top-level comment the reply belongs under.
 *   replyTo — the comment actually answered (for the label + notification).
 */
export const resolveReplyThread = (target, targetId) => ({
  // If the target is itself a reply it has a parent (the top-level comment);
  // otherwise the target *is* the top-level comment.
  parent: target?.parent || targetId,
  replyTo: targetId,
});
