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
  "image", "video", "gif", "audio", "voice", "sticker",
]);

/**
 * Message types a client may ask for.
 *
 * `messageType` came straight off the payload, constrained only by the schema
 * enum — so a client could send `system` and have arbitrary text render in the
 * recipient's UI as a system notice, or `call` to forge a call log, or
 * `post_share` to produce a half-built card. The rest of the enum is produced by
 * the server and stays that way.
 *
 * `file` was here and isn't now: document sending has been removed from the product, so
 * an accepted `file` message would be one no client can produce. The stored ones were
 * retyped to "text" tombstones by scripts/purgeDocumentMessages.js, so the schema no
 * longer carries the value either.
 */
export const CLIENT_MESSAGE_TYPES = new Set([
  "text", "media", "voice", "gif", "location", "sticker",
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
 *
 * `file` is gone from here too. Documents were removed and the stored ones are tombstones
 * now, which no path lets anyone edit — so listing the type would be describing a message
 * that can no longer exist.
 */
export const EDITABLE_MESSAGE_TYPES = new Set(["text", "media"]);

/*
 * ── The send pipeline ───────────────────────────────────────────────────────
 *
 * `parseSendPayload` was local to config/socket.js, which made it unreachable from anything
 * that wasn't a socket handler. It belongs here, with the limits and type sets it enforces, so
 * every send path applies one implementation of "is this payload acceptable" rather than a
 * copy each.
 *
 * `messageEntities` moved out again, to utils/mentions.js. It needs `resolveMessageMentions`,
 * which imports four models — so having it here turned this module from a leaf into something
 * that transitively loads the whole User graph, and the chatAccess harness, which imports
 * these constants cheaply, stopped being able to start. A validation module should be
 * importable without a database.
 */
import { isAllowedGif, stripMediaToken, verifyMedia } from "./mediaToken.js";

/**
 * Validate the parts of a send payload both handlers share.
 *
 * Nothing previously required content *or* media, so an empty bubble was a
 * valid message — and at socket speed, a flood primitive.
 *
 * Returns `{ error }` or the cleaned fields.
 */
export const parseSendPayload = ({ content, media, messageType }) => {
  const text = typeof content === "string" ? content.trim() : "";
  const items = Array.isArray(media) ? media : [];

  if (!text && !items.length) return { error: "Write something first" };
  if (text.length > MAX_CONTENT_LENGTH) {
    // Caught here rather than by the schema, which would surface as a generic
    // "failed to send" from the catch block.
    return { error: "That message is too long" };
  }
  if (items.length > MAX_MEDIA_PER_MESSAGE) {
    return { error: `Up to ${MAX_MEDIA_PER_MESSAGE} attachments per message` };
  }
  const verified = [];
  for (const item of items) {
    if (!item || typeof item.url !== "string" || !item.url.startsWith("https://")) {
      return { error: "That attachment isn't valid" };
    }
    if (item.type !== undefined && !MEDIA_TYPES.has(item.type)) {
      return { error: "That attachment isn't valid" };
    }
    // The upload endpoint derives `type` from the file it received and signs
    // the result. Checking that signature is what stops a document being
    // relabelled as an image to slip past a group's mediaSharing rule, and stops
    // an arbitrary URL being passed off as an upload at all.
    //
    // GIFs are the exception: they're hotlinked from the picker and never
    // uploaded, so there's nothing to have signed. The host allow-list does
    // that job instead.
    if (!isAllowedGif(item) && !verifyMedia(item)) {
      return { error: "That attachment couldn't be verified — try uploading it again" };
    }
    verified.push(stripMediaToken(item));
  }

  if (!CLIENT_MESSAGE_TYPES.has(messageType)) {
    return { error: "Unsupported message type" };
  }
  return { content: text, media: verified, messageType };
};
