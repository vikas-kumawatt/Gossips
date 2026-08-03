/**
 * What a client may put in a message, and what it may later change.
 *
 * These were spread across two files. `config/socket.js` owned the send-time
 * rules, `controllers/chatController.js` grew its own copy of the length cap and
 * its own edit-type list, and the schema had a third opinion in the form of
 * `maxlength`. The upload types and the origin list are in one place each for the
 * same reason: a second copy always drifts, and here the two copies guard the
 * same collection from two different entry points, so a drift is a hole.
 */

/** Matches Message.content's maxlength. */
export const MAX_CONTENT_LENGTH = 10000;

export const MAX_MEDIA_PER_MESSAGE = 10;

/** Matches Message.media[].type's enum. */
export const MEDIA_TYPES = new Set([
  "image", "video", "gif", "audio", "document", "voice", "sticker",
]);

/**
 * Message types a client may ask for.
 *
 * `messageType` came straight off the payload, constrained only by the schema
 * enum — so a client could send `system` and have arbitrary text render in the
 * recipient's UI as a system notice, or `call` to forge a call log, or
 * `post_share` to produce a half-built card. The rest of the enum is produced by
 * the server and stays that way.
 */
export const CLIENT_MESSAGE_TYPES = new Set([
  "text", "media", "voice", "gif", "file", "location", "sticker",
]);

/**
 * Message types whose `content` an author may edit.
 *
 * `content` is the body of a text message and the caption of an attachment, so
 * both are editable. Everything else either has no text — a sticker, a GIF, a
 * voice note — or has text the server produced and the client must not rewrite: a
 * poll's question with votes already cast against it, a call log, a shared post's
 * card, a system notice. Editing was gated on ownership and the clock only, so all
 * of those were writable through the edit routes.
 */
export const EDITABLE_MESSAGE_TYPES = new Set(["text", "media", "file"]);
