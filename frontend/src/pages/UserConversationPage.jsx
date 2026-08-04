import React, {
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { UserContext } from "../contexts/UserContext";
import { useChat } from "../contexts/ChatContext";
import { useBlock } from "../contexts/BlockContext";
import { useReport } from "../contexts/ReportContext";
import { chatAPI, userAPI } from "../services/api";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Icons } from "../components/icons";
import SharedPostCard from "../components/Chat/SharedPostCard";
import PollBubble from "../components/Chat/PollBubble";
import ChatLockPrompt from "../components/Chat/ChatLockPrompt";
import VoiceNoteBubble from "../components/Chat/VoiceNoteBubble";
import ChatVideoBubble from "../components/Chat/ChatVideoBubble";
import { downloadMedia } from "../lib/downloadMedia";
import { lockedChatIdFromError } from "../services/chatUnlock";
import { canEditMessage } from "../utils/messageEditing";
import { useDebounce } from "../hooks/useDebounce";
import { useSocket } from "../contexts/useSocket";
import { useLongPress } from "../hooks/useLongPress";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import ReconnectBanner from "../components/Chat/ReconnectBanner";
import { toast } from "react-hot-toast";
import EmojiPicker from "emoji-picker-react";
import GifPicker from "../components/GifPicker";
import RichText from "../components/RichText";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const MESSAGE_RATE_LIMIT = 1000;
const MAX_MESSAGE_LENGTH = 10000;
/*
 * Matches multer's limit in server/config/multerConfig.js.
 *
 * It was 100MB here against 50MB there, so a 60MB video passed this check, uploaded
 * in full, and was then rejected — the failure arrived after the wait rather than
 * before it. GroupChatPage was corrected for this already; the DM composer, which is
 * the main path, was not.
 */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_MEDIA_PER_MESSAGE = 10; // matches the server's cap in config/socket.js
const MAX_RECORDING_MS = 120_000;

/*
 * What the media button accepts, mirroring the shape of the server's rule in
 * config/multerConfig.js — `image/` wholesale plus the specific video containers.
 *
 * `image/` rather than a list of formats is the point: the enumerated client list
 * this replaces had no `image/heic` or `image/heif`, so every photo from an iPhone
 * was rejected in the composer even though the server would have accepted it (#110).
 */
const COMPOSER_MEDIA_TYPES = [
  "image/",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
];

/*
 * The `accept` attribute. Distinct from the validator above because a file picker
 * needs concrete types, and iOS in particular will not offer HEIC photos unless the
 * attribute names them — `image/*` alone makes it silently transcode or omit them
 * depending on version.
 */
