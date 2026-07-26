/**
 * Mirror of server/utils/mediaTypes.js — keep the two in step.
 *
 * Duplicated rather than shared because the frontend and server are separate
 * packages with no common build step. The rule is the same one the report
 * categories follow: if you change one, change the other.
 */

export const MEDIA_TYPES = ["image", "video", "gif", "audio"];

export const ATTACHMENT_KINDS = ["media", "gif", "audio", "poll"];

const EXTENSIONS = {
  video: ["mp4", "webm", "ogg", "mov", "m4v", "mkv"],
  audio: ["mp3", "wav", "m4a", "aac", "oga", "opus", "weba", "flac"],
  gif: ["gif"],
};

const extensionOf = (url) => {
  if (typeof url !== "string") return "";
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return "";
  return path.slice(dot + 1).toLowerCase();
};

export const guessMediaType = (url) => {
  const ext = extensionOf(url);
  for (const [type, extensions] of Object.entries(EXTENSIONS)) {
    if (extensions.includes(ext)) return type;
  }
  return "image";
};

/**
 * Turns whatever the API returned — legacy URL strings, typed objects, or a
 * mix — into typed items. Every component that renders media calls this, which
 * is what replaced the five separate `isVideo` helpers.
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
      return {
        url: item.url,
        type,
        thumbnail: item.thumbnail || null,
        duration: Number.isFinite(item.duration) ? item.duration : null,
        waveform: Array.isArray(item.waveform) ? item.waveform : null,
        width: Number.isFinite(item.width) ? item.width : null,
        height: Number.isFinite(item.height) ? item.height : null,
      };
    })
    .filter(Boolean);
};

/** True for the types that play rather than sit still. */
export const isPlayable = (item) => item?.type === "video" || item?.type === "audio";

/** mm:ss for an audio or video duration in seconds. */
export const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
