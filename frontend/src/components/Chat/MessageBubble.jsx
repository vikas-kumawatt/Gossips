import React, { useState } from "react";
import { toast } from "react-hot-toast";
import { Icons } from "../icons";
import RichText from "../RichText";
import SharedPostCard from "./SharedPostCard";
import PollBubble from "./PollBubble";
import VoiceNoteBubble from "./VoiceNoteBubble";
import ChatVideoBubble from "./ChatVideoBubble";
import CallLogBubble from "./CallLogBubble";
import { useLongPress } from "../../hooks/useLongPress";
import { downloadMedia } from "../../lib/downloadMedia";
import { formatInstagramTimestamp, messagePreviewLabel } from "../../lib/chatMessage";

/**
 * The text of a message, as it appears in its own bubble.
 *
 * Media, stickers and shared posts render their own visual content elsewhere in the
 * bubble, so the only thing this contributes for them is the caption — and an empty
 * string when there isn't one, rather than a placeholder label duplicating what is
 * already on screen.
 *
 * Lives here rather than in lib/chatMessage.js because it returns JSX, and that file
 * is deliberately `.js` — Vite selects its loader by extension, so JSX there is a
 * build error.
 */
const getMessageBody = (message) => {
  if (message.isDeleted) {
    return (
      <span className="italic text-neutral-400">This message was deleted</span>
    );
  }
  return message.content || "";
};

/*
 * Moved out of UserConversationPage so both threads render the same bubble.
 *
 * The group thread had its own inline bubble markup — different corner radii, no
 * reaction pills, no hover timestamp, no pinned or forwarded badge, and a media
 * branch that only handled images. Every fix to the DM bubble had to be made twice
 * and in practice was made once, which is how the two pages drifted this far apart.
 *
 * It was already module-scope and prop-driven, so this is a file move rather than a
 * rewrite: nothing here reaches into a page's closure.
 */

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
  // A call log draws its own card, and it is a record rather than something said —
  // so it gets no gradient and no tail.
  const isCall = message.messageType === "call" && message.call && !isDeleted;

  // No bubble background: emoji-only or standalone media/gif (no text, no reply)
  const isMediaOnly = hasMedia && !hasContent && !message.replyTo && !isDeleted;
  const noBg = isEmojiOnly || isMediaOnly || isShareOnly || isCall;

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

        {/* A finished call. Written by the server, never by a client. */}
        {isCall && <CallLogBubble call={message.call} isOwn={isOwn} />}

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

export default MessageBubble;