const COMPOSER_ACCEPT = [
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

/** Pure helpers — no component state, so they live out here. */

/** How many envelope samples a sent voice note carries. */
const WAVEFORM_BUCKETS = 64;

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
const downsampleWaveform = (samples, buckets = WAVEFORM_BUCKETS) => {
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
const formatClock = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
};

const formatInstagramTimestamp = (dateString) => {
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
const messagePreviewLabel = (message) => {
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
    case "file":
      return caption || "📎 File";
    case "post_share":
      return caption || "📷 Shared a post";
    default:
      return caption || "";
  }
};

/**
 * The text of a message, as it appears in its own bubble.
 *
 * Media, stickers and shared posts render their own visual content elsewhere in
 * the bubble, so the only thing this contributes for them is the caption — and
 * an empty string when there isn't one, rather than a placeholder label
 * duplicating what is already on screen.
 */
const getMessageBody = (message) => {
  if (message.isDeleted) {
    return (
      <span className="italic text-neutral-400">
        This message was deleted
      </span>
    );
  }
  return message.content || "";
};

/**
 * One message bubble.
 *
 * Module scope, and memoised. It used to be declared inside the page's render
 * body, which meant React saw a brand-new component *type* on every render and
 * threw away the entire message list rather than updating it. Typing a single
 * character rebuilt every bubble in the DOM — which is why a playing voice note
 * stopped dead the moment you touched the keyboard, and why a playing video
 * jumped back to zero.
 *
 * Everything it used to reach out of the closure for is a prop now.
 */
const MessageBubble = React.memo(function MessageBubble({
  message,
  isOwn,
  msgIndex = 0,
  groupLength = 1,
  isReacting,
  onAddReaction,
  onContextMenu,
  onJumpToMessage,
  onDismissReactions,
  onVote,
  onOpenMedia,
}) {
  const [hovered, setHovered] = useState(false);

  /*
   * Long press opens the menu on touch (#47).
   *
   * `onContextMenu` was the *only* way to reach reply, react, copy, unsend and
   * report — and iOS Safari doesn't reliably fire `contextmenu` on a long press over
   * selectable text, which a message bubble is. So on an iPhone those five actions
   * were unreachable. `useLongPress` uses pointer events, suppresses the OS callout
   * and the text-selection flash, and swallows the click that ends the press so the
   * bubble's own handlers don't also fire.
   */
  const longPress = useLongPress((event) => onContextMenu(message, event));

  const hasMedia = message.media?.length > 0;
  const hasContent = message.content?.trim();
  const isDeleted = message.isDeleted;

  const isEmojiOnly =
    !hasMedia &&
    !!hasContent &&
    !isDeleted &&
    message.content
      .replace(
        /\p{Extended_Pictographic}|\p{Emoji_Presentation}|️|‍|⃣|\s/gu,
        ""
      )
      .length === 0;

  // A shared post carries its own card chrome, so a bare share gets no bubble.
  const isShare = message.messageType === "post_share" && message.sharedContent;
  const isPoll = message.messageType === "poll" && message.poll;
  const isShareOnly = isShare && !hasContent && !isDeleted;

  // No bubble background: emoji-only or standalone media/gif (no text, no reply)
  const isMediaOnly = hasMedia && !hasContent && !message.replyTo && !isDeleted;
  const noBg = isEmojiOnly || isMediaOnly || isShareOnly;

  const isFirst = msgIndex === 0;
  const isLast = msgIndex === groupLength - 1;
  const isSingle = groupLength === 1;

  // Instagram-style corner radius: 18px base, 5px on "inner" side for grouped messages
  const getBubbleRadius = () => {
    if (noBg) return "";
    if (isSingle) return "rounded-[18px]";
    if (isOwn) {
      // tail = bottom-right
      if (isFirst && !isLast) return "rounded-[18px] rounded-br-[5px]";
      if (isLast && !isFirst) return "rounded-[18px] rounded-tr-[5px]";
      return "rounded-[18px] rounded-r-[5px]";
    } else {
      // tail = bottom-left
      if (isFirst && !isLast) return "rounded-[18px] rounded-bl-[5px]";
      if (isLast && !isFirst) return "rounded-[18px] rounded-tl-[5px]";
      return "rounded-[18px] rounded-l-[5px]";
    }
  };

  const getBubbleBg = () => {
    if (noBg) return "bg-transparent";
    if (!isOwn) return "bg-[#262626]";
    return ""; // own messages: bg applied via inline style below
  };

  // Viewport-fixed gradient so each bubble shows only its vertical slice —
  // top of screen = magenta/purple, bottom = bright blue, just like Instagram.
  const getBubbleStyle = () => {
    if (noBg || !isOwn) return {};
    return {
      background:
        "linear-gradient(to bottom, #C026D3, #A21CAF, #8B5CF6, #7C3AED, #5B21B6, #4F46E5, #2563EB, #1D4ED8, #C026D3, #A21CAF)",
      backgroundAttachment: "fixed",
    };
  };

  const getBubblePadding = () => {
    if (noBg) return "p-0";
    if (isMediaOnly) return "p-0 overflow-hidden";
    return "px-3 py-[9px]";
  };

  /*
   * Reactions come from `reactionSummary`, not from `reactions`.
   *
   * `Message.reactions` was a Map that the schema rewrite replaced with the
   * MessageReaction collection plus a cached top-three `reactionSummary` — so this
   * read a field that no longer exists on any payload, and *no reaction has ever
   * rendered*. The server has been maintaining the summary, broadcasting it on
   * every add and remove, and clearing it on unsend, with nothing on the client
   * looking at it.
   *
   * The summary is the top three by count. That is what the bubble should show
   * anyway — a row of pills has no room for more — and the total covers the rest.
   */
  const summaryTop = Array.isArray(message.reactionSummary?.top)
    ? message.reactionSummary.top
    : [];
  const reactionTotal = Number(message.reactionSummary?.total) || 0;
  const groupedReactions = summaryTop.reduce((acc, entry) => {
    if (entry?.emoji) acc[entry.emoji] = Number(entry.count) || 0;
    return acc;
  }, {});
  // How many reactions the three pills don't account for.
  const extraReactions = Math.max(
    0,
    reactionTotal - summaryTop.reduce((sum, entry) => sum + (Number(entry?.count) || 0), 0)
  );
  // Not on a tombstone: the pills outlived the message they belonged to, and
  // tapping one sent a reaction to something that no longer exists.
  const hasReactions = !isDeleted && Object.keys(groupedReactions).length > 0;

  return (
    <div
      id={`msg-${message._id}`}
      className={`${longPress.className} relative inline-flex flex-col w-fit max-w-full ${
        isOwn ? "items-end" : "items-start"
      }`}
      {...longPress.handlers}
      onContextMenu={(e) => {
        // The hook suppresses the OS callout mid-press; the app menu still opens on
        // a genuine right-click.
        longPress.handlers.onContextMenu?.(e);
        onContextMenu(message, e);
      }}
      onClick={(e) => longPress.consumeClick(e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      /*
       * Reachable from the keyboard too, which it never was: the timestamp is behind
       * `hovered` and the menu behind `contextmenu`, so a keyboard user could read
       * the thread and do nothing with it.
       */
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          onContextMenu(message, e);
        }
      }}
    >
      {/* Pinned badge */}
      {message.isPinned && (
        <div className="absolute -top-5 right-0 text-[11px] text-yellow-400 flex items-center gap-1 z-10">
          <Icons.pin className="w-3 h-3" />
          <span>Pinned</span>
        </div>
      )}

      {/* Forwarded label */}
      {message.isForwarded && (
        <div
          className={`text-[11px] text-neutral-500 mb-1 flex items-center gap-1 ${
            isOwn ? "justify-end" : "justify-start"
          }`}
        >
          <Icons.forward className="w-3 h-3" />
          <span>Forwarded</span>
        </div>
      )}

      {/*
        Instagram-style reaction picker.

        The backdrop is the fix: there was no way to close this without picking
        an emoji. No outside click, no Escape, no dismiss button — open it by
        mistake and you had to react to something.
      */}
      {isReacting && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => onDismissReactions?.()}
            onContextMenu={(e) => {
              e.preventDefault();
              onDismissReactions?.();
            }}
            aria-hidden="true"
          />
          <div
            role="menu"
            aria-label="React to message"
            className={`absolute ${
              isOwn ? "right-0" : "left-0"
            } -top-[54px] bg-[#1c1c1e] border border-white/10 rounded-full px-2 py-1.5 flex gap-0.5 shadow-2xl z-30`}
          >
            {["❤️", "😂", "😮", "😢", "😡", "👍"].map((emoji) => (
              <button
                key={emoji}
                onClick={() => onAddReaction(message._id, emoji)}
                aria-label={`React with ${emoji}`}
                className="w-9 h-9 text-[20px] flex items-center justify-center rounded-full hover:bg-white/10 hover:scale-125 transition-all duration-150"
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Main bubble */}
      <div
        className={`relative w-fit max-w-full text-white ${getBubbleRadius()} ${getBubbleBg()} ${getBubblePadding()} ${
          message.isPinned ? "ring-1 ring-yellow-400/60" : ""
        }`}
        style={getBubbleStyle()}
      >
        {/*
          Reply-to preview.

          The author line reads the populated `sender`, with `senderUsername`
          only as a fallback for the optimistic object the composer builds.
          `senderUsername` was the only thing it read before, and no server
          path has ever sent that field — so the name was permanently blank.

          Clicking jumps to the original, which simply wasn't implemented.
        */}
        {message.replyTo && !isDeleted && (
          <button
            type="button"
            onClick={() => onJumpToMessage?.(message.replyTo._id)}
            className={`block w-full text-left mb-2 px-2.5 py-[7px] rounded-xl transition-colors ${
              isOwn
                ? "bg-black/20 border-l-2 border-white/25 hover:bg-black/30"
                : "bg-white/10 border-l-2 border-white/20 hover:bg-white/15"
            }`}
          >
            <p className="text-[11px] font-semibold truncate opacity-70 mb-0.5">
              {message.replyTo.sender?.name ||
                message.replyTo.sender?.username ||
                message.replyTo.senderUsername ||
                "Unknown"}
            </p>
            <p className="text-[12px] truncate opacity-50">
              {message.replyTo.isDeleted
                ? "This message was deleted"
                : messagePreviewLabel(message.replyTo)}
            </p>
          </button>
        )}

        {/* Shared post / comment */}
        {isShare && !isDeleted && (
          <div className={hasContent ? "mb-2" : ""}>
            <SharedPostCard sharedContent={message.sharedContent} />
          </div>
        )}

        {/* Poll. Voting goes over the socket; the bubble reports the intent. */}
        {isPoll && !isDeleted && (
          <div className={hasContent ? "mb-2" : ""}>
            <PollBubble message={message} isOwn={isOwn} onVote={onVote} />
          </div>
        )}

        {/* Text */}
        {hasContent && !isDeleted && (
          <p
            className={`whitespace-pre-wrap break-words ${
              isEmojiOnly
                ? "text-[44px] leading-none py-1"
                : "text-[14.5px] leading-[1.45]"
            } ${hasMedia ? "mb-2" : ""}`}
          >
            {/* No mentionUsernames: in a DM every handle links. It's a
                shortcut to a profile, not a way to summon a stranger, so
                nothing is gated and nobody is notified. */}
            <RichText content={getMessageBody(message)} />
            {message.isEdited && (
              <span className="text-[11px] opacity-40 ml-1.5">edited</span>
            )}
          </p>
        )}

        {/* Deleted state */}
        {isDeleted && (
          <p className="text-[13.5px] italic text-white/40">
            This message was deleted
          </p>
        )}

        {/* Media */}
        {hasMedia && !isDeleted && (
          <div className="flex flex-col gap-1 w-fit max-w-full">
            {message.media.map((item, idx) => {
              const cornerClass =
                hasContent || message.replyTo ? "rounded-xl" : "rounded-[18px]";

              if (item.type === "image") {
                return (
                  /*
                   * The in-app lightbox, not `window.open` (#155).
                   *
                   * A new tab has none of the accessibility work the lightbox has — no
                   * dialog role, no Escape, no focus return — and on mobile it drops
                   * the user out of the app onto a bare Cloudinary URL with no way back
                   * but the browser's own controls. It also loses the conversation.
                   *
                   * A `<button>` rather than a clickable `<img>`, so it's reachable by
                   * keyboard and announced as something that can be activated.
                   */
                  <button
                    key={idx}
                    type="button"
                    onClick={() => onOpenMedia({ url: item.url, type: "image" })}
                    aria-label={item.caption ? `Open image: ${item.caption}` : "Open image"}
                    className="block w-fit"
                  >
                    <img
                      src={item.url}
                      // Decorative: the button carries the name, and `alt` on an image
                      // inside a labelled button is announced twice.
                      alt=""
                      /*
                       * Intrinsic dimensions when the server recorded them, so the
                       * bubble reserves its space before the bytes arrive. Without
                       * them the image has zero height at layout time, which is what
                       * defeated the at-bottom check and made the thread jump as
                       * pictures loaded (#105).
                       */
                      width={item.dimensions?.width || undefined}
                      height={item.dimensions?.height || undefined}
                      className={`block max-w-[260px] max-h-[340px] w-auto h-auto object-cover ${cornerClass}`}
                      loading="lazy"
                    />
                  </button>
                );
              }
              if (item.type === "gif") {
                return (
                  <img
                    key={idx}
                    src={item.url}
                    alt="GIF"
                    className={`block max-w-[260px] max-h-[260px] w-auto h-auto ${cornerClass}`}
                    loading="lazy"
                  />
                );
              }
              if (item.type === "video") {
                return <ChatVideoBubble key={idx} item={item} cornerClass={cornerClass} />;
              }
              /*
               * `voice` as well as `audio`.
               *
               * The recorder's optimistic preview hardcodes `type: "audio"`, but the
               * upload endpoint returns a descriptor with `type: "voice"` — see the
               * `descriptor` in chatController's voice handler — and `voice` is a
               * legitimate value in the Message media enum. So the clip rendered
               * while it was uploading and then vanished the instant the real
               * message replaced the preview: this branch didn't match, the map
               * returned null, and because a voice note has no text the bubble is
               * `noBg`/`bg-transparent` — not an empty grey bubble, nothing at all.
               * Reloading didn't help, since `voice` is what's persisted.
               */
              if (item.type === "audio" || item.type === "voice") {
                // Compute the same corner radii a text bubble would use
                let vRadius = "rounded-[18px]";
                if (!isSingle) {
                  if (isOwn) {
                    if (isFirst && !isLast) vRadius = "rounded-[18px] rounded-br-[5px]";
                    else if (isLast && !isFirst) vRadius = "rounded-[18px] rounded-tr-[5px]";
                    else vRadius = "rounded-[18px] rounded-r-[5px]";
                  } else {
                    if (isFirst && !isLast) vRadius = "rounded-[18px] rounded-bl-[5px]";
                    else if (isLast && !isFirst) vRadius = "rounded-[18px] rounded-tl-[5px]";
                    else vRadius = "rounded-[18px] rounded-l-[5px]";
                  }
                }
                return <VoiceNoteBubble key={idx} item={item} isOwn={isOwn} bubbleRadius={vRadius} />;
              }
              if (item.type === "document") {
                return (
                  <div
                    key={idx}
                    className="flex items-center gap-2.5 min-w-[190px] max-w-[260px] py-0.5"
                  >
                    <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
                      <Icons.file className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium truncate">
                        {item.filename}
                      </p>
                      <p className="text-[11px] text-white/40">
                        {(item.fileSize / 1024 / 1024).toFixed(1)} MB
                      </p>
                    </div>
                    {/*
                      A button that fetches, not an `<a download>`.
                      The attribute is honoured same-origin only, and these files
                      are on Cloudinary — so this control navigated to the document
                      rather than saving it, dropping the user out of the thread.
                    */}
                    <button
                      type="button"
                      onClick={() =>
                        downloadMedia(item).catch((error) => {
                          console.error("Failed to download document:", error);
                          toast.error("Couldn't download that");
                        })
                      }
                      aria-label={`Download ${item.filename || "file"}`}
                      className="opacity-50 hover:opacity-90 transition-opacity shrink-0"
                    >
                      <Icons.download className="w-4 h-4" />
                    </button>
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}

        {/* Upload overlay */}
        {message.isUploading && (
          <div className="absolute inset-0 bg-black/60 rounded-[inherit] flex items-center justify-center">
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-6 h-6 border-[2.5px] border-white border-t-transparent rounded-full animate-spin" />
              <span className="text-[11px] text-white font-medium">
                Sending
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Reactions — Instagram-style floating pills */}
      {hasReactions && (
        <div
          className={`flex gap-1 -mt-1.5 mb-0.5 ${
            isOwn ? "pr-2" : "pl-2"
          }`}
        >
          {Object.entries(groupedReactions).map(([emoji, count]) => (
            <button
              key={emoji}
              onClick={() => onAddReaction(message._id, emoji)}
              /*
               * Named. The button's only content was the emoji character, which a
               * screen reader announces by its Unicode name with no indication of
               * what pressing it does or how many people already have (#155).
               */
              aria-label={`React with ${emoji}${count > 1 ? `, ${count} so far` : ""}`}
              className="flex items-center gap-0.5 bg-[#1c1c1e] border border-white/15 rounded-full pl-1.5 pr-2 py-[3px] text-[13px] shadow-sm hover:border-white/35 active:scale-95 transition-all"
            >
              <span aria-hidden="true">{emoji}</span>
              {count > 1 && (
                <span className="text-[11px] text-white/60 ml-0.5" aria-hidden="true">
                  {count}
                </span>
              )}
            </button>
          ))}
          {/* The tail the top-three summary doesn't itemise. */}
          {extraReactions > 0 && (
            <span
              className="flex items-center bg-[#1c1c1e] border border-white/15 rounded-full px-2 py-[3px] text-[11px] text-white/60"
              aria-label={`and ${extraReactions} more reaction${extraReactions === 1 ? "" : "s"}`}
            >
              +{extraReactions}
            </span>
          )}
        </div>
      )}

      {/* Timestamp — revealed on hover */}
      <div
        className={`overflow-hidden transition-all duration-200 ease-in-out ${
          hovered ? "max-h-5 opacity-100" : "max-h-0 opacity-0"
        } px-0.5`}
      >
        <span className="text-[11px] text-neutral-500 leading-5">
          {formatInstagramTimestamp(message.createdAt)}
        </span>
      </div>
    </div>
  );
});

const UserConversationPage = () => {
  const { userAuth } = useContext(UserContext);
  const currentUserId = userAuth?._id || userAuth?.id;
  const { username } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const {
    messages,
    // The chat list, for the header's stand-in peer before the profile loads.
    conversations,
    threadLoading: messagesLoading,
    hasMoreMessages,
    onlineUsers,
    userLastSeenMap,
    typingUsers,
    peerReadAt,
    preferences,
    actions: {
      loadMessages,
      sendMessage: sendContextMessage,
      markConversationAsRead,
      checkUserStatus,
      reactToMessage,
      editMessage,
      unsendMessage,
      deleteMessageForMe,
      pinMessage,
      voteInPoll,
      setCurrentConversation,
      loadPreferences,
      hydrateThreadFromCache,
      deleteChat,
    },
  } = useChat();

  const [newMessage, setNewMessage] = useState("");
  const hasMore = hasMoreMessages;
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [isOnline, setIsOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState(null);
  const [loading, setLoading] = useState(true);
  /*
   * The chat lock, which the server enforces now.
   *
   * `lockedChatId` is set from the 423 the thread endpoint answers with; the
   * refusal carries the chatId, so the page doesn't have to know the conversation
   * is locked — or even who the peer is — before asking for it. That is what
   * makes a typed `/chat/<username>` hit the same wall as tapping a locked row.
   * `unlockAttempt` re-runs initChat once a grant has been stored.
   */
  const [lockedChatId, setLockedChatId] = useState(null);
  const [unlockAttempt, setUnlockAttempt] = useState(0);
  const { isConnected, connectionEpoch } = useSocket();
  /*
   * The same value in a ref, because initChat needs to read it and must not
   * depend on it: a state dependency would re-run the effect the moment a 423
   * set it, refetching only to be refused again.
   */
  const lastLockedChatIdRef = useRef(null);
  const [isSending, setIsSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const isUserTyping =
    selectedUser && typingUsers ? typingUsers[selectedUser._id] : false;
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [reactingTo, setReactingTo] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [isRestricted, setIsRestricted] = useState(false);
  const [blockedByThem, setBlockedByThem] = useState(false);
  const {
    isBlocked: isUserBlocked,
    requestBlock,
    unblock: unblockUser,
    syncBlocked,
  } = useBlock();
  const { openReport } = useReport();
  /*
   * The peer as BlockContext prefers to see them: the account id plus the handle,
   * falling back to the handle alone before the peer has loaded.
   *
   * The block index is keyed by id as well as handle, and the id is the half that
   * survives the peer renaming themselves — so every lookup and mutation on this page
   * goes through this rather than through the bare route param.
   */
  const peerIdentity = useMemo(
    () => (selectedUser?._id ? { _id: selectedUser._id, username } : username),
    [selectedUser?._id, username]
  );
  // Combined: you blocked them (context/server) OR they blocked you.
  const blocked = isUserBlocked(peerIdentity) || isBlocked || blockedByThem;
  const [pinnedMessages, setPinnedMessages] = useState([]);
  /*
   * Two separate things, which used to be one inverted flag called
   * `showPinned`. The bar rendered when `!showPinned`; its X set it to false —
   * the value it already had, so the close button did nothing — and "View all"
   * set it to true, which was the condition that *hid* the bar. Both controls
   * did the opposite of what they said.
   */
  const [pinnedBarDismissed, setPinnedBarDismissed] = useState(false);
  const [showAllPinned, setShowAllPinned] = useState(false);
  const [messageToForward, setMessageToForward] = useState(null);
  const [showForwardModal, setShowForwardModal] = useState(false);
  const [forwardContacts, setForwardContacts] = useState([]);
  const [selectedForwardContacts, setSelectedForwardContacts] = useState([]);
  const [selectedMediaFiles, setSelectedMediaFiles] = useState([]); // [{file, url, type}]
  /*
   * Confirmations, held as state instead of a blocking native dialog (#120).
   *
   * `pendingMessageAction` carries the message id because `selectedMessage` is
   * cleared when the context menu closes, which happens before the dialog is
   * answered.
   */
  const [pendingMessageAction, setPendingMessageAction] = useState(null);
  const [deleteChatOpen, setDeleteChatOpen] = useState(false);
  const [deletingChat, setDeletingChat] = useState(false);

  const [bigPreviewMedia, setBigPreviewMedia] = useState(null);
  /*
   * The lightbox element, for focus. Focus has to move *into* the dialog when it
   * opens and back to where it came from when it closes — otherwise a keyboard user
   * opens a preview and their focus is still on the bubble behind it.
   */
  const lightboxRef = useRef(null);
  const lightboxReturnFocusRef = useRef(null);

  useEffect(() => {
    if (bigPreviewMedia) {
      lightboxReturnFocusRef.current = document.activeElement;
      lightboxRef.current?.focus();
      return;
    }
    /*
     * Restored, but only if the element is still focusable.
     *
     * The context menu's phantom trigger has `pointerEvents: none` and may have
     * unmounted by now — focusing a detached or unfocusable node silently sends
     * focus to `<body>`, which is worse than leaving it alone.
     */
    const previous = lightboxReturnFocusRef.current;
    lightboxReturnFocusRef.current = null;
    if (previous && document.contains(previous) && typeof previous.focus === "function") {
      previous.focus();
    }
  }, [bigPreviewMedia]);
  const [uploadingPreview, setUploadingPreview] = useState(null);

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastMessageTime = useRef(0);
  const typingTimeoutRef = useRef(null);
  const hasFetchedData = useRef(false);
  const topSentinelRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  const isInitialLoadRef = useRef(true);
  const isLoadingMoreRef = useRef(false);
  const selectedUserRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [voicePreview, setVoicePreview] = useState(null); // { file, url, duration }
  const [isVoicePreviewPlaying, setIsVoicePreviewPlaying] = useState(false);
  const [liveWaveform, setLiveWaveform] = useState([]);
  /*
   * Normalised 0-1, because that is what the renderer expects
   * (`height: amp * 30px`). It used to be generated in an 18-83 range, which
   * rendered as bars up to 2,490 pixels tall — the fallback for a voice note
   * with no waveform data drew a column of white stripes down the page.
   */
  const [voiceStaticWaveform] = useState(() =>
    Array.from({ length: 32 }, (_, i) => 0.18 + Math.abs(Math.sin(i * 0.7 + 1)) * 0.65)
  );
  const recordingTimerRef = useRef(null);
  const recordingCancelledRef = useRef(false);
  const recordingTimeRef = useRef(0);
  const voicePreviewAudioRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const streamRef = useRef(null);
  const maxRecordingTimerRef = useRef(null);
  const isStartingRecordingRef = useRef(false);
  const lastWaveformPaintRef = useRef(0);
  /** The trailing window the live bar strip scrolls through. */
  const waveformHistoryRef = useRef([]);
  /** Every sample of the current recording, for the envelope that gets sent. */
  const fullWaveformRef = useRef([]);
  /** `Date.now()` at record start, for a sub-second duration. */
  const recordingStartedAtRef = useRef(0);
  /** How far into the voice preview playback we are, in seconds. */
  const [voicePreviewTime, setVoicePreviewTime] = useState(0);
  /** Per-DM disappearing TTL (seconds); loaded from chat preferences */
  const [conversationDisappearingSeconds, setConversationDisappearingSeconds] =
    useState(null);

  useEffect(() => {
    selectedUserRef.current = selectedUser;
  }, [selectedUser]);

  /*
   * Every object URL this page creates, so unmount can release them.
   *
   * This used to be a useCallback over `messages` and `selectedMediaFiles`,
   * consumed by `useEffect(() => () => cleanup(), [cleanup])`. That cleanup
   * runs whenever the callback's *identity* changes — which is on every
   * message and every attachment, not only on unmount. Picking a second image
   * revoked the first one's URL and its thumbnail went blank; so did any
   * message arriving while media was staged.
   *
   * A ref has a stable identity, so the effect below runs its cleanup exactly
   * once, when the page actually goes away.
   */
  const objectUrlsRef = useRef(new Set());

  const trackObjectUrl = useCallback((url) => {
    if (url?.startsWith("blob:")) objectUrlsRef.current.add(url);
    return url;
  }, []);

  const releaseObjectUrl = useCallback((url) => {
    if (!url?.startsWith("blob:")) return;
    objectUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const handleFetchError = useCallback(
    (error) => {
      console.error("Fetch error:", error.response || error);

      if (error.response?.status === 404) {
        toast.error("User not found");
        setTimeout(() => navigate("/chat"), 2000);
      } else if (error.response?.status === 403) {
        toast.error("You are blocked from messaging this user");
        setIsBlocked(true);
      } else if (error.response?.status === 401) {
        toast.error("Authentication error. Please login again");
        setTimeout(() => navigate("/login"), 2000);
      } else {
        toast.error("Failed to load conversation. Please try again.");
      }
    },
    [navigate]
  );

  // markMessageAsRead replaced by context action

  // markConversationAsRead replaced by context action

  // Initialization Effect
  useEffect(() => {
    const initChat = async () => {
      if (hasFetchedData.current || !username) return;
      hasFetchedData.current = true;

      setLoading(true);
      setBlockedByThem(false);
      setLockedChatId(null);

      /*
       * The thread and the header from the last snapshot, before anything is awaited.
       *
       * Everything below waits on `userAPI.getProfile`, which is deliberately
       * `bypassCache: true` — so a conversation could not show a single message
       * until a full round trip finished, on every open, including reopening the
       * chat you were just in. This runs alongside that request rather than
       * before it: nothing here is awaited, the provider declines if the network
       * has already filled the thread, and `loading` is released as soon as
       * something is on screen so the spinner stops hiding it.
       *
       * `peer` covers the header. `setSelectedUser` has exactly one other caller,
       * below, and it sits behind *two* serial round trips (`getProfile` then
       * `loadMessages`) — so the avatar and name arrived long after the messages did.
       * The cached peer carries the id, handle, name, avatar and verified flag, which
       * is everything the header draws.
       */
      hydrateThreadFromCache("dm", username)
        .then((cached) => {
          if (!cached) return;
          if (cached.painted) setLoading(false);
          /*
           * Seeded only when the cached peer *is* this route's peer, and only when we
           * don't already hold that same peer.
           *
           * This was `setSelectedUser((prev) => prev || cached.peer)`, and nothing
           * clears `selectedUser` when the `username` param changes — the page stays
           * mounted moving from one chat to the next. So `prev` was the *previous*
           * conversation's peer, the guard treated that as "already have one", and the
           * seed never ran on a switch: messages repainted from cache instantly while
           * the header kept the last person's name and avatar until `getProfile` and
           * `loadMessages` had both come back.
           *
           * Comparing ids rather than using `||` also keeps the richer profile when it
           * has already landed for this same peer — the cached peer carries no
           * `relationship` or `followerCount`, so overwriting would be a downgrade.
           */
          if (
            cached.peer?._id &&
            cached.peer.username?.toLowerCase() === username.toLowerCase()
          ) {
            setSelectedUser((prev) =>
              prev?._id === cached.peer._id ? prev : cached.peer
            );
          }
        })
        .catch(() => {});

      try {
        /*
         * The thread endpoint is the authority on who this is.
         *
         * The profile endpoint 404s both for someone who blocked you and for a
         * username that doesn't exist, and this page used to treat every 404 as
         * a block — so a typo in the URL produced a convincing fake: an account
         * called "Gossips User" that had apparently blocked you. `getMessages`
         * resolves the username itself and returns `peer` plus a real
         * `blockState`, and 404s only when the account genuinely isn't there
         * (which `handleFetchError` turns into "User not found").
         */
        let userData = null;
        try {
          /*
           * Uncached, deliberately (#119).
           *
           * `userAPI.getProfile` caches for 60 seconds, and this payload carries
           * `relationship.youRestricted` and `relationship.youBlocked` — state the
           * user can change from this very page. A cached copy would show the
           * restriction they just removed as still in place.
           */
          userData = await userAPI.getProfile(username, { bypassCache: true });
        } catch (profileErr) {
          if (profileErr.response?.status !== 404) throw profileErr;
          // Fall through — the thread response below decides.
        }

        /*
         * Set the active conversation *before* loading, because
         * SET_CURRENT_CONVERSATION clears the message list — that is how
         * switching chats avoids flashing the previous thread.
         */
        const conversationSetEarly = Boolean(userData?._id);
        if (conversationSetEarly) setCurrentConversation(userData._id);

        /*
         * Fetch messages via context (resolves by username server-side).
         *
         * The chatId goes along so an unlock grant can be attached. It comes from
         * the profile when that was readable, and otherwise from the 423 of the
         * previous attempt, which is exactly the retry case.
         */
        const chatIdForThread = userData?._id
          ? `user_${userData._id}`
          : lastLockedChatIdRef.current;
        const thread = await loadMessages(username, null, chatIdForThread);

        const peer = thread?.peer || userData;
        if (!peer) throw new Error("User not found");

        // Merge: the profile has the richer payload when it was readable, the
        // thread response has the authoritative identity and block state.
        userData = { ...(userData || {}), ...peer };

        // The blocked case: the profile 404'd, so the id arrives only now.
        // Keep the messages that were just loaded.
        if (!conversationSetEarly && userData._id) {
          setCurrentConversation(userData._id, { keepMessages: true });
        }

        setBlockedByThem(Boolean(thread?.blockState?.blockedByThem));
        setSelectedUser(userData);
        const youBlocked = Boolean(
          thread?.blockState?.youBlocked ?? userData.relationship?.youBlocked
        );
        setIsBlocked(youBlocked);
        /*
         * Tell BlockContext what the server just said.
         *
         * This is the one place the app learns `youBlocked` authoritatively for this
         * peer, and it used to land only in local state — so the banner here could
         * read "You blocked @x" from the server while the header menu two taps away
         * read "Block" from a stale context, and taking that offer failed. Pushing it
         * in reconciles every other surface from one fetch.
         */
        syncBlocked({ _id: userData._id, username }, youBlocked);
        /*
         * `relationship.youRestricted`, not `userData.restricted`.
         *
         * `User.restricted` moved to `UserRelation` — `User.js` documents the move —
         * so this array has not existed on the payload for a long time and
         * `isRestricted` was permanently false, so the menu item could never say
         * "Remove restriction" and the un-restrict endpoint 8b added had no caller.
         *
         * The semantics flip with it, and that mattered more than the read: the old
         * expression asked "did *they* restrict *me*", while every piece of
         * surrounding UI means "*I* restricted *them*". So the send guards and the
         * composer swap that keyed on it — "You cannot send messages to this user" —
         * were gating me out of my *own* composer for someone I had restricted. The
         * server allows that send: `restrict` is an outbound `UserRelation` edge and
         * no send path consults it, only `privacy.whoCanMessage` and blocks. Those
         * gates now key on `blocked` alone, and this flag drives the menu label,
         * which is the only thing it should ever have driven.
         */
        setIsRestricted(Boolean(userData.relationship?.youRestricted));
        setIsOnline(userData.isOnline || false);
        setLastSeen(userData.lastSeen || null);

        // Pinned / status / read receipts need the peer id
        if (userData._id) {
          try {
            // Through chatAPI rather than raw axios (CF29): the pinned endpoint
            // is lock-gated now, and the shared client is what attaches the
            // unlock grant — as well as refreshing an expired token on 401,
            // which the hand-rolled Authorization header never did.
            const pinnedResponse = await chatAPI.getPinnedMessages(userData._id);
            setPinnedMessages(pinnedResponse.pinnedMessages || []);
          } catch (pinnedError) {
            console.error("Error fetching pinned messages:", pinnedError);
          }
          checkUserStatus(userData._id);
          markConversationAsRead(userData._id, `user_${userData._id}`);
        }
      } catch (error) {
        /*
         * A locked conversation isn't an error to report — it's a prompt.
         * handleFetchError would toast and navigate away, which is the wrong
         * answer to "enter your PIN".
         */
        const locked = lockedChatIdFromError(error);
        if (locked) {
          lastLockedChatIdRef.current = locked;
          setLockedChatId(locked);
          hasFetchedData.current = false;
          return;
        }
        console.error("Error in initChat:", error);
        handleFetchError(error);
        hasFetchedData.current = false;
      } finally {
        setLoading(false);
      }
    };

    initChat();
  }, [
    username,
    userAuth.token,
    currentUserId,
    handleFetchError,
    markConversationAsRead,
    checkUserStatus,
    loadMessages,
    setCurrentConversation,
    hydrateThreadFromCache,
    syncBlocked,
    // Bumped by the PIN prompt once a grant exists, so the load retries.
    unlockAttempt,
  ]);

  // Open in-chat search when returning from conversation details (Search action)
  useEffect(() => {
    if (location.state?.openConversationSearch) {
      setShowSearch(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, navigate]);

  /*
   * The per-chat disappearing-message default, read from the provider (#96).
   *
   * This was a third independent fetch of the same account-wide preferences —
   * behind the same 60-second cache — so changing the timer on the details page and
   * coming straight back here sent messages with the *old* TTL until the cache
   * expired. Derived from the one store, it's correct the moment the details page
   * writes it.
   */
  useEffect(() => {
    if (!userAuth?.token) return;
    loadPreferences({ bypassCache: false });
  }, [userAuth?.token, loadPreferences]);

  useEffect(() => {
    if (!selectedUser?._id || !preferences.loaded) return;
    const key = `user_${selectedUser._id}`;
    const row = (preferences.disappearingByChat || []).find((x) => x.chatId === key);
    setConversationDisappearingSeconds(row?.seconds ?? null);
  }, [selectedUser?._id, preferences]);

  // Update isOnline and lastSeen from context
  useEffect(() => {
    if (selectedUser && onlineUsers.has(selectedUser._id)) {
      setIsOnline(true);
    } else if (selectedUser) {
      setIsOnline(false);
    }
  }, [selectedUser, onlineUsers]);

  /*
   * Mark the thread read.
   *
   * This used to run on every change to the message array — including your own
   * optimistic sends and every reaction — and regardless of whether the tab was
   * even visible, so a message arriving in a background tab was marked read
   * before anyone saw it. Each call was, server-side, a full conversation load
   * plus two writes per message.
   *
   * Now: only when the newest message is someone else's, and only while the tab
   * is actually in front of the user. Keyed on that message's id, so a reaction
   * or an echo doesn't re-fire it.
   */
  // The conversation key is "smaller:larger" of the two ids — the same shape
  // the server builds, so the watermark it sends back lines up.
  const conversationKey = useMemo(() => {
    const me = String(currentUserId || "");
    const them = String(selectedUser?._id || "");
    if (!me || !them) return null;
    return me < them ? `${me}:${them}` : `${them}:${me}`;
  }, [currentUserId, selectedUser?._id]);

  const peerReadAtDate = useMemo(() => {
    const raw = conversationKey ? peerReadAt?.[conversationKey] : null;
    return raw ? new Date(raw) : null;
  }, [peerReadAt, conversationKey]);

  const newestInboundId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const senderId = messages[i]?.sender?._id || messages[i]?.sender;
      if (String(senderId) !== String(currentUserId)) return messages[i]._id;
    }
    return null;
  }, [messages, currentUserId]);

  useEffect(() => {
    if (!newestInboundId || !selectedUser) return;

    const markIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      markConversationAsRead(selectedUser._id, `user_${selectedUser._id}`);
    };

    markIfVisible();
    document.addEventListener("visibilitychange", markIfVisible);
    return () => document.removeEventListener("visibilitychange", markIfVisible);
  }, [newestInboundId, selectedUser, markConversationAsRead]);

  // Unmount only — the ref's identity never changes, so this cleanup can't
  // fire while the user is still composing.
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  /*
   * Tear down anything still running when the page goes away.
   *
   * Nothing did this before, so navigating away mid-recording left the
   * getUserMedia stream open — the browser's recording indicator stayed lit —
   * while the one-second interval kept calling setRecordingTime on an unmounted
   * component and the animation frame kept looping forever.
   *
   * Empty dependency list on purpose: this runs once, on unmount, and reads
   * everything through refs so it can't capture a stale closure.
   */
  useEffect(
    () => () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (maxRecordingTimerRef.current) clearTimeout(maxRecordingTimerRef.current);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      // Don't leave the microphone on.
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (mediaRecorderRef.current?.state === "recording") {
        recordingCancelledRef.current = true;
        mediaRecorderRef.current.stop();
      }
    },
    []
  );

  // Add this useEffect to reset hasFetchedData when username changes
  useEffect(() => {
    hasFetchedData.current = false;
    isInitialLoadRef.current = true;

    return () => {
      hasFetchedData.current = false;
      isInitialLoadRef.current = true;
      setCurrentConversation(null);
    };
  }, [username, setCurrentConversation]);

  const loadMoreMessages = useCallback(async () => {
    /*
     * Guarded on a ref, not on the `loadingMore` state.
     *
     * The observer is torn down and rebuilt whenever this callback's identity
     * changes — which is on every message change — and re-observing a sentinel
     * that is already intersecting fires it immediately. Two callbacks in the
     * same tick both read `loadingMore === false`, both request the same
     * cursor, and the same page is prepended twice. State doesn't settle until
     * the next render; a ref does so synchronously.
     */
    if (isLoadingMoreRef.current) return;
    if (!hasMore || messagesLoading) return;
    isLoadingMoreRef.current = true;

    const container = messagesContainerRef.current;
    if (container) {
      scrollAnchorRef.current = {
        prevScrollHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
      };
    }

    setLoadingMore(true);
    try {
      const oldestMessage = messages[0];
      if (!oldestMessage) {
        scrollAnchorRef.current = null;
        return;
      }

      if (selectedUserRef.current) {
        const cursor = btoa(
          JSON.stringify({
            createdAt: oldestMessage.createdAt,
            _id: oldestMessage._id,
          })
        )
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "");
        // The chatId carries the unlock grant — page two of a locked
        // conversation is as gated as page one.
        await loadMessages(
          selectedUserRef.current.username,
          cursor,
          `user_${selectedUserRef.current._id}`
        );
      }
    } catch (error) {
      console.error("Error loading more messages:", error);
    } finally {
      isLoadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, messagesLoading, messages, loadMessages]);

  /*
   * `loading` is in the dependency list, and that's the point.
   *
   * The sentinel lives inside the message list, which isn't rendered while the
   * initial spinner is up. `hasMore` flips true on the same render — so this
   * effect ran, found no sentinel, and returned. Nothing in its old dependency
   * list changed when `loading` went false, so it never ran again and
   * pagination was simply dead until an unrelated re-render happened to
   * recreate `loadMoreMessages`.
   */
  useEffect(() => {
    if (loading || !topSentinelRef.current || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreMessages();
      },
      { root: messagesContainerRef.current, rootMargin: "200px", threshold: 0 }
    );

    observer.observe(topSentinelRef.current);
    return () => observer.disconnect();
  }, [loading, hasMore, loadMoreMessages]);

  // Socket initialization and event listeners removed - handled by ChatContext

  /*
   * Also gated on `loading`.
   *
   * initChat clears `loading` only after a further await, so there is a real
   * render where the messages have arrived but the list still shows the
   * spinner. This effect ran then, set scrollTop to the spinner's height,
   * and — being one-shot — cleared isInitialLoadRef. By the time the real list
   * mounted there was nothing left to trigger it, so every conversation opened
   * scrolled to the top of its history.
   *
   * useLayoutEffect rather than useEffect: the scroll is applied before the
   * browser paints, so restoring position after a prepend doesn't flash.
   */
  /*
   * The thread refetches on reconnect (#92).
   *
   * Messages that arrived while the socket was down produced no `receiveMessage`, so
   * the open conversation was missing exactly the messages sent during the outage and
   * nothing would have filled them in — the thread looked complete. Only the newest
   * page is refetched, which is what the gap is; older history is already loaded.
   *
   * `connectionEpoch > 1` skips the first connect, which initChat has already
   * covered.
   */
  const threadEpochRef = useRef(0);
  useEffect(() => {
    if (!isConnected || connectionEpoch <= 1) return;
    if (threadEpochRef.current === connectionEpoch) return;
    threadEpochRef.current = connectionEpoch;
    const peer = selectedUserRef.current;
    if (!peer?.username) return;
    loadMessages(peer.username, null, `user_${peer._id}`).catch((error) =>
      console.error("Reconnect refetch failed:", error)
    );
  }, [isConnected, connectionEpoch, loadMessages]);

  /*
   * Where the user was, recorded as they scroll rather than inferred afterwards.
   *
   * Starts true: a freshly opened conversation is pinned to the newest message, and
   * a message arriving before the first scroll event should follow it down.
   */
  const wasAtBottomRef = useRef(true);
  const AT_BOTTOM_SLACK_PX = 150;

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return undefined;

    const record = () => {
      wasAtBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        AT_BOTTOM_SLACK_PX;
    };
    record();
    container.addEventListener("scroll", record, { passive: true });
    return () => container.removeEventListener("scroll", record);
    // `loading` is in the deps because the container isn't mounted while the initial
    // spinner is up — the same reason the pagination observer needs it.
  }, [loading]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (loading || !container || messages.length === 0) return;

    // Restore scroll position after loading older messages
    if (scrollAnchorRef.current) {
      const { prevScrollHeight, prevScrollTop } = scrollAnchorRef.current;
      container.scrollTop = container.scrollHeight - prevScrollHeight + prevScrollTop;
      scrollAnchorRef.current = null;
      return;
    }

    // Instant scroll to bottom on initial load
    if (isInitialLoadRef.current) {
      container.scrollTop = container.scrollHeight;
      isInitialLoadRef.current = false;
      return;
    }

    /*
     * Auto-scroll on a new message, measured from *before* it arrived (#105).
     *
     * `container.scrollHeight` already includes the message that just rendered when
     * this effect runs, so the distance-from-bottom it produced was the old distance
     * plus the new message's height. A 340px image therefore read as "the user has
     * scrolled up 340px" and the thread stayed put — the taller the message, the more
     * likely it was to be missed, which is backwards.
     *
     * `wasAtBottomRef` is written by the scroll handler, so it reflects where the
     * user actually was before the render.
     */
    if (wasAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    // `loadingMore` is in the deps so this runs once per pagination attempt
    // even when the page deduplicated to nothing and `messages` kept its
    // identity — otherwise the anchor set before the fetch is never consumed,
    // and the *next* unrelated message change restores a scroll position
    // computed for a prepend that didn't happen.
  }, [messages, loading, loadingMore]);

  /*
   * No error toast here.
   *
   * Every action that sets the context's `error` already toasts — the
   * provider's socket handler does, and initChat's catch does — so reading it
   * again here fired a second, identical toast for one failure.
   */

  const { startTyping, stopTyping } = useChat().actions;

  const handleTyping = useCallback(
    (isTyping) => {
      if (selectedUserRef.current?._id) {
        if (isTyping) {
          startTyping(selectedUserRef.current._id);
        } else {
          stopTyping(selectedUserRef.current._id);
        }
      }
    },
    [startTyping, stopTyping]
  );

  /*
   * The composer's height follows its content.
   *
   * A textarea has a fixed `rows` and won't grow, so a multi-line message would
   * scroll a one-line box. Set from the scroll height and capped by the element's
   * own `max-h-32`, which is where the value 128 comes from.
   */
  const composerRef = useRef(null);

  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, []);

  // Also on programmatic changes — an emoji, a cleared send, entering edit mode —
  // which don't go through onChange.
  useEffect(() => {
    resizeComposer();
  }, [newMessage, resizeComposer]);

  const handleInputChange = (e) => {
    const value = e.target.value;

    if (editingMessage) {
      setNewMessage(value);
      return;
    }

    setNewMessage(value);

    if (value.trim() && !isTyping) {
      setIsTyping(true);
      handleTyping(true);
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      handleTyping(false);
    }, 1000);
  };

  const validateMessage = (media = []) => {
    if (
      !newMessage.trim() &&
      !fileInputRef.current?.files?.length &&
      media.length === 0
    ) {
      return "Message cannot be empty";
    }

    if (newMessage.length > MAX_MESSAGE_LENGTH) {
      return `Message too long (${MAX_MESSAGE_LENGTH} characters maximum)`;
    }

    const now = Date.now();
    if (now - lastMessageTime.current < MESSAGE_RATE_LIMIT) {
      return "Please wait a moment before sending another message";
    }

    return null;
  };

  const handleSendMedia = async () => {
    if (!selectedMediaFiles.length || !selectedUser?._id || isSending) return;
    if (blocked) {
      toast.error("You cannot send messages to this user");
      return;
    }

    // Capture files and show optimistic bubble immediately
    const filesToUpload = [...selectedMediaFiles];
    /*
     * Whatever is in the composer is the caption for this media, not a separate
     * message. It used to be sent as `content: ""` and left sitting in the box,
     * so the caption was dropped and then posted on its own the next time the
     * user hit send.
     */
    const caption = newMessage.trim();

    setUploadingPreview({
      _id: `uploading-${Date.now()}`,
      isOwn: true,
      isUploading: true,
      media: filesToUpload.map((f) => ({ type: f.type, url: f.url })),
      messageType: "media",
      createdAt: new Date().toISOString(),
      content: caption,
    });
    setSelectedMediaFiles([]);
    setIsSending(true);

    /*
     * Held outside the try so the catch can see what did upload.
     *
     * Uploads happen one at a time before the message is sent, so a failure on file
     * five of six leaves four already in Cloudinary with nothing pointing at them —
     * and since the selection is put back for a retry, pressing send again uploads
     * them a second time. Nothing ever deleted the first copies (CF28).
     */
    const uploadedItems = [];

    try {
      for (const item of filesToUpload) {
        const formData = new FormData();
        formData.append("file", item.file);
        // The server's descriptor verbatim, signature included. Rebuilding it
        // from local values used to be harmless; now the signature covers
        // {url, type, fileSize}, so a locally-guessed type or a File.size that
        // differs from what the server saw fails verification on send.
        uploadedItems.push(await chatAPI.uploadMedia(formData));
      }

      const tempId = `temp-${Date.now()}-${Math.random()}`;
      await sendContextMessage({
        tempId,
        senderId: currentUserId,
        receiverId: selectedUser._id,
        receiverUsername: username,
        senderUsername: userAuth.username,
        content: caption,
        media: uploadedItems,
        messageType: "media",
        replyTo: replyingTo
          ? {
              _id: replyingTo._id,
              content: replyingTo.content,
              media: replyingTo.media,
              senderUsername: replyingTo.senderUsername,
              senderId: replyingTo.sender?._id || replyingTo.sender,
              messageType: replyingTo.messageType,
            }
          : null,
        createdAt: new Date().toISOString(),
        isUploading: false,
      });

      // Only now are the local previews safe to release.
      filesToUpload.forEach((item) => releaseObjectUrl(item.url));
      setUploadingPreview(null);
      // Only clear what was actually sent. A multi-file upload takes seconds,
      // and anything typed in the meantime is a new message, not this caption.
      setNewMessage((current) => (current.trim() === caption ? "" : current));
      setReplyingTo(null);
      lastMessageTime.current = Date.now();
    } catch (error) {
      console.error("Error sending media:", error);
      setUploadingPreview(null);

      /*
       * Throw away whatever did upload, since the retry will upload it again.
       *
       * Best effort and deliberately not awaited in a way that can fail the handler
       * — the user's message already didn't send, and a failed cleanup must not turn
       * into a second error for them to read. The server verifies each item's
       * signature, so this can only discard uploads this session produced.
       */
      if (uploadedItems.length) {
        chatAPI
          .discardChatMedia(uploadedItems)
          .catch((discardError) =>
            console.error("Couldn't discard orphaned uploads:", discardError)
          );
      }

      /*
       * Put the selection back rather than revoking it.
       *
       * The blob URLs used to be revoked here, which made the user's pick
       * unrecoverable: the files were already cleared from the composer, so a
       * failure on the last of six left nothing on screen and nothing to retry
       * with. Keeping the objects alive means Retry is just pressing send
       * again. The composer text was never cleared, so the caption is still
       * there too.
       */
      setSelectedMediaFiles((current) => {
        // Merged, not "restore only if empty": the user may have attached
        // something else while the upload was in flight, and dropping the
        // originals on the floor would leak their blob URLs until unmount.
        const seen = new Set(current.map((item) => item.url));
        const merged = [
          ...filesToUpload.filter((item) => !seen.has(item.url)),
          ...current,
        ];
        merged
          .slice(MAX_MEDIA_PER_MESSAGE)
          .forEach((item) => releaseObjectUrl(item.url));
        return merged.slice(0, MAX_MEDIA_PER_MESSAGE);
      });
      toast.error(
        error?.response?.data?.error ||
          "Couldn't send that media — your files are still attached."
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleSendButtonClick = () => {
    if (isSending) return;
    if (selectedMediaFiles.length > 0 && !editingMessage) {
      handleSendMedia();
      return;
    }
    sendMessage();
  };

  // Enhanced send message with different message types
  const sendMessage = async (media = [], messageType = "text") => {
    if (editingMessage) {
      await handleEditMessage();
      return;
    }

    const validationError = validateMessage(media);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    if (blocked) {
      toast.error("You cannot send messages to this user");
      return;
    }

    if (!selectedUser || !selectedUser._id) {
      toast.error("User not found");
      console.error("Selected user is invalid:", selectedUser);
      return;
    }

    setIsSending(true);
    const tempId = `temp-${Date.now()}-${Math.random()}`;

    const messageData = {
      tempId,
      senderId: currentUserId,
      receiverId: selectedUser._id,
      receiverUsername: username,
      senderUsername: userAuth.username,
      content: newMessage.trim(),
      media,
      messageType,
      replyTo: replyingTo
        ? {
            _id: replyingTo._id,
            content: replyingTo.content,
            media: replyingTo.media,
            senderUsername: replyingTo.senderUsername,
            senderId: replyingTo.sender?._id || replyingTo.sender,
            messageType: replyingTo.messageType,
          }
        : null,
      isUploading: messageType !== "gif" && !!media.length,
    };

    const ttl = conversationDisappearingSeconds;
    if (ttl != null && ttl > 0) {
      messageData.isEphemeral = true;
      messageData.selfDestructTimer = ttl;
    }

    try {
      await sendContextMessage(messageData);

      setNewMessage("");
      setShowEmojiPicker(false);
      setShowGifPicker(false);
      setReplyingTo(null);
      lastMessageTime.current = Date.now();

      setIsTyping(false);
      handleTyping(false);
    } catch (error) {
      console.error("Error sending message:", error);
      /*
       * The server's own wording, not a generic string.
       *
       * The send is acknowledged now, so a refusal arrives here with the reason —
       * "They don't accept messages from you", "You're muted in this group" — and
       * replacing it with "Failed to send message" threw away the only part the
       * user could act on. The composer text is untouched: it is cleared inside the
       * try, above, so a rejected send keeps what was typed.
       */
      toast.error(error?.message || "Failed to send message");
    } finally {
      setIsSending(false);
    }
  };

  const handleEditMessage = async () => {
    if (!editingMessage || !newMessage.trim()) {
      toast.error("Message cannot be empty");
      return;
    }

    try {
      await editMessage(editingMessage._id, newMessage.trim());

      // Only on success — the provider used to resolve even when the edit was
      // rejected, so this cleared the composer and threw the text away.
      setNewMessage("");
      setEditingMessage(null);
    } catch (error) {
      console.error("Error editing message:", error);
      toast.error(
        error?.response?.data?.error ||
          "Couldn't save that edit — your text is still here."
      );
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSending) {
        handleSendButtonClick();
      }
    } else if (e.key === "Escape") {
      if (editingMessage) {
        setEditingMessage(null);
        setNewMessage("");
      }
      if (replyingTo) {
        setReplyingTo(null);
      }
      setShowEmojiPicker(false);
      setShowGifPicker(false);
    }
  };

  const handleEmojiClick = (emojiObject) => {
    if (newMessage.length + emojiObject.emoji.length <= MAX_MESSAGE_LENGTH) {
      setNewMessage((prev) => prev + emojiObject.emoji);
    }
  };

  /** Shape from the shared GifPicker: { url, width, height }. */
  const handleGifSelect = (gif) => {
    if (blocked) {
      toast.error("You cannot send messages to this user");
      return;
    }
    sendMessage([{ type: "gif", url: gif.url, thumbnail: gif.url }], "gif");
    setShowGifPicker(false);
  };

  const validateFile = (file) => {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File size too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`
      );
    }

    /*
     * Prefix-matched on `image/`, which is what the server does (#110).
     *
     * The hand-written list was a third copy of the upload rules and narrower than
     * both the others: `multerConfig.MEDIA_TYPES` allows `image/` wholesale, so the
     * server has always accepted `image/heic` and `image/heif` — and this list
     * didn't, which meant **every photo taken on an iPhone was rejected in the
     * composer** before it ever reached an endpoint that would have taken it.
     *
     * Matching the shape of the server's rule rather than enumerating types is also
     * what stops the two drifting again the next time an image format appears.
     */
    if (!COMPOSER_MEDIA_TYPES.some((prefix) => file.type.startsWith(prefix))) {
      throw new Error("Only images and videos can be attached here");
    }
  };

  const handleMediaSelect = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    /*
     * One toast for the whole selection, not one per file (#110).
     *
     * Picking twenty photos on a phone and having one rule reject them produced
     * twenty stacked toasts, which buries the screen and says the same thing twenty
     * times. Rejections are collected and summarised: the reason once, and how many
     * files it applied to.
     */
    const newItems = [];
    const rejections = new Map();
    for (const file of files) {
      try {
        validateFile(file);
        const url = trackObjectUrl(URL.createObjectURL(file));
        const type = file.type.startsWith("image/") ? "image" : "video";
        newItems.push({ file, url, type });
      } catch (error) {
        rejections.set(error.message, (rejections.get(error.message) || 0) + 1);
      }
    }
    for (const [reason, count] of rejections) {
      toast.error(count > 1 ? `${count} files skipped — ${reason}` : reason);
    }

    if (newItems.length) {
      // Capped here, not just server-side: handleSendMedia uploads every
      // selection to Cloudinary before it emits, so an over-limit batch would
      // finish all its uploads and then be refused as a whole.
      setSelectedMediaFiles((prev) => {
        const merged = [...prev, ...newItems];
        if (merged.length > MAX_MEDIA_PER_MESSAGE) {
          toast.error(`Up to ${MAX_MEDIA_PER_MESSAGE} attachments per message`);
          merged.slice(MAX_MEDIA_PER_MESSAGE).forEach((item) => releaseObjectUrl(item.url));
          return merged.slice(0, MAX_MEDIA_PER_MESSAGE);
        }
        return merged;
      });
    }
    e.target.value = "";
  };


  // ── Voice recording ──────────────────────────────────────────────────────
  const stopWaveformAnalysis = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      analyserRef.current = null;
    }
  };

  const startRecording = async () => {
    /*
     * Guarded synchronously, before the await.
     *
     * The button had onMouseDown *and* onTouchStart, and a touch produces both:
     * touchstart, then a synthetic mousedown. Since setIsRecording only happens
     * after getUserMedia resolves, both calls got past a state check — two mic
     * streams, two AudioContexts, two MediaRecorders and two intervals, with
     * the first of each leaked and ticking forever.
     */
    if (isStartingRecordingRef.current) return;
    if (mediaRecorderRef.current?.state === "recording") return;
    isStartingRecordingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // ── Real-time waveform via Web Audio API ──
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      analyserRef.current.smoothingTimeConstant = 0.5;
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      const freqData = new Uint8Array(analyserRef.current.frequencyBinCount);
      waveformHistoryRef.current = [];
      fullWaveformRef.current = [];

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(freqData);
        // RMS energy across voice-range frequency bins (roughly 0–3 kHz)
        const voiceBins = Math.min(freqData.length, 48);
        let sum = 0;
        for (let i = 0; i < voiceBins; i++) sum += freqData[i] * freqData[i];
        const rms = Math.sqrt(sum / voiceBins) / 255; // 0..1
        // Amplify quiet signals; add small idle jitter so bars breathe in silence
        const amp = rms < 0.02
          ? 0.02 + Math.random() * 0.04
          : Math.min(1, rms * 4);
        waveformHistoryRef.current = [...waveformHistoryRef.current, amp].slice(-52);
        /*
         * The whole recording, kept separately from the scrolling display window.
         *
         * `waveformHistoryRef` is `.slice(-52)` because the live bar strip is meant to
         * scroll — but that is also what was being sent as the "recorded waveform",
         * so a 30-second note shipped its final 0.9 seconds stretched across the
         * bubble. This one never drops a sample; it is averaged down to a fixed number
         * of buckets at stop, so the bubble draws the envelope of the whole clip.
         *
         * A push per frame: ~60/s, so 7,200 floats at the 120s cap. Negligible, and
         * it avoids the per-frame array copy the display window pays for.
         */
        fullWaveformRef.current.push(amp);

        /*
         * Throttled to ~15fps.
         *
         * This used to setState on every animation frame — sixty re-renders a
         * second of the whole page component. Combined with the message list
         * being rebuilt on each one, recording a voice note was the single most
         * expensive thing the app did. The history ref keeps every sample; only
         * the render is throttled.
         */
        const now = performance.now();
        if (now - lastWaveformPaintRef.current > 66) {
          lastWaveformPaintRef.current = now;
          setLiveWaveform([...waveformHistoryRef.current]);
        }

        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);

      // ── MediaRecorder ──
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recordingCancelledRef.current = false;

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingCancelledRef.current) {
          recordingCancelledRef.current = false;
          return;
        }
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const audioUrl = trackObjectUrl(URL.createObjectURL(audioBlob));
        const ext = mimeType === "audio/webm" ? "webm" : "mp4";
        /*
         * Wall-clock elapsed, not the whole seconds the display counter ticked.
         *
         * The counter is a `setInterval(…, 1000)` that starts at 0, so it reads 0 for
         * anything under a second and truncates everything else — a 4.9s note was
         * recorded as "4". The clip's real length is the only number that can line the
         * playback progress up with the bar strip, so it is measured properly here and
         * the counter stays what it is: a display.
         */
        const elapsed = recordingStartedAtRef.current
          ? Math.max(0.1, (Date.now() - recordingStartedAtRef.current) / 1000)
          : recordingTimeRef.current;

        setVoicePreview({
          file: new File([audioBlob], `voice-message.${ext}`, { type: mimeType }),
          url: audioUrl,
          duration: elapsed,
          // The whole envelope, averaged into fixed buckets — not the trailing
          // window the live strip scrolls through.
          waveformSnapshot: downsampleWaveform(fullWaveformRef.current),
        });
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimeRef.current = 0;
      recordingStartedAtRef.current = Date.now();

      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => {
          recordingTimeRef.current = prev + 1;
          return prev + 1;
        });
      }, 1000);

      // Held in a ref so stopRecording can clear it. Left dangling, a timer
      // from an earlier recording would fire mid-way through a later one and
      // cut it short.
      maxRecordingTimerRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") stopRecording();
      }, MAX_RECORDING_MS);
    } catch (error) {
      console.error("Error starting recording:", error);
      // The stream and the waveform loop both start before MediaRecorder is
      // constructed, and constructing it can throw — an unsupported mimeType on
      // Safari, for one. Without this the microphone stays open with the
      // browser indicator lit and the rAF loop keeps painting forever.
      stopWaveformAnalysis();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      toast.error("Microphone access is required for voice messages");
    } finally {
      isStartingRecordingRef.current = false;
    }
  };

  const stopRecording = () => {
    stopWaveformAnalysis();
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (maxRecordingTimerRef.current) {
      clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    } else if (streamRef.current) {
      // The recorder's onstop releases the tracks, but it only fires if the
      // recorder was actually running. Otherwise the mic stays open and the
      // browser keeps showing the recording indicator.
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
    setIsRecording(false);
  };

  const cancelRecording = () => {
    recordingCancelledRef.current = true;
    stopWaveformAnalysis();
    stopRecording();
    setLiveWaveform([]);
    setRecordingTime(0);
  };

  /*
   * 0..1 through the preview clip.
   *
   * Divided by the recorder's own measured duration rather than the audio element's:
   * `HTMLAudioElement.duration` is `Infinity` for MediaRecorder webm until the whole
   * blob has been walked, which would make the progress zero for the entire clip.
   */
  const voicePreviewProgress =
    voicePreview?.duration > 0
      ? Math.min(1, voicePreviewTime / voicePreview.duration)
      : 0;

  const cancelVoicePreview = () => {
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current.src = "";
      voicePreviewAudioRef.current = null;
    }
    if (voicePreview?.url) releaseObjectUrl(voicePreview.url);
    setVoicePreview(null);
    setIsVoicePreviewPlaying(false);
    setVoicePreviewTime(0);
    setRecordingTime(0);
  };

  /*
   * Playing the preview drives the bars and the clock.
   *
   * The only listener attached here was `onended`, so pressing play changed exactly
   * one thing — the play/pause glyph. Nothing read `currentTime`, so no render
   * happened while the clip played: the bars kept a constant colour and the label
   * kept showing the total length. `ontimeupdate` is the same mechanism the sent
   * bubble already uses (VoiceNoteBubble), so the preview and the bubble now behave
   * identically, which is the point of a preview.
   */
  const toggleVoicePreviewPlay = () => {
    if (!voicePreview) return;
    if (!voicePreviewAudioRef.current) {
      const audio = new Audio(voicePreview.url);
      audio.ontimeupdate = () => setVoicePreviewTime(audio.currentTime || 0);
      audio.onended = () => {
        setIsVoicePreviewPlaying(false);
        // Back to the start, so the bars reset and a second press replays rather
        // than sitting at the end doing nothing.
        setVoicePreviewTime(0);
        audio.currentTime = 0;
      };
      voicePreviewAudioRef.current = audio;
    }
    if (isVoicePreviewPlaying) {
      voicePreviewAudioRef.current.pause();
      setIsVoicePreviewPlaying(false);
    } else {
      voicePreviewAudioRef.current.play().catch(console.error);
      setIsVoicePreviewPlaying(true);
    }
  };

  const sendVoiceNote = async () => {
    if (!voicePreview || isSending) return;
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current.src = "";
      voicePreviewAudioRef.current = null;
    }
    setIsVoicePreviewPlaying(false);

    const { file, duration, url: blobUrl, waveformSnapshot } = voicePreview;
    const tempId = `temp-${Date.now()}-${Math.random()}`;

    setUploadingPreview({
      _id: tempId,
      tempId,
      isOwn: true,
      isUploading: true,
      messageType: "voice",
      // `waveform` too: without it the in-flight bubble drew the synthetic sine
      // strip, so the envelope visibly changed at the moment of sending even when
      // everything else worked.
      media: [{ type: "audio", url: blobUrl, duration, waveform: waveformSnapshot }],
      createdAt: new Date().toISOString(),
    });

    setVoicePreview(null);
    setVoicePreviewTime(0);
    setRecordingTime(0);

    try {
      setIsSending(true);
      const formData = new FormData();
      formData.append("audio", file);
      /*
       * The real amplitude envelope, captured by the AnalyserNode while
       * recording. The server used to generate this with Math.random() and
       * ship it as though it described the audio; the browser is the only
       * place that has the actual samples without decoding the file again.
       * Downsampled to keep the field small — it's a decorative strip a couple
       * of hundred pixels wide, not data anyone reads precisely.
       */
      const points = Array.isArray(waveformSnapshot) ? waveformSnapshot : [];
      formData.append("waveform", JSON.stringify(points));

      /*
       * The measured length, which was not being sent at all.
       *
       * The server fell back to Cloudinary's `result.duration`, and that is empty for
       * MediaRecorder webm — it writes no container duration — so notes were stored
       * claiming 0:00. The browser is the only party that actually timed the
       * recording; the server clamps what it receives.
       */
      formData.append("duration", String(duration));

      const response = { data: await chatAPI.uploadVoice(formData) };

      await sendContextMessage({
        senderId: currentUserId,
        receiverId: selectedUser._id,
        receiverUsername: username,
        content: "",
        media: [response.data],
        messageType: "voice",
        replyTo: replyingTo
          ? {
              _id: replyingTo._id,
              content: replyingTo.content,
              media: replyingTo.media,
              senderUsername: replyingTo.senderUsername,
              senderId: replyingTo.sender,
              messageType: replyingTo.messageType,
            }
          : null,
        createdAt: new Date().toISOString(),
        tempId,
      });

      setReplyingTo(null);
    } catch (error) {
      console.error("Error uploading voice note:", error);
      toast.error("Failed to send voice message. Please try again.");
    } finally {
      setIsSending(false);
      setUploadingPreview(null);
      releaseObjectUrl(blobUrl);
    }
  };

  // useCallback because this is handed to the memoised MessageBubble; a fresh
  // identity each render would defeat the memo entirely.
  const handleMessageContextMenu = useCallback((message, event) => {
    event.preventDefault?.();
    event.stopPropagation?.();

    setSelectedMessage(message);
    /*
     * `event.touches` is gone: it never had anything in it.
     *
     * This read `event.touches?.[0]` from a `contextmenu` event, which has no
     * `touches` list at all — so on touch the coordinates were 0,0 and the menu
     * opened in the top-left corner. Everything that reaches here now is a pointer
     * event or a keyboard event; a keyboard event has no coordinates, so the
     * bubble's own position is the anchor.
     */
    const rect = event.currentTarget?.getBoundingClientRect?.();
    const x = Number.isFinite(event.clientX) && event.clientX ? event.clientX : rect?.left ?? 0;
    const y = Number.isFinite(event.clientY) && event.clientY ? event.clientY : rect?.bottom ?? 0;
    setContextMenu({ x, y });
  }, []);

  const closeContextMenu = () => {
    setContextMenu(null);
    setSelectedMessage(null);
  };

  const handleContextMenuAction = async (action) => {
    if (!selectedMessage) return;

    switch (action) {
      case "edit":
        if (selectedMessage.content && selectedMessage.isOwn) {
          setEditingMessage(selectedMessage);
          setNewMessage(selectedMessage.content);
        }
        break;
      /*
       * ConfirmDialog, not window.confirm (#120).
       *
       * A native confirm blocks the whole tab, can't be styled, and — the part that
       * matters for a destructive action — can be suppressed by the browser after a
       * few in a row, at which point unsend either always fires or never does. The
       * message id is captured now because `selectedMessage` is cleared when the
       * menu closes, which happens before the dialog is answered.
       */
      case "unsend":
        setPendingMessageAction({ kind: "unsend", messageId: selectedMessage._id });
        break;
      case "delete":
        setPendingMessageAction({ kind: "delete", messageId: selectedMessage._id });
        break;
      case "reply":
        setReplyingTo(selectedMessage);
        break;
      case "copy":
        if (selectedMessage.content) {
          await navigator.clipboard.writeText(selectedMessage.content);
          toast.success("Copied to clipboard");
        }
        break;
      case "forward":
        setMessageToForward(selectedMessage);
        setShowForwardModal(true);
        fetchForwardContacts();
        break;
      case "react":
        setReactingTo(selectedMessage._id);
        break;
      /*
       * Saves in place, without navigating.
       *
       * `downloadMedia` fetches to a blob first because the `download` attribute is
       * ignored cross-origin, and chat media is on Cloudinary — the document
       * bubble's plain `<a download>` has always navigated to the file instead of
       * saving it, which on mobile means leaving the thread. Awaited so a failure
       * can be reported rather than silently doing nothing.
       */
      case "download":
        try {
          await Promise.all(
            (selectedMessage.media || []).map((item) => downloadMedia(item))
          );
        } catch (error) {
          console.error("Failed to download media:", error);
          toast.error("Couldn't download that");
        }
        break;
      case "pin":
        await handlePinMessage(selectedMessage._id, selectedMessage.isPinned);
        break;
      case "report":
        handleReportMessage(selectedMessage);
        break;
      default:
        break;
    }

    closeContextMenu();
  };

  const handleUnsendMessage = async (messageId) => {
    // renamed from unsendMessage to avoid name conflict with action
    try {
      await unsendMessage(messageId);
    } catch (error) {
      console.error("Error unsending message:", error);
      toast.error("Failed to unsend message");
    }
  };

  const handleDeleteMessageForMe = async (messageId) => {
    // renamed from deleteMessageForMe to avoid name conflict
    try {
      await deleteMessageForMe(messageId);
    } catch (error) {
      console.error("Error deleting message:", error);
      toast.error("Failed to delete message");
    }
  };

  const handlePinMessage = async (messageId, currentlyPinned) => {
    // renamed from pinMessage to avoid name conflict
    try {
      // The target state, so a double-click doesn't pin and immediately unpin.
      await pinMessage(messageId, !currentlyPinned);
      fetchPinnedMessages();
    } catch (error) {
      console.error("Error pinning message:", error);
      toast.error(error?.response?.data?.error || "Failed to pin message");
    }
  };

  const fetchPinnedMessages = async () => {
    try {
      const response = await chatAPI.getPinnedMessages(selectedUser._id);
      setPinnedMessages(response.pinnedMessages || []);
    } catch (error) {
      console.error("Error fetching pinned messages:", error);
    }
  };

  /*
   * The forward picker's contact list.
   *
   * Paged explicitly, because `GET /chats` is cursored now (CF23/CF24) and a bare call
   * returns one page of 30 — this used to receive up to 500 conversations in one response
   * and the picker is a flat list with no search, so silently dropping to 30 would make
   * older contacts unforwardable. Five pages of 100 keeps the same ceiling it had.
   *
   * Bounded rather than "until exhausted": an unsearchable list of 500 checkboxes is
   * already past useful, and an unbounded loop on a heavy account would fetch for a while
   * to build a list nobody can scan.
   */
  const fetchForwardContacts = async () => {
    try {
      const contacts = [];
      let cursor = null;
      for (let page = 0; page < 5; page += 1) {
        const response = await chatAPI.getConversations({
          limit: 100,
          archived: "false",
          ...(cursor ? { cursor } : {}),
        });
        // Groups have no `user`, and a forward target here is a person.
        contacts.push(...(response.chats || []).map((chat) => chat.user).filter(Boolean));
        cursor = response.pageInfo?.hasNextPage ? response.pageInfo.nextCursor : null;
        if (!cursor) break;
      }
      setForwardContacts(contacts);
    } catch (error) {
      console.error("Error fetching forward contacts:", error);
    }
  };

  const handleForwardMessage = async () => {
    if (!messageToForward || selectedForwardContacts.length === 0) return;

    try {
      await chatAPI.forwardMessage(messageToForward._id, {
        receiverIds: selectedForwardContacts.map((contact) => contact._id),
      });

      toast.success(`Forwarded to ${selectedForwardContacts.length} contact(s)`);
      setShowForwardModal(false);
      setMessageToForward(null);
      setSelectedForwardContacts([]);
    } catch (error) {
      console.error("Error forwarding message:", error);
      toast.error("Failed to forward message");
    }
  };

  /*
   * Scroll to the message a reply points at.
   *
   * The bubble has carried `id="msg-<id>"` all along and nothing ever used it —
   * the reply preview had no onClick at all. If the original is older than the
   * pages loaded so far it isn't in the DOM, and saying so is better than
   * doing nothing.
   */
  const jumpToMessage = useCallback((messageId) => {
    if (!messageId) return;
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) {
      toast("That message isn't loaded yet — scroll up to find it.");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-white/50");
    window.setTimeout(() => el.classList.remove("ring-2", "ring-white/50"), 1500);
  }, []);

  const dismissReactions = useCallback(() => setReactingTo(null), []);

  const handleVote = useCallback(
    (messageId, optionIds) => {
      try {
        voteInPoll(messageId, optionIds);
      } catch (error) {
        console.error("Error voting in poll:", error);
        toast.error("Couldn't record your vote — check your connection.");
      }
    },
    [voteInPoll]
  );

  /*
   * Escape closes the reaction picker.
   *
   * The composer's own onKeyDown handles Escape, but it only fires while the
   * input is focused — and the picker is opened by long-press or right-click
   * on a bubble, which takes focus away from it. So the one key everybody
   * reaches for did nothing.
   */
  useEffect(() => {
    if (!reactingTo) return;
    const onKey = (e) => {
      if (e.key === "Escape") setReactingTo(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [reactingTo]);

  const handleAddReaction = useCallback(
    async (messageId, emoji) => {
      try {
        await reactToMessage(messageId, emoji);
      } catch (error) {
        console.error("Error adding reaction:", error);
        toast.error(error?.response?.data?.error || "Couldn't add that reaction.");
      } finally {
        // Closes either way: leaving the picker open on a failure was the only
        // state in which it couldn't be dismissed at all.
        setReactingTo(null);
      }
    },
    [reactToMessage]
  );

  /*
   * In-chat search: debounced, and the answer to a stale query is discarded (#104).
   *
   * It used to be called straight from `onChange`, which searched the previous
   * render's query — the callback closes over `searchQuery` before setState has
   * applied — so the results were always one keystroke behind. And every character
   * fired its own request with nothing cancelling the earlier ones, so the results
   * on screen were whichever response happened to land last rather than the one for
   * what had been typed.
   *
   * The debounce collapses a burst of typing to one request; the `cancelled` flag is
   * what makes the race impossible rather than merely unlikely — a slow response for
   * "ab" can still arrive after a fast one for "abc", and without this it would
   * overwrite it.
   */
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  useEffect(() => {
    const query = debouncedSearchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return undefined;
    }

    let cancelled = false;
    // Through chatAPI: searching a locked conversation is a read of it, so the
    // request needs the unlock grant the shared client attaches.
    chatAPI
      .searchMessages(
        username,
        query,
        selectedUser?._id ? `user_${selectedUser._id}` : undefined,
        { limit: 50 }
      )
      .then((response) => {
        if (!cancelled) setSearchResults(response.messages || []);
      })
      .catch((error) => {
        if (!cancelled) console.error("Error searching messages:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedSearchQuery, username, selectedUser?._id]);

  /**
   * Restrict, and un-restrict.
   *
   * It was one-way and always claimed success: no unrestrict endpoint existed, the
   * menu item became `disabled` once used, and the toast fired regardless of the
   * result. `POST /user/unrestrict/:username` landed in 8b and
   * `userAPI.unrestrict` exists — this is the caller it never got.
   */
  const handleRestrictToggle = async () => {
    const next = !isRestricted;
    try {
      if (next) await userAPI.restrict(username);
      else await userAPI.unrestrict(username);
      setIsRestricted(next);
      toast.success(next ? "User restricted" : "Restriction removed");
    } catch (error) {
      console.error("Error updating restriction:", error);
      toast.error(
        error?.response?.data?.error ||
          (next ? "Failed to restrict user" : "Failed to remove the restriction")
      );
    }
  };

  const handleBlock = () => {
    // Shared confirmation dialog + app-wide block state.
    requestBlock({ _id: selectedUser?._id, username, name: selectedUser?.name });
  };

  const handleUnblock = async () => {
    try {
      await unblockUser(peerIdentity);
      setIsBlocked(false);
    } catch {
      // toast handled in context
    }
  };

  const handleReport = () => {
    openReport({
      targetType: "conversation",
      username,
      name: selectedUser?.name,
    });
  };

  // Only offered on messages you didn't send, so the peer is always the owner.
  const handleReportMessage = (message) => {
    openReport({
      targetType: "message",
      targetId: message._id,
      username,
      name: selectedUser?.name,
    });
  };

  const handleDeleteChat = () => setDeleteChatOpen(true);

  /*
   * Through the provider, not `chatAPI` directly.
   *
   * This used to delete and navigate straight to `/chat`, which left the row on the
   * list it navigated to: nothing removed it from `conversations`, and ChatPage only
   * refetches on mount — and it never unmounts, since it sits outside the router
   * outlet. So deleting from inside a thread looked like it had done nothing. The
   * action removes the row and reports its own failures.
   */
  const confirmDeleteChat = async () => {
    setDeletingChat(true);
    try {
      const ok = await deleteChat(username, selectedUser?._id ? `user_${selectedUser._id}` : undefined);
      if (ok) navigate("/chat");
    } finally {
      setDeletingChat(false);
      setDeleteChatOpen(false);
    }
  };

  const formatLastSeen = (lastSeen) => {
    if (!lastSeen) return null;

    const diffMs = Date.now() - new Date(lastSeen).getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);

    if (diffSecs < 60) return `${diffSecs}s ago`;
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks <= 4) return `${diffWeeks}w ago`;
    return null;
  };


  /*
   * When a time divider goes between two groups (#154).
   *
   * `prevTime.getHours() !== currentTime.getHours()` was the trigger, which is the
   * hour *digit* changing rather than an hour passing — so 10:59 and 11:00 got a
   * divider between them, one minute apart, while 11:00 and 11:58 got none. Elapsed
   * time is the thing that was meant.
   *
   * `sameDay` is the other half: there was no day boundary at all, so a conversation
   * that went quiet overnight ran straight from yesterday into today with nothing
   * marking it. A new day always gets a divider however few minutes have passed.
   */
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const TIME_DIVIDER_GAP_MS = 60 * 60 * 1000;

  const shouldShowTimestamp = (prevGroup, currentGroup) => {
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
  const timestampDividerLabel = (prevGroup, currentGroup) => {
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

  const groupMessages = useCallback(() => {
    const grouped = [];
    let currentGroup = [];

    messages.forEach((message) => {
      const isOwn = (message.sender?._id || message.sender) === currentUserId;

      if (
        currentGroup.length === 0 ||
        currentGroup[0].isOwn !== isOwn ||
        new Date(message.createdAt) -
          new Date(currentGroup[currentGroup.length - 1].createdAt) >
          2 * 60 * 1000
      ) {
        if (currentGroup.length > 0) {
          grouped.push(currentGroup);
        }
        currentGroup = [];
      }

      currentGroup.push({ ...message, isOwn });
    });

    if (currentGroup.length > 0) {
      grouped.push(currentGroup);
    }

    return grouped;
  }, [messages, currentUserId]);

  const getMessageIndicator = (message, isOwn) => {
    if (!isOwn) return null;

    // A rejected send used to render as "Delivered" — messageStatus was set and
    // read by nothing — so a message the server refused sat in the thread
    // looking fine, with its text already cleared from the composer.
    if (message.messageStatus === "failed") {
      return (
        <span className="text-xs text-red-400">
          {message.failedReason || "Not delivered"}
        </span>
      );
    }
    if (message.messageStatus === "sending") return null;

    const isLastMessage = message._id === messages[messages.length - 1]?._id;
    if (!isLastMessage) return null;

    // From the peer's read watermark. The old test was `message.isRead`, which
    // is not a field on the schema, so Seen could never render at all.
    if (peerReadAtDate && new Date(message.createdAt) <= peerReadAtDate) {
      return (
        <div className="flex items-center gap-1">
          <span className="text-xs text-neutral-400">Seen</span>
          <img
            src={selectedUser?.profilePic || "/default-avatar.png"}
            alt="Seen"
            className="w-3 h-3 rounded-full"
          />
        </div>
      );
    }

    return message.isUploading ? null : "Delivered";
  };


  /*
   * The peer the header draws, which is not necessarily the one we've loaded.
   *
   * `selectedUser` can only be set after `getProfile` and `loadMessages` have both
   * answered, and the cached thread snapshot only exists for a conversation that has
   * been opened before. So on a first-ever open the header sat on "User" and a
   * default avatar for two round trips while the messages were already on screen.
   *
   * The chat list row is the third source, and the cheapest: it is already in memory
   * (warm-started from IndexedDB by the provider) and carries `name`, `profilePic`,
   * `username` and `isVerified` — everything drawn here. Matched by username because
   * that is what the route gives us; rows are keyed by peer id.
   */
  const listPeer = useMemo(() => {
    if (selectedUser || !username) return null;
    const row = conversations.find(
      (entry) =>
        !entry.isGroup &&
        entry.user?.username?.toLowerCase() === username.toLowerCase()
    );
    return row?.user || null;
  }, [selectedUser, conversations, username]);

  // The loaded profile wins; the list row is only a stand-in until it arrives.
  const headerUser = selectedUser || listPeer;

  /*
   * Memoised. This walks every message and spreads `{...message, isOwn}` for
   * each one, so at a few thousand messages it was allocating a few thousand
   * objects on every keystroke — and handing MessageBubble a new object each
   * time, which would defeat its memo even now that the type is stable.
   */
  const messageGroups = useMemo(() => groupMessages(), [groupMessages]);

  /*
   * The blocks below are chunks of this component's JSX, not components.
   *
   * They were written as `const X = () => (...)` and rendered as `<X />`, which
   * makes React treat each one as a distinct component *type* that is redefined
   * on every render — so it unmounted and remounted the whole subtree every
   * time anything on the page changed. That is why the caption field in the
   * forward sheet lost focus after each keystroke.
   *
   * None of them takes props or uses hooks, so calling them as functions puts
   * the JSX straight into this component's tree, where it belongs. Anything
   * that genuinely needs to be a component — MessageBubble — is one, at module
   * scope, and memoised.
   */
  const renderUserStatusIndicator = () => {
    const resolvedLastSeen = selectedUser
      ? userLastSeenMap[selectedUser._id] || lastSeen
      : null;
    return (
      <div className="flex items-center gap-2 text-xs">
        {isOnline ? (
          <span className="text-green-500">Online</span>
        ) : resolvedLastSeen ? (
          <span className="text-neutral-400">
            Last seen {formatLastSeen(resolvedLastSeen)}
          </span>
        ) : null}
      </div>
    );
  };

  // Forward Modal
  const renderForwardModal = () => (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl max-w-md w-full max-h-[80vh] overflow-hidden">
        <div className="p-4 border-b border-neutral-800">
          <h3 className="font-medium text-lg">Forward Message</h3>
          <p className="text-neutral-400 text-sm mt-1">
            Select contacts to forward to
          </p>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {forwardContacts.map((contact) => (
            <div
              key={contact._id}
              className="flex items-center gap-3 p-3 hover:bg-neutral-800 cursor-pointer"
              onClick={() => {
                setSelectedForwardContacts((prev) =>
                  prev.some((c) => c._id === contact._id)
                    ? prev.filter((c) => c._id !== contact._id)
                    : [...prev, contact]
                );
              }}
            >
              <input
                type="checkbox"
                checked={selectedForwardContacts.some(
                  (c) => c._id === contact._id
                )}
                onChange={() => {}}
                className="w-4 h-4 text-blue-500 rounded"
              />
              <img
                src={contact.profilePic || "/default-avatar.png"}
                alt={contact.username}
                className="w-10 h-10 rounded-full"
              />
              <div>
                <p className="text-white font-medium">
                  {contact.name || contact.username}
                </p>
                <p className="text-neutral-400 text-sm">@{contact.username}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-neutral-800 flex gap-3">
          <button
            onClick={() => {
              setShowForwardModal(false);
              setSelectedForwardContacts([]);
              setMessageToForward(null);
            }}
            className="flex-1 bg-neutral-800 text-white py-2.5 rounded-lg font-medium hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleForwardMessage}
            disabled={selectedForwardContacts.length === 0}
            className="flex-1 bg-violet-600 text-white py-2.5 rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            Forward ({selectedForwardContacts.length})
          </button>
        </div>
      </div>
    </div>
  );

  const renderReplyPreview = () => (
    <div className="flex items-center justify-between bg-neutral-800 px-4 py-2 border-l-4 border-violet-600 mx-2 mb-2 rounded-lg">
      <div className="flex-1">
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span>
            Replying to{" "}
            {replyingTo?.isOwn ? "yourself" : replyingTo?.senderUsername}
          </span>
        </div>
        <div className="text-sm truncate">{messagePreviewLabel(replyingTo)}</div>
      </div>
      <button
        onClick={() => setReplyingTo(null)}
        className="text-neutral-400 hover:text-white ml-2"
      >
        <Icons.close className="w-4 h-4" />
      </button>
    </div>
  );

  const renderEditingPreview = () => (
    <div className="flex items-center justify-between bg-blue-900 bg-opacity-30 px-4 py-2 border-l-4 border-blue-600 mx-2 mb-2 rounded-lg">
      <div className="flex-1">
        <div className="text-xs text-blue-400 mb-1">Editing message</div>
        <div className="text-sm truncate">{editingMessage?.content}</div>
      </div>
      <button
        onClick={() => {
          setEditingMessage(null);
          setNewMessage("");
        }}
        className="text-neutral-400 hover:text-white ml-2"
      >
        <Icons.close className="w-4 h-4" />
      </button>
    </div>
  );

  const renderPinnedMessagesBar = () => (
    <div className="bg-neutral-800 border-l-4 border-yellow-500 mx-2 mb-2 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icons.pin className="w-4 h-4 text-yellow-500" />
          <span className="text-sm font-medium text-white">
            Pinned Messages
          </span>
        </div>
        <button
          onClick={() => setPinnedBarDismissed(true)}
          aria-label="Hide pinned messages"
          className="text-neutral-400 hover:text-white"
        >
          <Icons.close className="w-4 h-4" />
        </button>
      </div>
      <div
        className={`space-y-2 overflow-y-auto ${
          showAllPinned ? "max-h-64" : "max-h-32"
        }`}
      >
        {(showAllPinned ? pinnedMessages : pinnedMessages.slice(0, 3)).map((message) => (
          <button
            type="button"
            key={message._id}
            className="w-full text-left text-sm text-neutral-300 hover:bg-neutral-700 p-2 rounded"
            onClick={() => jumpToMessage(message._id)}
          >
            <div className="flex justify-between text-xs text-neutral-400 mb-1">
              <span>{message.sender?.username || "Unknown"}</span>
              <span>{formatInstagramTimestamp(message.createdAt)}</span>
            </div>
            <div className="truncate">{messagePreviewLabel(message)}</div>
          </button>
        ))}
      </div>
      {pinnedMessages.length > 3 && (
        <button
          onClick={() => setShowAllPinned((v) => !v)}
          className="text-blue-400 text-xs mt-2 hover:text-blue-300"
        >
          {showAllPinned
            ? "Show fewer"
            : `View all ${pinnedMessages.length} pinned messages`}
        </button>
      )}
    </div>
  );

  const renderMediaWidget = () => (
    <div className="px-3 pt-2 pb-1 border-t border-neutral-800">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pt-2 pb-1">
        {selectedMediaFiles.map((item, idx) => (
          <div key={idx} className="relative shrink-0">
            <button
              className="block w-16 h-16 rounded-xl overflow-hidden focus:outline-none"
              onClick={() => setBigPreviewMedia(item)}
            >
              {item.type === "image" ? (
                <img src={item.url} alt="" className="w-full h-full object-cover" />
              ) : (
                /*
                 * The video's first frame, not a grey box with an icon in it.
                 *
                 * The blob URL was already here and simply wasn't used — the video
                 * branch rendered a placeholder, so a strip of selected clips was
                 * indistinguishable from one another and you couldn't tell which
                 * video you had picked. `preload="metadata"` is what paints the
                 * frame, and `muted` is required for iOS to render one at all; the
                 * background stays as the fallback for a codec the browser won't
                 * decode.
                 */
                <div className="relative w-full h-full bg-neutral-800">
                  <video
                    src={item.url}
                    preload="metadata"
                    muted
                    playsInline
                    tabIndex={-1}
                    className="w-full h-full object-cover"
                  />
                  {/* Marks it as a video, since a still frame reads as a photo. */}
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0.5 right-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-black/60 pointer-events-none"
                  >
                    <Icons.videocam className="w-2.5 h-2.5 text-white" />
                  </span>
                </div>
              )}
            </button>
            <button
              onClick={() => {
                releaseObjectUrl(item.url);
                setSelectedMediaFiles((prev) => prev.filter((_, i) => i !== idx));
              }}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-neutral-600 rounded-full flex items-center justify-center hover:bg-red-500 transition-colors z-10"
            >
              <Icons.close className="w-3 h-3 text-white" />
            </button>
          </div>
        ))}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-16 h-16 shrink-0 rounded-xl border-2 border-dashed border-neutral-700 flex items-center justify-center text-neutral-500 hover:text-white hover:border-neutral-500 transition-colors"
          title="Add more"
        >
          <Icons.image className="w-5 h-5" />
        </button>
      </div>
    </div>
  );

  const renderMessageContextMenu = () => (
    <DropdownMenu
      open={!!contextMenu}
      onOpenChange={(open) => !open && closeContextMenu()}
    >
      {/*
        The trigger is a zero-size point at the click, and Radix positions from it
        (#48).

        It used to be a `fixed inset-0` element with `align="end"`, plus an inline
        `position:fixed; left; top` on the Content — and Radix renders Content inside
        a `[data-radix-popper-content-wrapper]` that already carries a `transform`.
        A transform establishes a containing block for fixed descendants, so those
        coordinates resolved relative to the wrapper rather than the viewport, and the
        wrapper was anchored to the bottom-right of the screen. Two positioning
        systems fighting, with no `Math.max(0, …)` either, so a right-click near the
        left edge produced a negative `left`.

        Anchoring to the point and letting Radix do the work is one system. It also
        gets collision detection and flipping for free, which is what the hand-rolled
        clamps were trying to approximate.
      */}
      <DropdownMenuTrigger asChild>
        <div
          aria-hidden="true"
          className="fixed z-40"
          style={{
            left: contextMenu?.x ?? 0,
            top: contextMenu?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent sheetTitle="Message"
        align="start"
        side="bottom"
        sideOffset={4}
        collisionPadding={12}
        className="bg-neutral-900 border-neutral-700 rounded-2xl w-56 p-2 z-50"
      >
        {canEditMessage(selectedMessage) && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("edit")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
          >
            <span>Edit</span>
            <Icons.edit className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("reply")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>Reply</span>
          <Icons.reply3 className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("react")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>React</span>
          <Icons.smile className="w-4 h-4" />
        </DropdownMenuItem>
        {selectedMessage?.content && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("copy")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
          >
            <span>Copy</span>
            <Icons.copy className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("forward")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>Forward</span>
          <Icons.forward className="w-4 h-4" />
        </DropdownMenuItem>
        {/*
          Only on a message that has something to save, and not on a tombstone —
          an unsent message's media is gone from the CDN, so the item would be an
          offer to download a 404.
        */}
        {selectedMessage?.media?.length > 0 && !selectedMessage?.isDeleted && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("download")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
          >
            <span>{selectedMessage.media.length > 1 ? "Download all" : "Download"}</span>
            <Icons.download className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("pin")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>{selectedMessage?.isPinned ? "Unpin" : "Pin"}</span>
          <Icons.pin className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-neutral-700 my-2" />
        {!selectedMessage?.isOwn && !selectedMessage?.isDeleted && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("report")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
          >
            <span>Report</span>
            <Icons.report className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        {selectedMessage?.isOwn && !selectedMessage?.isDeleted && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("unsend")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
          >
            <span>Unsend</span>
            <Icons.delete className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("delete")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
        >
          <span>Delete for me</span>
          <Icons.delete className="w-4 h-4" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (!userAuth?.token) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        <div className="text-center">
          <Icons.lock className="w-12 h-12 mx-auto mb-4 text-neutral-400" />
          <p>Please log in to access messages</p>
        </div>
      </div>
    );
  }

  /*
   * A locked conversation renders the PIN gate *instead of* the thread.
   *
   * Before the header, before the composer, before anything that could show who
   * this is or what was said — the server has returned no messages and no peer,
   * so there is nothing to render behind a modal even if one were wanted.
   */
  if (lockedChatId) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-black text-white">
        <ChatLockPrompt
          chatId={lockedChatId}
          onUnlocked={() => {
            setLockedChatId(null);
            setUnlockAttempt((n) => n + 1);
          }}
          onCancel={() => navigate("/chat")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-black text-white">
      {/* Enhanced Header */}
      <header className="shrink-0 bg-black border-b border-neutral-800 z-10 py-3 px-3 sm:py-4 sm:px-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(-1)}
            className="md:hidden text-neutral-400 hover:text-white transition-colors"
            aria-label="Go back"
          >
            <Icons.back className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
              type="button"
              className="relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-600"
              onClick={() =>
                headerUser?.username && navigate(`/${headerUser.username}`)
              }
              aria-label="View profile"
            >
              <img
                src={headerUser?.profilePic || "/default-avatar.png"}
                alt={headerUser?.username}
                className="w-9 h-9 rounded-full object-cover border border-neutral-700"
              />
              {isOnline && (
                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-black bg-green-500" />
              )}
            </button>
            <button
              type="button"
              className="flex-1 min-w-0 text-left cursor-pointer"
              onClick={() =>
                username && navigate(`/chat/${username}/details`)
              }
              aria-label="Conversation details"
            >
              <h2 className="font-medium text-base truncate">
                {headerUser?.name || headerUser?.username || "User"}
              </h2>{renderUserStatusIndicator()}</button>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => {
                /* Implement call functionality */
              }}
              className="text-neutral-400 hover:text-white transition-colors cursor-pointer p-0.5"
              aria-label="Voice Call"
            >
              <Icons.phone className="w-5 h-5 shrink-0" />
            </button>
            <button
              onClick={() => {
                /* Implement video call functionality */
              }}
              className="text-neutral-400 hover:text-white transition-colors cursor-pointer p-0.5"
              aria-label="Video Call"
            >
              <Icons.video className="w-5 h-5 shrink-0" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="text-white cursor-pointer" aria-label="Menu">
                  <Icons.about className="w-6 h-6" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent sheetTitle="Chat options"
                align="end"
                className="bg-neutral-900 border-neutral-700 rounded-2xl w-56 p-2"
              >
                {/*
                  No longer `disabled` once used. That was the whole of the
                  un-restrict story: the only affordance greyed itself out, so the
                  action was irreversible from the UI even after the endpoint
                  existed.
                */}
                <DropdownMenuItem
                  onClick={handleRestrictToggle}
                  className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                >
                  <span>{isRestricted ? "Remove restriction" : "Restrict"}</span>
                  <Icons.restrict className="w-5 h-5" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={isUserBlocked(peerIdentity) ? handleUnblock : handleBlock}
                  className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                >
                  <span>{isUserBlocked(peerIdentity) ? "Unblock" : "Block"}</span>
                  <Icons.block className="w-5 h-5" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleReport}
                  className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                >
                  <span>Report</span>
                  <Icons.report className="w-5 h-5" />
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-neutral-700 my-2" />
                <DropdownMenuItem
                  onClick={handleDeleteChat}
                  className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
                >
                  <span>Delete Chat</span>
                  <Icons.delete className="w-5 h-5" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {showSearch && (
          <div className="mt-3 flex items-center gap-2">
            <input
              type="search"
              placeholder="Search messages..."
              aria-label="Search this conversation"
              value={searchQuery}
              /*
               * Just the state. The search itself runs off the debounced value in an
               * effect (#104).
               *
               * Calling `searchMessages()` from here searched the *previous*
               * render's query — the callback closes over `searchQuery` before
               * setState has applied — so results were always one keystroke behind.
               * It also fired one request per character with no cancellation, so
               * whichever response happened to arrive last won regardless of which
               * query it answered.
               */
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-neutral-800 text-white placeholder-neutral-400 rounded-full px-4 py-2 text-sm focus:outline-none"
            />
            <button
              onClick={() => {
                setShowSearch(false);
                setSearchQuery("");
                setSearchResults([]);
              }}
              className="text-neutral-400 hover:text-white p-2"
            >
              <Icons.close className="w-4 h-4" />
            </button>
          </div>
        )}
      </header>

      {/*
        Outside the scroll container. It used to be the first child of <main>,
        so it scrolled away with the oldest messages the moment you moved —
        a permanently-visible summary that was almost never visible.
      */}
      {!loading && pinnedMessages.length > 0 && !pinnedBarDismissed && (
        <div className="shrink-0 pt-2">{renderPinnedMessagesBar()}</div>
      )}

      <ReconnectBanner />

      {/*
        `role="log"`, and the scrollbar is back on desktop (#155).

        The thread had no role at all, so a screen reader treated an arriving message
        as an unannounced DOM mutation — the one thing a live region exists for.
        `aria-live="polite"` waits for a pause rather than interrupting mid-sentence,
        which is right for a conversation.

        `scrollbar-hide` removed the only affordance a desktop user has for seeing
        that there is history above, and the only thing they can drag. `custom-scrollbar`
        is the project's existing thin dark scrollbar, so the thread gets a visible
        one without looking like a different app; on touch the scrollbar is an overlay
        that appears only while scrolling, so there was nothing to hide there either.
      */}
      <main
        ref={messagesContainerRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={`Conversation with ${selectedUser?.name || selectedUser?.username || username}`}
        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar"
      >
        {/*
          The spinner only when there is nothing to show. `loading` covers the
          whole of initChat — profile, thread, pinned messages, presence — so
          gating on it alone meant a thread warm-started from cache was hidden
          behind a spinner until every one of those finished, which defeats the
          point of having the snapshot.
        */}
        {loading && messages.length === 0 ? (
          <div className="flex justify-center items-center min-h-[200px]">
            <Icons.spinner className="animate-spin w-8 h-8 text-neutral-400" />
          </div>
        ) : (
          <div className="min-h-full flex flex-col">
            {showSearch && searchResults.length > 0 && (
              <div className="px-4 py-2 bg-neutral-900 mx-2 rounded-lg mb-4">
                <div className="text-xs text-neutral-400 mb-2">
                  {searchResults.length} result
                  {searchResults.length !== 1 ? "s" : ""} found
                </div>
                {searchResults.map((message) => (
                  <div
                    key={message._id}
                    className="text-sm py-2 border-b border-neutral-800 last:border-b-0 cursor-pointer hover:bg-neutral-800 px-2 rounded"
                    onClick={() => {
                      const element = document.getElementById(
                        `msg-${message._id}`
                      );
                      element?.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                      element?.classList.add("bg-violet-900");
                      setTimeout(
                        () => element?.classList.remove("bg-violet-900"),
                        2000
                      );
                    }}
                  >
                    <div className="flex justify-between mb-1">
                      <span className="text-neutral-400 text-xs">
                        {formatInstagramTimestamp(message.createdAt)}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {message.isOwn ? "You" : selectedUser?.name}
                      </span>
                    </div>
                    <p className="truncate">{messagePreviewLabel(message)}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col items-center justify-center mt-6 mb-8 px-4">
              <img
                src={selectedUser?.profilePic || "/default-avatar.png"}
                alt={selectedUser?.username}
                className="w-20 h-20 rounded-full object-cover border-2 border-neutral-700"
              />
              <h3 className="mt-4 font-medium">{selectedUser?.name}</h3>
              {!blockedByThem && (
                <>
                  <p className="text-neutral-400">@{selectedUser?.username}</p>
                  <p className="text-sm text-neutral-400 mt-1">
                    {selectedUser?.followerCount || 0} followers
                  </p>
                </>
              )}
              <button
                className="bg-neutral-900 rounded-xl py-2 px-4 mt-3 font-medium text-sm hover:bg-neutral-800 transition-colors"
                onClick={() => navigate(`/${selectedUser?.username}`)}
              >
                View profile
              </button>
            </div>

            <div className="flex-1" />

            <div className="pb-4">
              <div ref={topSentinelRef} />
              {/*
                Always in the layout, only sometimes visible (CF16).

                It used to mount when `loadingMore` went true and unmount when the page
                arrived — after the scroll anchor had been captured and before it was
                restored. So the restore maths was out by the spinner's height, about
                56px, on every page: the thread jumped a little each time you scrolled
                up. Reserving the space unconditionally means the anchor measures a
                container whose height doesn't change underneath it.
              */}
              <div className="flex justify-center py-4" aria-hidden={!loadingMore}>
                <Icons.spinner
                  className={`animate-spin w-6 h-6 text-neutral-400 ${
                    loadingMore ? "" : "invisible"
                  }`}
                />
              </div>
              {messageGroups.length === 0 ? (
                <div className="text-center py-12 text-neutral-400">
                  <Icons.chat2 className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No messages yet. Start the conversation!</p>
                </div>
              ) : (
                messageGroups.map((group, groupIndex) => {
                  const isOwn = group[0].isOwn;
                  const showTimestamp = shouldShowTimestamp(
                    messageGroups[groupIndex - 1],
                    group
                  );

                  return (
                    /*
                     * Keyed on the first message's id alone, with no `groupIndex`
                     * (#106).
                     *
                     * Prepending a page of history shifts every index, so every key
                     * changed and React unmounted and remounted the entire list —
                     * underneath the scroll-restore maths, which is measuring the
                     * heights of elements that are being destroyed. A message id is
                     * stable across a prepend, which is the whole requirement.
                     */
                    <React.Fragment key={`group-${group[0]._id}`}>
                      {showTimestamp && (
                        <div className="text-center text-xs text-neutral-500 my-4">
                          {timestampDividerLabel(messageGroups[groupIndex - 1], group)}
                        </div>
                      )}

                      <div
                        className={`flex ${isOwn ? "justify-end" : "justify-start"} px-3 mb-3`}
                      >
                        {!isOwn && (
                          <div className="mr-2 self-end mb-1">
                            <img
                              src={
                                selectedUser?.profilePic ||
                                "/default-avatar.png"
                              }
                              // Decorative: the group already carries the sender's
                              // name, and `alt={selectedUser?.username}` rendered the
                              // literal string "undefined" while the profile loaded.
                              alt=""
                              className="w-8 h-8 rounded-full object-cover border border-neutral-800"
                            />
                          </div>
                        )}

                        <div
                          className={`max-w-[80%] flex flex-col gap-[2px] ${
                            isOwn ? "items-end" : "items-start"
                          }`}
                        >
                          {group.map((message, msgIndex) => (
                            <MessageBubble
                              key={message._id || message.tempId}
                              message={message}
                              isOwn={isOwn}
                              msgIndex={msgIndex}
                              groupLength={group.length}
                              isReacting={reactingTo === message._id}
                              onAddReaction={handleAddReaction}
                              onContextMenu={handleMessageContextMenu}
                              onJumpToMessage={jumpToMessage}
                              onDismissReactions={dismissReactions}
                              onVote={handleVote}
                              onOpenMedia={setBigPreviewMedia}
                            />
                          ))}
                        </div>
                      </div>

                      {getMessageIndicator(group[group.length - 1], isOwn) && (
                        <div
                          className={`text-xs text-neutral-400 mt-1 px-3 ${
                            isOwn ? "text-right" : "text-left ml-12"
                          }`}
                        >
                          {getMessageIndicator(group[group.length - 1], isOwn)}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })
              )}
              {uploadingPreview && (
                <div className="flex justify-end px-3 mb-3">
                  <div className="max-w-[80%] flex flex-col items-end">
                    <MessageBubble
                      message={uploadingPreview}
                      isOwn={true}
                      msgIndex={0}
                      groupLength={1}
                      isReacting={reactingTo === uploadingPreview._id}
                      onAddReaction={handleAddReaction}
                      onContextMenu={handleMessageContextMenu}
                      onJumpToMessage={jumpToMessage}
                      onDismissReactions={dismissReactions}
                    />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {isUserTyping && (
              <div className="flex justify-start px-3 mb-3">
                <div className="mr-2 self-end mb-1">
                  <img
                    src={selectedUser?.profilePic || "/default-avatar.png"}
                    alt={selectedUser?.username}
                    className="w-8 h-8 rounded-full object-cover border border-neutral-800"
                  />
                </div>
                <div className="bg-neutral-800 px-4 py-3 rounded-2xl rounded-bl-md">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce" />
                    <div
                      className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.1s" }}
                    />
                    <div
                      className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.2s" }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <div className="shrink-0 bg-black" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {replyingTo && renderReplyPreview()}
        {editingMessage && renderEditingPreview()}

        {blocked ? (
          isUserBlocked(peerIdentity) || isBlocked ? (
            // You blocked them — Instagram-style bar with Unblock / Delete.
            <div className="bg-black border-t border-neutral-800 px-4 pt-3 pb-4">
              <p className="text-center font-semibold text-[15px]">
                You blocked {username}
              </p>
              <p className="text-center text-neutral-400 text-sm mt-1 mb-3">
                You can't message or call this profile unless you unblock them
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleUnblock}
                  className="flex-1 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 font-semibold cursor-pointer"
                >
                  Unblock
                </button>
                <button
                  onClick={handleDeleteChat}
                  className="flex-1 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 font-semibold text-red-500 cursor-pointer"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : blockedByThem ? (
            <div className="py-4 bg-black border-t border-neutral-800 text-center text-neutral-400 text-sm">
              You can't message this account
            </div>
          ) : (
            <div className="py-4 bg-black border-t border-neutral-800 text-center text-neutral-400 text-sm">
              You cannot message restricted users
            </div>
          )
        ) : (
          <div className="bg-black border-t border-neutral-800">
          {selectedMediaFiles.length > 0 && !isRecording && !voicePreview && renderMediaWidget()}
          <div className="py-3">
          {/* ── Instagram-style recording bar ── */}
          {isRecording ? (
            <div className="flex items-center gap-2.5 mx-3 px-3 py-2 bg-[#0095F6] rounded-full">
              {/* Delete / cancel */}
              <button
                onClick={cancelRecording}
                className="shrink-0 p-1 text-white/80 hover:text-red-400 cursor-pointer transition-colors"
                aria-label="Cancel recording"
              >
                <Icons.trash className="w-5 h-5" />
              </button>

              {/* Live waveform — bars sized by real amplitude (0–1) */}
              <div className="flex-1 flex items-center justify-start gap-[2px] h-9 overflow-hidden">
                {liveWaveform.map((amp, i) => (
                  <div
                    key={i}
                    className="w-[2.5px] rounded-full bg-white shrink-0"
                    style={{
                      height: `${Math.max(3, amp * 30)}px`,
                      transition: "height 60ms ease-out",
                    }}
                  />
                ))}
                {/* idle dots shown before first tick */}
                {liveWaveform.length === 0 && (
                  <div className="flex items-center gap-[2px]">
                    {[0.3, 0.5, 0.4, 0.6, 0.3].map((a, i) => (
                      <div key={i} className="w-[2.5px] rounded-full bg-white/60 shrink-0" style={{ height: `${a * 30}px` }} />
                    ))}
                  </div>
                )}
              </div>

              {/* Timer */}
              <span className="text-white text-[13px] font-semibold tabular-nums shrink-0 min-w-[38px] text-right">
                {`${Math.floor(recordingTime / 60).toString().padStart(2, "0")}:${(recordingTime % 60).toString().padStart(2, "0")}`}
              </span>

              {/* Stop button — square icon → transitions to preview */}
              <button
                onClick={stopRecording}
                className="shrink-0 w-8 h-8 bg-white rounded-full flex items-center justify-center ml-1 cursor-pointer active:scale-95 transition-transform"
                aria-label="Stop recording"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-[#0095F6]">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              </button>
            </div>

          ) : voicePreview ? (
          /* ── Voice preview bar ── */
            <div className="flex items-center gap-2.5 mx-3 px-3 py-2 bg-[#0095F6] rounded-full">
              {/* Delete */}
              <button
                onClick={cancelVoicePreview}
                className="shrink-0 p-1 text-white/80 hover:text-red-400 cursor-pointer transition-colors"
                aria-label="Delete voice note"
              >
                <Icons.trash className="w-5 h-5" />
              </button>

              {/* Play / Pause preview */}
              <button
                onClick={toggleVoicePreviewPlay}
                className="shrink-0 w-7 h-7 flex items-center justify-center text-white cursor-pointer"
                aria-label={isVoicePreviewPlaying ? "Pause" : "Play"}
              >
                {isVoicePreviewPlaying ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                ) : (
                  <Icons.play className="w-5 h-5 ml-0.5" />
                )}
              </button>

              {/* The recorded envelope, filling as it plays. */}
              <div className="flex-1 flex items-center justify-start gap-[2px] h-9 overflow-hidden">
                {(() => {
                  const bars =
                    voicePreview.waveformSnapshot?.length > 0
                      ? voicePreview.waveformSnapshot
                      : voiceStaticWaveform;
                  return bars.map((amp, i) => (
                    <div
                      key={i}
                      // Played bars are solid, the rest are dimmed — the same
                      // treatment the sent bubble gives them.
                      className={`w-[2.5px] rounded-full shrink-0 transition-colors duration-75 ${
                        i / bars.length < voicePreviewProgress
                          ? "bg-white"
                          : "bg-white/40"
                      }`}
                      style={{ height: `${Math.max(3, amp * 30)}px` }}
                    />
                  ));
                })()}
              </div>

              {/*
                Counts up while playing, total when idle.
                It was bound to `voicePreview.duration` and so never moved, which made
                a playing clip indistinguishable from a stopped one.
              */}
              <span className="text-white text-[13px] font-semibold tabular-nums shrink-0 min-w-[38px] text-right">
                {formatClock(
                  isVoicePreviewPlaying || voicePreviewTime > 0
                    ? voicePreviewTime
                    : voicePreview.duration
                )}
              </span>

              {/* Send */}
              <button
                onClick={sendVoiceNote}
                disabled={isSending}
                className="shrink-0 w-8 h-8 bg-white rounded-full flex items-center justify-center ml-1 cursor-pointer active:scale-95 transition-transform disabled:opacity-60"
                aria-label="Send voice note"
              >
                {isSending ? (
                  <Icons.spinner className="w-4 h-4 text-[#0095F6] animate-spin" />
                ) : (
                  <Icons.send className="w-4 h-4 text-[#0095F6]" />
                )}
              </button>
            </div>

          ) : (
          /* ── Normal input row ── */
          <>
          <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 relative">
            {/*
              `onClick`, not `onPointerDown` (CF17).

              `pointerdown` doesn't fire for Enter or Space on a `<button>`, so
              recording was unreachable from the keyboard entirely — and it fired on
              *any* pointer button, so a right-click meant to open the browser menu
              started the microphone instead. `click` is synthesised for both keys and
              only for the primary button, which is both fixes at once.

              Recording is start/stop here rather than press-and-hold, so there is no
              gesture that needs the earlier event.
            */}
            <button
              type="button"
              onClick={startRecording}
              className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors"
              aria-label="Record a voice message"
            >
              <Icons.mic className="w-6 h-6" />
            </button>

            {/* Desktop only: phone keyboards have their own emoji panel, and
                this one is a fixed-width popover that doesn't fit beside it. */}
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="hidden md:inline-flex text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
              disabled={isSending}
              aria-label="Emoji"
            >
              <Icons.smile className="w-6 h-6" />
            </button>

            {showEmojiPicker && (
              <div className="absolute bottom-16 left-2 z-50 hidden md:block">
                <EmojiPicker onEmojiClick={handleEmojiClick} theme="dark" />
              </div>
            )}

            {/*
              A textarea, and never disabled.

              Two bugs in one element. It was `<input type="text">` while bubbles
              render `whitespace-pre-wrap` and `handleKeyDown` explicitly handles
              Shift+Enter — a single-line input cannot contain a newline, so the one
              key combination the code went out of its way to support could never do
              anything (#118). It grows to five lines and then scrolls.

              And `disabled={isSending}` blurs a focused field, which closes the
              phone's on-screen keyboard: you had to tap the input again after every
              single message (#46). `readOnly` keeps focus and the caret while still
              refusing input, and the send button is already disabled, so nothing can
              be submitted twice.
            */}
            <textarea
              ref={composerRef}
              rows={1}
              value={newMessage}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={editingMessage ? "Edit message..." : "Message..."}
              aria-label={editingMessage ? "Edit message" : "Message"}
              className="flex-1 min-w-0 resize-none bg-neutral-800 text-sm text-white placeholder-neutral-400 focus:outline-none py-2 sm:py-2.5 px-3 sm:px-4 rounded-2xl max-h-32 overflow-y-auto"
              readOnly={isSending}
              maxLength={MAX_MESSAGE_LENGTH}
            />

            <div className="hidden sm:block text-xs text-neutral-500 min-w-[60px] text-right">
              {newMessage.length}/{MAX_MESSAGE_LENGTH}
            </div>

            <input
              type="file"
              accept={COMPOSER_ACCEPT}
              ref={fileInputRef}
              onChange={handleMediaSelect}
              className="hidden"
              multiple
            />

            {newMessage.trim() || editingMessage || selectedMediaFiles.length > 0 ? (
              <button
                onClick={handleSendButtonClick}
                disabled={isSending}
                className="text-white px-3 sm:px-4 py-2 rounded-full bg-violet-600 hover:bg-violet-700 transition-colors disabled:opacity-50 font-medium text-sm shrink-0"
              >
                {isSending ? (
                  <Icons.spinner className="w-4 h-4 animate-spin" />
                ) : editingMessage ? (
                  "Save"
                ) : (
                  "Send"
                )}
              </button>
            ) : (
              <div className="flex gap-1">
                <button
                  onClick={() => fileInputRef.current.click()}
                  className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                  disabled={isSending}
                  aria-label="Media"
                >
                  <Icons.image className="w-6 h-6" />
                </button>
                <button
                  onClick={() => {
                    setShowGifPicker(!showGifPicker);
                  }}
                  className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                  disabled={isSending}
                  aria-label="GIF"
                >
                  <Icons.gif className="w-6 h-6" />
                </button>
                {/*
                  No poll composer here: a poll is a group instrument. Between two
                  people it collapses into a question you could just ask, and the
                  anonymous-vote setting is meaningless at n=1 — whoever answers is
                  identifiable by elimination, so "anonymous" would be a promise the
                  shape of the conversation can't keep. The button lives on
                  GroupChatPage only. PollBubble stays wired up below so DM polls
                  created before this still render and remain votable.
                */}
              </div>
            )}
          </div>

          {showGifPicker && (
            <GifPicker
              onSelect={handleGifSelect}
              onClose={() => setShowGifPicker(false)}
            />
          )}
          </>
          )}
          </div>
          </div>
        )}
      </div>

      {showForwardModal && renderForwardModal()}

      {/*
        The lightbox, as a dialog (#155).

        It had no `role`, no accessible name, no Escape handler, no focus trap and a
        20×20 close button — so a screen reader announced nothing when it opened,
        keyboard focus stayed on the thread behind it, Tab walked through content the
        user couldn't see, and the only way out was clicking a target less than half
        the 44px minimum. `aria-modal` plus a focus trap is what makes "modal" true
        rather than merely visual.
      */}
      {bigPreviewMedia && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={bigPreviewMedia.type === "image" ? "Image preview" : "Video preview"}
          ref={lightboxRef}
          tabIndex={-1}
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-50"
          onClick={() => setBigPreviewMedia(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setBigPreviewMedia(null);
              return;
            }
            /*
             * The trap. Two focusable elements at most (close, and a video's
             * controls), so cycling between the first and last is the whole of it —
             * without this, Tab left the dialog and walked the thread underneath.
             */
            if (event.key !== "Tab") return;
            const focusable = lightboxRef.current?.querySelectorAll(
              "button, video[controls], [href], [tabindex]:not([tabindex='-1'])"
            );
            if (!focusable?.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setBigPreviewMedia(null)}
              aria-label="Close preview"
              // 44px, the minimum touch target. It was 20×20.
              className="absolute -top-5 -right-5 w-11 h-11 bg-neutral-800 rounded-full flex items-center justify-center hover:bg-red-500 transition-colors z-10"
            >
              <Icons.close className="w-4 h-4 text-white" />
            </button>
            {bigPreviewMedia.type === "image" ? (
              <img
                src={bigPreviewMedia.url}
                alt=""
                className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl"
              />
            ) : (
              <video
                src={bigPreviewMedia.url}
                controls
                autoPlay
                className="max-w-[90vw] max-h-[90vh] rounded-xl"
              />
            )}
          </div>
        </div>
      )}
      {contextMenu && renderMessageContextMenu()}

      {pendingMessageAction?.kind === "unsend" && (
        <ConfirmDialog
          title="Unsend this message?"
          confirmLabel="Unsend"
          onConfirm={async () => {
            const { messageId } = pendingMessageAction;
            setPendingMessageAction(null);
            await handleUnsendMessage(messageId);
          }}
          onCancel={() => setPendingMessageAction(null)}
        >
          It's removed for everyone in this conversation and replaced with "This
          message was deleted". You can't undo this.
        </ConfirmDialog>
      )}

      {pendingMessageAction?.kind === "delete" && (
        <ConfirmDialog
          title="Delete this message for you?"
          confirmLabel="Delete"
          onConfirm={async () => {
            const { messageId } = pendingMessageAction;
            setPendingMessageAction(null);
            await handleDeleteMessageForMe(messageId);
          }}
          onCancel={() => setPendingMessageAction(null)}
        >
          It disappears from your copy of the conversation only — they keep theirs.
        </ConfirmDialog>
      )}

      {deleteChatOpen && (
        <ConfirmDialog
          title="Delete this conversation?"
          confirmLabel="Delete"
          busy={deletingChat}
          onConfirm={confirmDeleteChat}
          onCancel={() => setDeleteChatOpen(false)}
        >
          Every message disappears from your copy of the thread — they keep theirs.
          Your pin, mute, list and disappearing-message settings for it are cleared.
        </ConfirmDialog>
      )}
    </div>
  );
};

export default UserConversationPage;
