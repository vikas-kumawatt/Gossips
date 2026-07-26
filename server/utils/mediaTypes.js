/**
 * The vocabulary for post and comment attachments.
 *
 * `media` used to be a plain `[String]` of Cloudinary URLs, with every renderer
 * guessing image-vs-video from the file extension — five copies of `isVideo`,
 * three of which disagreed. Audio can't be guessed that way at all (a .mp3 URL
 * fell through to `<img>`), and nothing could carry a duration or a waveform.
 *
 * So media is now a typed subdocument. Old posts still hold bare strings, and
 * `normalizeMedia` upgrades them on read using the same extension guess as
 * before — no migration script, no backfill, and nothing to go wrong halfway.
 * Keep this file in step with frontend/src/lib/mediaTypes.js.
 */

export const MEDIA_TYPES = ["image", "video", "gif", "audio"];

/**
 * What a post carries besides text. Exactly one of these at a time — the
 * composer enforces it and so does the server, because a post that is both a
 * poll and an audio clip has no sensible layout and every renderer would have
 * to guess which wins.
 *
 * Location is deliberately absent: it's a tag that sits alongside any of these.
 */
export const ATTACHMENT_KINDS = ["media", "gif", "audio", "poll"];

const EXTENSIONS = {
  video: ["mp4", "webm", "ogg", "mov", "m4v", "mkv"],
  audio: ["mp3", "wav", "m4a", "aac", "oga", "opus", "weba", "flac"],
  gif: ["gif"],
};

/** The extension, lowercased, ignoring any query string or fragment. */
const extensionOf = (url) => {
  if (typeof url !== "string") return "";
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return "";
  return path.slice(dot + 1).toLowerCase();
};

/**
 * Best guess at what a bare URL points to. Only used for legacy rows and as a
 * sanity check on new ones — anything created from now on states its type.
 *
 * `webm` is ambiguous: Cloudinary serves both video and audio with it. It's
 * read as video here because that's what the old `isVideo` did, so legacy rows
 * keep rendering exactly as they always have. New audio recordings say so
 * explicitly rather than relying on this.
 */
export const guessMediaType = (url) => {
  const ext = extensionOf(url);
  for (const [type, extensions] of Object.entries(EXTENSIONS)) {
    if (extensions.includes(ext)) return type;
  }
  return "image";
};

/**
 * Coerces whatever is stored — legacy strings, typed objects, a mix of both —
 * into a consistent array of typed items. Every read path runs through this,
 * so no renderer ever has to ask which era a post came from.
 */
export const normalizeMedia = (media) => {
  if (!media) return [];
  const list = Array.isArray(media) ? media : [media];

  return list
    .map((item) => {
      if (typeof item === "string") {
        // An empty string is not a URL — it would render as a broken image.
        return item ? { url: item, type: guessMediaType(item) } : null;
      }
      if (!item || typeof item !== "object" || !item.url) return null;

      const type = MEDIA_TYPES.includes(item.type) ? item.type : guessMediaType(item.url);
      const out = { url: item.url, type };

      // Only carry the optional fields that are actually set, so a plain image
      // doesn't ship a pile of nulls to every reader.
      if (item.thumbnail) out.thumbnail = item.thumbnail;
      if (Number.isFinite(item.duration)) out.duration = item.duration;
      if (Array.isArray(item.waveform) && item.waveform.length) out.waveform = item.waveform;
      if (Number.isFinite(item.width)) out.width = item.width;
      if (Number.isFinite(item.height)) out.height = item.height;

      return out;
    })
    .filter(Boolean);
};

/** The single attachment this content carries, or null for a plain text post. */
export const attachmentKindOf = (doc) => {
  if (doc?.poll?.question) return "poll";
  const media = normalizeMedia(doc?.media);
  if (!media.length) return null;
  if (media.some((m) => m.type === "audio")) return "audio";
  if (media.every((m) => m.type === "gif")) return "gif";
  return "media";
};
