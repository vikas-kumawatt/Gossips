import { nanoid } from "nanoid";
import PollVote from "../models/PollVote.js";
import { normalizeMedia } from "./mediaTypes.js";

/**
 * Parsing and validating what a composer sends: GIFs, audio, polls, locations.
 *
 * Everything here rejects loudly. A malformed poll that silently posts as a
 * plain text update is worse than an error message — the author thinks they
 * asked a question and nobody can answer it.
 */

// ── Polls ────────────────────────────────────────────────────────────────────

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_MIN_MINUTES = 5;
export const POLL_MAX_MINUTES = 7 * 24 * 60;
const POLL_QUESTION_MAX = 200;
const POLL_OPTION_MAX = 60;

/**
 * Turns the composer's payload into a stored poll, or explains why it can't.
 * Returns { poll } | { error } | {} when no poll was sent.
 *
 * `closesAt` is deliberately left null: the clock starts when the post becomes
 * visible, which for a scheduled post is not now. The publisher sets it.
 */
export const parsePoll = (raw) => {
  if (raw === undefined || raw === null || raw === "") return {};

  let value = raw;
  if (typeof value === "string") {
    // Multipart form fields arrive as strings.
    try {
      value = JSON.parse(value);
    } catch {
      return { error: "That poll isn't in a format we understand" };
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "That poll isn't in a format we understand" };
  }

  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question) return { error: "Give your poll a question" };
  if (question.length > POLL_QUESTION_MAX) {
    return { error: `The question must be under ${POLL_QUESTION_MAX} characters` };
  }

  if (!Array.isArray(value.options)) return { error: "A poll needs options" };

  const texts = value.options
    .map((o) => (typeof o === "string" ? o : o?.text))
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean);

  if (texts.length < POLL_MIN_OPTIONS) {
    return { error: `A poll needs at least ${POLL_MIN_OPTIONS} options` };
  }
  if (texts.length > POLL_MAX_OPTIONS) {
    return { error: `A poll can have at most ${POLL_MAX_OPTIONS} options` };
  }
  if (texts.some((t) => t.length > POLL_OPTION_MAX)) {
    return { error: `Each option must be under ${POLL_OPTION_MAX} characters` };
  }
  // Two identically-worded options make the result meaningless and the UI
  // ambiguous, so they're caught here rather than left to the voter.
  const seen = new Set(texts.map((t) => t.toLowerCase()));
  if (seen.size !== texts.length) return { error: "Two options say the same thing" };

  const minutes = Number(value.durationMinutes);
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) {
    return { error: "Choose how long the poll runs" };
  }
  if (minutes < POLL_MIN_MINUTES || minutes > POLL_MAX_MINUTES) {
    return { error: "A poll can run from 5 minutes to 7 days" };
  }

  return {
    poll: {
      question,
      options: texts.map((text) => ({ id: nanoid(8), text, votes: 0 })),
      totalVotes: 0,
      closesAt: null,
      durationMinutes: minutes,
    },
  };
};

/** Starts a poll's clock. Called when the content actually becomes visible. */
export const openPollClock = (poll) => {
  if (!poll) return null;
  return { ...poll, closesAt: new Date(Date.now() + poll.durationMinutes * 60 * 1000) };
};

export const isPollClosed = (poll) =>
  Boolean(poll?.closesAt) && new Date(poll.closesAt).getTime() <= Date.now();

// ── Location ─────────────────────────────────────────────────────────────────

/** Returns { location } | { error } | {} when none was sent. */
export const parseLocation = (raw) => {
  if (raw === undefined || raw === null || raw === "") return {};

  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: "That location isn't in a format we understand" };
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "That location isn't in a format we understand" };
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return { error: "That location has no name" };
  if (name.length > 120) return { error: "That place name is too long" };

  const location = { name };

  if (typeof value.address === "string" && value.address.trim()) {
    location.address = value.address.trim().slice(0, 300);
  }
  if (typeof value.placeId === "string") location.placeId = value.placeId.slice(0, 64);

  // Coordinates are optional — a hand-typed place name has none — but if
  // they're present they have to be real, or the map link points to null island.
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  const hasLat = value.lat !== undefined;
  const hasLng = value.lng !== undefined;
  // A half-coordinate is not a useful location. Previously it was silently
  // dropped, which made a malformed request look as though it had succeeded.
  if (hasLat !== hasLng) {
    return { error: "That location's coordinates aren't valid" };
  }
  if (hasLat) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: "That location's coordinates aren't valid" };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { error: "That location's coordinates aren't valid" };
    }
    location.lat = lat;
    location.lng = lng;
  }

  return { location };
};

