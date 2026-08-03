import { useNavigate } from "react-router-dom";
import { Lock, Play } from "lucide-react";
import { Icons } from "../icons";
import AiLabel from "../AiLabel";
import AudioPlayer from "../AudioPlayer";
import { normalizeMedia } from "../../lib/mediaTypes";
import SharedProfileCard from "./SharedProfileCard";

/**
 * A post or comment shared into a chat.
 *
 * Renders `sharedContent.resolved`, which the server computes per reader — so
 * the same message shows content to one person and a lock to another, and
 * keeps up with the post being edited, deleted, or the author going private.
 */
/** Capped rather than fixed at 240px: group bubbles are limited to 70% of the
 *  viewport, which is narrower than that on small phones. */
const SharedPostCard = ({ sharedContent }) => {
  const navigate = useNavigate();

  /*
   * A shared profile travels as the same message type — the type is the envelope
   * and `kind` says what's inside — so it's dispatched here rather than at both
   * of the places that render this card.
   */
  if (sharedContent?.kind === "profile") {
    return <SharedProfileCard sharedContent={sharedContent} />;
  }

  const resolved = sharedContent?.resolved;
  const snapshot = sharedContent?.snapshot;
  const kind = sharedContent?.kind === "comment" ? "comment" : "post";

  /**
   * Only the server knows whether this reader may see the shared post, and it
   * only works that out when the thread is fetched. A group message arriving
   * live has no `resolved`, so it renders as a neutral placeholder rather than
   * guessing — guessing "visible" would leak a private post to the whole group
   * for as long as the tab stays open.
   */
  if (!resolved) {
    return (
      <div className="w-full max-w-[240px] rounded-2xl border border-neutral-700 bg-neutral-900/60 p-3">
        <p className="text-[13px] text-neutral-300">Shared a {kind}</p>
        <p className="text-[11px] text-neutral-500 mt-0.5">
          {snapshot?.authorUsername ? `from @${snapshot.authorUsername} · ` : ""}
          reopen this chat to view it
        </p>
      </div>
    );
  }

  const view = resolved;

  const open = (e) => {
    e.stopPropagation();
    if (!view.available || view.locked) return;
    const postId = view.postId || view.id;
    if (!postId) return;
    navigate(`/${view.authorUsername}/post/${postId}`);
  };

  if (!view.available) {
    return (
      <div className="w-full max-w-[240px] rounded-2xl border border-neutral-700 bg-neutral-900/60 p-3">
        <p className="text-[13px] text-neutral-400">
          This {view.kind === "comment" ? "comment" : "post"} is no longer available
        </p>
        {view.authorUsername && (
          <p className="text-[11px] text-neutral-600 mt-0.5">
            was from @{view.authorUsername}
          </p>
        )}
      </div>
    );
  }

  if (view.locked) {
    return (
      <div className="w-full max-w-[240px] rounded-2xl border border-neutral-700 bg-neutral-900/60 p-3 flex items-start gap-2.5">
        <Lock className="w-4 h-4 text-neutral-500 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-[13px] text-neutral-300">This account is private</p>
          <p className="text-[11px] text-neutral-500 mt-0.5 truncate">
            Follow @{view.authorUsername} to see their posts
          </p>
        </div>
      </div>
    );
  }

  // Legacy shares stored plain URLs; live ones carry typed items. The
  // normaliser flattens both, so the thumbnail knows what it's showing.
  const mediaItems = normalizeMedia(view.media);
  const firstMedia = mediaItems[0];

  return (
    /* A div, not a button: AiLabel is itself a button and nesting them is
       invalid HTML — the inner one stops working in some browsers. */
    <div
      role="button"
      tabIndex={0}
      /*
       * Named, so a screen reader announces what the card is rather than reading
       * out the author, the caption and the media alt text as one run of text with
       * no indication it's a single activatable thing.
       */
      aria-label={`Shared post by ${view.authorUsername || "someone"}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          // Space scrolls the message list by default, so activating the card with
          // it also jumped the thread. Enter needs no preventDefault, but calling
          // it for both keeps the two paths identical.
          e.preventDefault();
          open(e);
        }
      }}
      className="w-full max-w-[240px] text-left rounded-2xl border border-neutral-700 bg-neutral-900/60 overflow-hidden hover:border-neutral-600 transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <img
          src={view.author?.profilePic || view.authorPic || "/default-avatar.png"}
          alt=""
          className="w-6 h-6 rounded-full object-cover bg-neutral-800 shrink-0"
        />
        <span className="text-[12px] font-semibold text-white truncate">
          {view.authorUsername}
        </span>
        {view.author?.isVerified && <Icons.verified />}
        {view.isAiGenerated && (
          <AiLabel compact className="ml-auto" authorUsername={view.authorUsername} />
        )}
      </div>

      {firstMedia && (
        <div className="relative">
          {firstMedia.type === "audio" ? (
            <div className="px-3 pb-2">
              <AudioPlayer item={firstMedia} />
            </div>
          ) : firstMedia.type === "video" ? (
            // A video URL in an <img> renders nothing. `preload="metadata"`
            // gets the first frame without pulling the whole file.
            <>
              <video
                src={firstMedia.url}
                muted
                playsInline
                preload="metadata"
                className="w-full h-[150px] object-cover bg-neutral-800"
              />
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="w-9 h-9 rounded-full bg-black/60 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                </span>
              </span>
            </>
          ) : (
            <img
              src={firstMedia.url}
              alt=""
              className="w-full h-[150px] object-cover bg-neutral-800"
            />
          )}
          {firstMedia.type === "gif" && (
            <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">
              GIF
            </span>
          )}
          {mediaItems.length > 1 && (
            <span className="absolute top-2 right-2 text-[10px] font-semibold bg-black/70 text-white rounded-full px-1.5 py-0.5">
              1/{mediaItems.length}
            </span>
          )}
        </div>
      )}

      {/* Not clamped: posts cap at 500 characters, so the whole thing fits and
          a truncated preview in a chat just makes people tap through. */}
      {view.content && (
        <p
          className={`px-3 pb-2.5 text-[13px] text-neutral-200 whitespace-pre-line break-words ${
            firstMedia ? "pt-2" : ""
          }`}
        >
          {view.content}
        </p>
      )}
    </div>
  );
};

export default SharedPostCard;
