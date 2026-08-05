/**
 * Pure, render-free helpers shared by every chat thread.
 *
 * These lived at the top of UserConversationPage, which is why GroupChatPage had none
 * of them: no relative timestamps, no reply-preview labels, no caption-aware bubble
 * body. Group messages were rendered with a bare `toLocaleTimeString` and
 * `msg.content`, so the two threads formatted the same data differently.
 *
 * No React, no DOM — so they are testable on their own and cheap to import anywhere.
 * That is also why this is a `.js` file and why `getMessageBody` is *not* here: it
 * returns JSX, and Vite picks its loader by extension, so JSX in a `.js` file fails
 * the build outright.
 */

export const formatInstagramTimestamp = (dateString) => {
  const messageDate = new Date(dateString);
  const now = new Date();

  const isToday = messageDate.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = messageDate.toDateString() === yesterday.toDateString();

  const hours = messageDate.getHours() % 12 || 12;
  const minutes = messageDate.getMinutes().toString().padStart(2, "0");
  const ampm = messageDate.getHours() >= 12 ? "pm" : "am";
  const timeStr = `${hours}:${minutes} ${ampm}`;

  if (isToday) return `Today ${timeStr}`;
  if (isYesterday) return `Yesterday ${timeStr}`;

  const daysDiff = Math.floor((now - messageDate) / (1000 * 60 * 60 * 24));
  if (daysDiff < 7) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[messageDate.getDay()]} ${timeStr}`;
  }

  if (messageDate.getFullYear() === now.getFullYear()) {
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return `${messageDate.getDate()} ${months[messageDate.getMonth()]}, ${timeStr}`;
  }

  const day = messageDate.getDate().toString().padStart(2, "0");
  const month = (messageDate.getMonth() + 1).toString().padStart(2, "0");
  return `${day}-${month}-${messageDate.getFullYear()}`;
};

/*
 * A one-line stand-in for a message, for places that have no room to render
 * the real thing: reply previews, the pinned bar, search hits.
 *
 * Kept separate from the bubble body on purpose. One function used to do both,
 * and it switched on `messageType` *before* falling back to `content` — so a
 * photo with a caption rendered the literal string "📷 Media" above the photo
 * instead of what the sender wrote. A label describes a message; a body is the
 * message.
 */
const SYSTEM_PREVIEW = {
  group_renamed: "Group name changed",
  group_avatar_changed: "Group photo changed",
  members_added: "Someone was added",
  member_removed: "Someone was removed",
  member_left: "Someone left",
  member_joined: "Someone joined",
  role_changed: "A role changed",
};

export const messagePreviewLabel = (message) => {
  if (!message) return "";
  if (message.isDeleted) return "This message was deleted";

  const caption = message.content?.trim();

  switch (message.messageType) {
    case "media":
      return caption || "📷 Media";
    case "voice":
      return "🎤 Voice message";
    case "poll":
      return caption || "📊 Poll";
    case "sticker":
      return "🎨 Sticker";
    case "gif":
      return "GIF";
    case "post_share":
      return caption || "📷 Shared a post";
    /*
     * There was no `call` case, so a reply quoting a call log — and the pinned bar —
     * fell through to `caption || ""`, which for a call log is always the empty
     * string: a preview with nothing in it.
     */
    case "call":
      return message.call?.type === "video" ? "📹 Video call" : "📞 Voice call";
    /*
     * A group event, in the chat list and reply previews.
     *
     * Not the full sentence: `groupEventText` needs a viewer to say "you", and this
     * helper has no viewer. The list row shows what kind of thing happened, which is
     * enough to explain why the conversation moved to the top.
     */
    case "system":
      return SYSTEM_PREVIEW[message.system?.kind] || "Group updated";
    default:
      return caption || "";
  }
};

// ── Thread grouping and dividers ────────────────────────────────────────────

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** An hour of silence, or a new day, earns a divider. */
const TIME_DIVIDER_GAP_MS = 60 * 60 * 1000;

/** Consecutive messages from one sender within this window share a bubble stack. */
const MESSAGE_GROUP_GAP_MS = 2 * 60 * 1000;

export const shouldShowTimestamp = (prevGroup, currentGroup) => {
  if (!prevGroup) return true;

  const prevTime = new Date(prevGroup[prevGroup.length - 1].createdAt);
  const currentTime = new Date(currentGroup[0].createdAt);

  if (!sameDay(prevTime, currentTime)) return true;
  return currentTime - prevTime >= TIME_DIVIDER_GAP_MS;
};

/**
 * The divider's label: a day when the day changed, a clock time otherwise.
 *
 * A bare "09:14" over the first message of a new day says nothing about which day,
 * which is the information the divider exists to carry.
 */
export const timestampDividerLabel = (prevGroup, currentGroup) => {
  const currentTime = new Date(currentGroup[0].createdAt);
  const prevTime = prevGroup
    ? new Date(prevGroup[prevGroup.length - 1].createdAt)
    : null;

  if (!prevTime || !sameDay(prevTime, currentTime)) {
    const today = new Date();
    if (sameDay(currentTime, today)) return "Today";
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(currentTime, yesterday)) return "Yesterday";
    return currentTime.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      // Only when it isn't this year — "12 Mar 2024" vs "12 Mar".
      ...(currentTime.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    });
  }
  return currentTime.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
};

/**
 * Split a flat message array into stacks by sender and time.
 *
 * A "group" is consecutive messages from the same side, close together — they share
 * one avatar and one set of rounded corners. Each message is tagged with `isOwn` here
 * so the renderer never has to know who the viewer is.
 *
 * `senderIdOf` rather than a hardcoded `message.sender._id`: a DM's optimistic message
 * carries a bare id while a delivered one carries a populated document.
 */
export const senderIdOf = (message) =>
  String(message?.sender?._id || message?.sender || "");

export const groupMessagesBySender = (messages, viewerId) => {
  const grouped = [];
  let currentGroup = [];
  const viewer = String(viewerId || "");

  (messages || []).forEach((message) => {
    const isOwn = senderIdOf(message) === viewer;

    if (
      currentGroup.length === 0 ||
      currentGroup[0].isOwn !== isOwn ||
      // A different person in a group chat starts a new stack even within the window.
      senderIdOf(currentGroup[0]) !== senderIdOf(message) ||
      /*
       * A system notice never shares a stack with a real message.
       *
       * Its `sender` is the person who performed the action, so "Ana changed the group
       * name" followed by something Ana actually said would have stacked into one
       * bubble group under her avatar — making the notice look like her words.
       */
      (currentGroup[0].messageType === "system") !== (message.messageType === "system") ||
      new Date(message.createdAt) -
        new Date(currentGroup[currentGroup.length - 1].createdAt) >
        MESSAGE_GROUP_GAP_MS
    ) {
      if (currentGroup.length > 0) grouped.push(currentGroup);
      currentGroup = [];
    }

    currentGroup.push({ ...message, isOwn });
  });

  if (currentGroup.length > 0) grouped.push(currentGroup);
  return grouped;
};

// ── Voice note envelope ─────────────────────────────────────────────────────

/** How many envelope samples a sent voice note carries. */
export const WAVEFORM_BUCKETS = 64;

/**
 * Average an arbitrarily long amplitude series down to a fixed number of buckets.
 *
 * The recorder samples once per animation frame — around 60 a second — so the raw
 * series is far longer than any bubble can draw, and its length varies with both
 * clip length and frame rate. Averaging into fixed buckets makes the stored envelope
 * a *shape* rather than a sample count, so the same recording looks the same however
 * long it is and whatever the device's frame rate was.
 *
 * Averaging rather than picking every Nth sample: sampling would alias, and on a
 * voice envelope that shows up as bars that jitter between loud and silent for no
 * reason the listener can hear.
 */
export const downsampleWaveform = (samples, buckets = WAVEFORM_BUCKETS) => {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  if (samples.length <= buckets) {
    return samples.map((n) => Math.min(1, Math.max(0, Number(n) || 0)));
  }

  const out = [];
  const size = samples.length / buckets;
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * size);
    const end = Math.min(samples.length, Math.floor((i + 1) * size));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      const value = Number(samples[j]);
      if (Number.isFinite(value)) {
        sum += value;
        count += 1;
      }
    }
    out.push(count ? Math.min(1, Math.max(0, sum / count)) : 0);
  }
  return out;
};

/** `mm:ss` from a possibly-fractional number of seconds. */
export const formatClock = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
};