// ── GIFs ─────────────────────────────────────────────────────────────────────

/**
 * GIFs are hotlinked from Giphy rather than re-uploaded, so the URL comes from
 * the client and has to be checked. Without an allow-list this is an open
 * redirect / SSRF-adjacent hole: any URL the client sends would be rendered in
 * every reader's browser, which is a tracking-pixel vector at minimum.
 */
const GIF_HOSTS = ["media.giphy.com", "i.giphy.com", "media0.giphy.com", "media1.giphy.com", "media2.giphy.com", "media3.giphy.com", "media4.giphy.com"];

export const parseGif = (raw) => {
  if (raw === undefined || raw === null || raw === "") return {};

  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: "That GIF isn't in a format we understand" };
    }
  }
  if (typeof value !== "object" || Array.isArray(value) || !value.url) {
    return { error: "That GIF isn't in a format we understand" };
  }

  let url;
  try {
    url = new URL(value.url);
  } catch {
    return { error: "That GIF's address isn't valid" };
  }
  if (url.protocol !== "https:" || !GIF_HOSTS.includes(url.hostname)) {
    return { error: "GIFs have to come from the picker" };
  }

  const item = { url: url.toString(), type: "gif" };
  if (Number.isFinite(Number(value.width))) item.width = Number(value.width);
  if (Number.isFinite(Number(value.height))) item.height = Number(value.height);
  return { gif: item };
};

// ── Exclusivity ──────────────────────────────────────────────────────────────

/**
 * One attachment per post. Enforced here as well as in the composer, because
 * the composer is just a UI and this endpoint is public.
 */
export const resolveAttachment = ({ uploaded = [], gif = null, poll = null }) => {
  const media = normalizeMedia(uploaded);
  const hasAudio = media.some((m) => m.type === "audio");
  const hasVisual = media.some((m) => m.type !== "audio");

  const present = [];
  if (hasVisual) present.push("media");
  if (hasAudio) present.push("audio");
  if (gif) present.push("gif");
  if (poll) present.push("poll");

  if (present.length > 1) {
    return { error: "A post can have photos, a GIF, an audio clip or a poll — not more than one" };
  }
  // An audio clip is one recording, not a playlist.
  if (hasAudio && media.length > 1) {
    return { error: "Send one audio clip at a time" };
  }

  if (gif) return { media: [gif] };
  return { media };
};

// ── One entry point for the composers ────────────────────────────────────────

/** Audio longer than this is a podcast, not a post. */
export const AUDIO_MAX_SECONDS = 5 * 60;

/**
 * Everything a create endpoint needs to do with an attachment payload, in one
 * call: parse each part, apply the exclusivity rule, attach the recorded
 * waveform. Returns { media, poll, location } or { error }.
 *
 * Shared by createPost, replyOnPost, createNestedComment and saveDraft so the
 * rules can't drift between a post and a reply — they were four near-identical
 * bodies already, and this is the part most likely to be edited in only one.
 */
export const parseAttachments = async ({ files = [], body = {}, uploader }) => {
  const { poll, error: pollError } = parsePoll(body.poll);
  if (pollError) return { error: pollError };

  const { location, error: locationError } = parseLocation(body.location);
  if (locationError) return { error: locationError };

  const { gif, error: gifError } = parseGif(body.gif);
  if (gifError) return { error: gifError };

  const uploaded = files.length ? await uploader(files) : [];

  // The waveform is captured by the recorder in the browser — the server has
  // no cheap way to compute one, and Cloudinary doesn't return it.
  if (body.waveform) {
    const audio = uploaded.find((m) => m.type === "audio");
    if (audio) {
      const samples = parseWaveform(body.waveform);
      if (samples) audio.waveform = samples;
    }
  }

  // An unknown duration doesn't get a pass — a clip Cloudinary couldn't
  // probe is exactly the kind most likely to be oversized.
  const tooLong = uploaded.find(
    (m) => m.type === "audio" && (!Number.isFinite(m.duration) || m.duration > AUDIO_MAX_SECONDS)
  );
  if (tooLong) return { error: "Audio clips can be up to 5 minutes" };

  const { media, error } = resolveAttachment({ uploaded, gif, poll });
  if (error) return { error };

  return { media, poll: poll || null, location: location || null };
};

