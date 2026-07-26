/**
 * Client-side rules for polls and locations. Mirrors the limits enforced in
 * server/utils/attachments.js — the server is the authority, this is here so
 * the composer can disable a button instead of letting people find out on
 * submit.
 */

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_QUESTION_MAX = 200;
export const POLL_OPTION_MAX = 60;

/** X's set, near enough. Value is minutes, which is what the API takes. */
export const POLL_DURATIONS = [
  { value: 5, label: "5 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 6 * 60, label: "6 hours" },
  { value: 24 * 60, label: "1 day" },
  { value: 3 * 24 * 60, label: "3 days" },
  { value: 7 * 24 * 60, label: "7 days" },
];

export const DEFAULT_POLL_DURATION = 24 * 60;

/**
 * Why this poll can't be posted yet, or null if it can. Returns the reason so
 * the composer can say it rather than just greying the button out.
 */
export const validatePoll = ({ question, options, durationMinutes }) => {
  const q = (question || "").trim();
  if (!q) return "Give your poll a question";
  if (q.length > POLL_QUESTION_MAX) return "That question is too long";

  const filled = (options || []).map((o) => (o || "").trim()).filter(Boolean);
  if (filled.length < POLL_MIN_OPTIONS) return "Fill in at least two options";
  if (filled.some((o) => o.length > POLL_OPTION_MAX)) return "One of the options is too long";
  if (new Set(filled.map((o) => o.toLowerCase())).size !== filled.length) {
    return "Two options say the same thing";
  }
  if (!POLL_DURATIONS.some((d) => d.value === durationMinutes)) return "Choose how long it runs";

  return null;
};

/** "2 days left", "4 hours left", "Final results" */
export const pollTimeLeft = (closesAt) => {
  if (!closesAt) return "";
  const ms = new Date(closesAt).getTime() - Date.now();
  if (ms <= 0) return "Final results";

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "Less than a minute left";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} left`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} left`;
};

/** "1,204 votes" */
export const formatVotes = (n) => {
  if (!Number.isFinite(n)) return "";
  return `${n.toLocaleString()} vote${n === 1 ? "" : "s"}`;
};

/** Whole-number percentage, guarding the zero-total case. */
export const votePercent = (votes, total) => {
  if (!total || !Number.isFinite(votes)) return 0;
  return Math.round((votes / total) * 100);
};

/** Opens the tagged place in whatever map app the device prefers. */
export const mapLinkFor = (location) => {
  if (!location) return null;
  if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    return `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=17/${location.lat}/${location.lng}`;
  }
  // No coordinates — a hand-typed place name. Fall back to a search.
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(location.name)}`;
};
