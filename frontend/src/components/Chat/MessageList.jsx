import React from "react";
import { Icons } from "../icons";
import MessageBubble from "./MessageBubble";
import SystemMessageBubble from "./SystemMessageBubble";
import { shouldShowTimestamp, timestampDividerLabel } from "../../lib/chatMessage";

/**
 * The scrolling body of a conversation: dividers, avatars, bubble stacks.
 *
 * Both threads rendered this themselves, and the group version was a much cruder
 * copy — no day dividers, no bubble grouping, no reaction pills, avatars only where
 * the sender happened to change. Sharing it is what makes a group thread look like a
 * DM thread rather than a different app.
 *
 * Everything page-specific arrives as a prop or a slot:
 *
 *   avatarFor      which face sits beside a stack. A DM always shows the peer; a group
 *                  shows whoever sent it.
 *   replyLabelFor  the "X replied to Y" line above a stack. Groups only — in a DM
 *                  there are two people and the line would state the obvious.
 *   indicatorFor   the Seen / Delivered / failed line under a stack.
 *   onOpenProfile  called with a username when an avatar is tapped.
 *   viewerId       the reader, so a system notice can say "you" rather than their name.
 *
 * Deliberately renders *only* the sentinel, spinner, dividers and stacks — no header,
 * no typing indicator, no upload preview. Those differ per page and belong to whoever
 * wraps this.
 */
const MessageList = ({
  groups,
  viewerId,
  reactingTo,
  loadingMore,
  topSentinelRef,
  emptyState = null,
  avatarFor,
  replyLabelFor,
  indicatorFor,
  onOpenProfile,
  onAddReaction,
  onContextMenu,
  onJumpToMessage,
  onDismissReactions,
  onVote,
  onOpenMedia,
}) => (
  <>
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

    {groups.length === 0
      ? emptyState
      : groups.map((group, groupIndex) => {
          const isOwn = group[0].isOwn;
          const showTimestamp = shouldShowTimestamp(groups[groupIndex - 1], group);

          /*
           * A system notice is not a message and gets none of the chrome below — no
           * avatar, no side, no bubble, no context menu. It reports something that
           * happened to the group, so it reads across the thread like a date divider.
           */
          if (group[0].messageType === "system") {
            return (
              <React.Fragment key={`sys-${group[0]._id || group[0].tempId}`}>
                {showTimestamp && (
                  <div className="text-center text-xs text-neutral-500 my-4">
                    {timestampDividerLabel(groups[groupIndex - 1], group)}
                  </div>
                )}
                <div className="my-2">
                  {group.map((message) => (
                    <SystemMessageBubble
                      key={message._id || message.tempId}
                      message={message}
                      viewerId={viewerId}
                    />
                  ))}
                </div>
              </React.Fragment>
            );
          }

          const avatar = !isOwn && avatarFor ? avatarFor(group[0]) : null;
          const replyLabel = replyLabelFor ? replyLabelFor(group[0]) : null;
          const indicator = indicatorFor
            ? indicatorFor(group[group.length - 1], isOwn)
            : null;

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
            <React.Fragment key={`group-${group[0]._id || group[0].tempId}`}>
              {showTimestamp && (
                <div className="text-center text-xs text-neutral-500 my-4">
                  {timestampDividerLabel(groups[groupIndex - 1], group)}
                </div>
              )}

              {/*
                "X replied to Y", above the stack rather than inside the bubble.
                It describes the exchange, not the message, and putting it in the
                bubble would repeat it for every message in a stack.
              */}
              {replyLabel && (
                <p
                  className={`text-[11px] text-neutral-500 mb-1 px-3 ${
                    isOwn ? "text-right" : "ml-12"
                  }`}
                >
                  {replyLabel}
                </p>
              )}

              <div
                className={`flex ${isOwn ? "justify-end" : "justify-start"} px-3 mb-3`}
              >
                {!isOwn && (
                  <div className="mr-2 self-end mb-1 shrink-0">
                    {/*
                      A button when it can go somewhere.
                      Tapping a face to open that person's profile is the one thing
                      everybody tries, and it did nothing on either thread.
                    */}
                    {avatar?.username && onOpenProfile ? (
                      <button
                        type="button"
                        onClick={() => onOpenProfile(avatar.username)}
                        aria-label={`View ${avatar.username}'s profile`}
                        className="block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-600 active:scale-95 transition-transform"
                      >
                        <img
                          src={avatar.src || "/default-avatar.png"}
                          alt=""
                          className="w-8 h-8 rounded-full object-cover border border-neutral-800"
                        />
                      </button>
                    ) : (
                      <img
                        src={avatar?.src || "/default-avatar.png"}
                        // Decorative: `alt={username}` rendered the literal string
                        // "undefined" while the profile was still loading.
                        alt=""
                        className="w-8 h-8 rounded-full object-cover border border-neutral-800"
                      />
                    )}
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
                      onAddReaction={onAddReaction}
                      onContextMenu={onContextMenu}
                      onJumpToMessage={onJumpToMessage}
                      onDismissReactions={onDismissReactions}
                      onVote={onVote}
                      onOpenMedia={onOpenMedia}
                    />
                  ))}
                </div>
              </div>

              {/*
                A flex row, not `text-right`.

                `text-align` only moves *inline* content, and the indicators aren't all
                inline: "Delivered" is a bare string and the failure is a `<span>`, so
                those did sit on the right — but "Seen" returns a block-level flex div,
                which filled the line and laid its avatar and label out from the left.
                So the same indicator appeared on a different side depending on which
                branch produced it. Justifying the row aligns every shape the same way.
              */}
              {indicator && (
                <div
                  className={`text-xs text-neutral-400 mt-1 px-3 flex items-center ${
                    isOwn ? "justify-end" : "justify-start ml-12"
                  }`}
                >
                  {indicator}
                </div>
              )}
            </React.Fragment>
          );
        })}
  </>
);

export default MessageList;