/**
 * Waveform samples from the recorder: normalised 0-1, capped in length so a
 * client can't inflate the document with a hundred thousand floats.
 */
const WAVEFORM_MAX_SAMPLES = 200;

const parseWaveform = (raw) => {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || !value.length) return null;

  const samples = value
    .slice(0, WAVEFORM_MAX_SAMPLES)
    .map((n) => Number(n))
    .filter(Number.isFinite)
    // Clamp rather than reject: a slightly out-of-range sample is a rounding
    // artefact, not an attack, and the bar just draws at full height.
    .map((n) => Math.min(1, Math.max(0, n)));

  return samples.length ? samples : null;
};

// ── Per-viewer poll projection ───────────────────────────────────────────────

/**
 * What a specific reader is allowed to see of a poll.
 *
 * X's rule, and the reason it matters: showing a running tally to someone who
 * hasn't voted biases the result. So counts are withheld until you've voted or
 * the poll has closed. The withholding happens here, server-side — sending the
 * numbers and hiding them in CSS would leak them to anyone with a network tab.
 */
export const projectPoll = (poll, myVote) => {
  if (!poll) return null;

  const closed = isPollClosed(poll);
  const hasVoted = Boolean(myVote);
  const reveal = closed || hasVoted;

  return {
    question: poll.question,
    options: poll.options.map((o) => ({
      id: o.id,
      text: o.text,
      votes: reveal ? o.votes : null,
    })),
    totalVotes: reveal ? poll.totalVotes : null,
    closesAt: poll.closesAt,
    closed,
    hasVoted,
    myOptionId: myVote?.optionId || null,
  };
};

/**
 * Loads one reader's votes across a page of content in a single query, so a
 * feed of polls doesn't fan out into one lookup per post.
 */
export const loadMyVotes = async (viewerId, targetIds) => {
  if (!viewerId || !targetIds.length) return new Map();
  const votes = await PollVote.find({ user: viewerId, target: { $in: targetIds } })
    .select("target optionId")
    .lean();
  return new Map(votes.map((v) => [v.target.toString(), v]));
};

/**
 * The one thing every read path must do before returning posts or comments:
 * normalise media into typed items, and reduce each poll to what this
 * particular reader is allowed to know.
 *
 * It's a single decorator rather than a line in each controller because
 * forgetting it in one place leaks live poll results to people who haven't
 * voted — a silent correctness bug that looks fine in the UI.
 *
 * Nested quoted posts are decorated too; their polls are just as leakable.
 * Accepts one document or an array and returns the same shape.
 */
export const decorateContent = async (input, viewerId) => {
  const one = !Array.isArray(input);
  const items = (one ? [input] : input).filter(Boolean);
  if (!items.length) return one ? input : input;

  // Collect every id that carries a poll, including nested quotes, so the
  // vote lookup is a single query for the whole page.
  const pollIds = [];
  const collect = (doc) => {
    if (!doc) return;
    if (doc.poll?.question && doc._id) pollIds.push(doc._id);
    collect(doc.quotedPost);
    collect(doc.quotedComment);
    // `getCommentsWithReplies` embeds the first page of nested replies in the
    // top-level comment. They are still independently readable poll targets,
    // so omitting them here would send their raw vote counts to non-voters.
    if (Array.isArray(doc.replies)) doc.replies.forEach(collect);
  };
  items.forEach(collect);

  const myVotes = await loadMyVotes(viewerId, pollIds);

  const decorate = (doc) => {
    if (!doc || typeof doc !== "object") return doc;
    doc.media = normalizeMedia(doc.media);
    if (doc.poll?.question) {
      doc.poll = projectPoll(doc.poll, myVotes.get(doc._id?.toString()));
    }
    if (doc.quotedPost) decorate(doc.quotedPost);
    if (doc.quotedComment) decorate(doc.quotedComment);
    if (Array.isArray(doc.replies)) doc.replies.forEach(decorate);
    return doc;
  };

  const out = items.map(decorate);
  return one ? out[0] : out;
};
