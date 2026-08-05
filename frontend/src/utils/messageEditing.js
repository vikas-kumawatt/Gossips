/**
 * Whether the Edit affordance should be offered for a message.
 *
 * Mirrors `EDITABLE_MESSAGE_TYPES` and the fifteen-minute window the server
 * enforces. The menu used to be gated on "it's mine, it has text, it isn't
 * deleted" only, so it appeared over polls, call logs, shared posts and voice
 * notes that happened to carry text — and over messages hours old. Tapping it
 * opened edit mode and the save then failed, which is a worse outcome than the
 * item not being there.
 *
 * The client can't be the enforcement — the server is, at both entry points — but
 * an affordance that leads to a guaranteed refusal is a bug in its own right.
 */

/** Message types whose text is the author's own. Mirrors utils/messageContent.js. */
const EDITABLE_TYPES = new Set(["text", "media"]);

const EDIT_WINDOW_MS = 15 * 60 * 1000;

export const canEditMessage = (message) => {
  if (!message?.isOwn || message.isDeleted) return false;
  if (!message.content) return false;
  // `messageType` defaults to "text" server-side, so an absent one is editable.
  if (!EDITABLE_TYPES.has(message.messageType ?? "text")) return false;
  const createdAt = message.createdAt ? new Date(message.createdAt).getTime() : NaN;
  if (Number.isNaN(createdAt)) return false;
  return Date.now() - createdAt < EDIT_WINDOW_MS;
};
