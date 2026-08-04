/**
 * The composer's attachment rules — sizes, types, and how a selection is filtered.
 *
 * These lived as module constants at the top of UserConversationPage, with a second,
 * narrower copy in GroupChatPage: the DM composer capped files at 50MB and accepted
 * `image/` wholesale, the group one had no `accept` attribute at all and validated
 * nothing but the size. Same server behind both.
 *
 * Pure — no React, no DOM, no toasts. `pickComposerFiles` returns what was accepted and
 * a tally of why the rest wasn't, and leaves it to the caller to decide how to say so.
 * That is what makes the rules testable without a browser.
 */

/*
 * Matches multer's limit in server/config/multerConfig.js.
 *
 * The DM composer had 100MB against 50MB there, so a 60MB video passed the check,
 * uploaded in full, and was then rejected — the failure arrived after the wait rather
 * than before it.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Matches the server's cap in config/socket.js. */
export const MAX_MEDIA_PER_MESSAGE = 10;

export const MAX_MESSAGE_LENGTH = 10000;

/*
 * What the composer validates against, mirroring the shape of the server's rule in
 * config/multerConfig.js — `image/` wholesale plus the specific video containers.
 *
 * `image/` rather than a list of formats is the point: the enumerated list this
 * replaces had no `image/heic` or `image/heif`, so every photo from an iPhone was
 * rejected in the composer even though the server would have accepted it (#110).
 */
export const COMPOSER_MEDIA_TYPES = [
  "image/",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
];

/*
 * The `accept` attribute. Distinct from the validator above because a file picker needs
 * concrete types, and iOS in particular will not offer HEIC photos unless the attribute
 * names them — `image/*` alone makes it silently transcode or omit them depending on
 * version.
 */
export const COMPOSER_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
].join(",");

export const TOO_LARGE = `File size too large. Maximum size is ${
  MAX_FILE_SIZE / 1024 / 1024
}MB`;
export const WRONG_TYPE = "Only images and videos can be attached here";
export const TOO_MANY = `Up to ${MAX_MEDIA_PER_MESSAGE} attachments per message`;

/** `"image"` or `"video"` — the tray draws a still frame for one and a thumbnail for the other. */
export const classifyComposerFile = (file) =>
  file?.type?.startsWith("image/") ? "image" : "video";

/** @returns {string|null} why the file can't be attached, or null if it can. */
export const rejectionFor = (file) => {
  if (!file) return WRONG_TYPE;
  if (file.size > MAX_FILE_SIZE) return TOO_LARGE;
  if (!COMPOSER_MEDIA_TYPES.some((prefix) => file.type?.startsWith(prefix))) {
    return WRONG_TYPE;
  }
  return null;
};

/**
 * Filter a picked FileList against the rules and the remaining room in the tray.
 *
 * @param files       What the picker handed over.
 * @param alreadyHeld How many attachments are already staged.
 * @returns `{ accepted, rejections }` — `rejections` is a Map of reason → count.
 *
 * **One entry per reason, not per file** (#110). Picking twenty photos on a phone and
 * having one rule reject them produced twenty stacked toasts, which buries the screen
 * and says the same thing twenty times. The caller reports each reason once, with how
 * many files it applied to.
 *
 * The cap is applied here rather than only server-side because the send path uploads
 * every attachment to Cloudinary *before* it emits, so an over-limit batch would finish
 * all of its uploads and then be refused as a whole.
 */
export const pickComposerFiles = (files, alreadyHeld = 0) => {
  const accepted = [];
  const rejections = new Map();
  const note = (reason) => rejections.set(reason, (rejections.get(reason) || 0) + 1);

  const room = Math.max(0, MAX_MEDIA_PER_MESSAGE - alreadyHeld);

  for (const file of Array.from(files || [])) {
    const reason = rejectionFor(file);
    if (reason) {
      note(reason);
      continue;
    }
    // Over the cap is a rejection like any other, so it's reported the same way and
    // the accepted files still go through — dropping the whole batch would be worse.
    if (accepted.length >= room) {
      note(TOO_MANY);
      continue;
    }
    accepted.push({ file, type: classifyComposerFile(file) });
  }

  return { accepted, rejections };
};
