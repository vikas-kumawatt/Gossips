import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icons } from "../icons";
import { lockBodyScroll, unlockBodyScroll } from "../../lib/scrollLock";

/*
 * Chat video: a silent thumbnail in the thread, a purpose-built player over it.
 *
 * The bubble used to be a bare `<video controls>`. That put the browser's own
 * control strip inside the bubble — a play button, a scrubber, a volume slider and
 * a "more options" kebab offering Download and Picture-in-Picture — all of it
 * rendered at whatever size the UA felt like, overlapping the 260px bubble, and
 * styled nothing like the rest of the app. Chrome's kebab in particular exposes
 * "Download" on a Cloudinary URL, which is a different (and unauthenticated) path
 * to media than the one the app offers.
 *
 * So: no `controls` on the bubble. Tapping opens a full-screen player whose chrome
 * we own — scrubber, play/pause, time remaining, close. A corner badge marks the
 * bubble as a video, because without a control strip a paused first frame is
 * otherwise indistinguishable from a photo.
 */

const fmtTime = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

const IMAGE_URL = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;

/**
 * A `poster` only when there is a real image to use.
 *
 * The upload handler now stores a generated Cloudinary still for videos, so new
 * messages arrive with a genuine .jpg here. This guard is what makes the change
 * safe for everything already in the database: those messages were stored when
 * `thumbnail` fell back to `secure_url`, so their `thumbnail` is the .mp4 itself.
 * Handing that to `poster` is worse than handing it nothing — the browser commits
 * to a poster, fails to decode it as an image, and paints an empty box rather than
 * falling back to the first frame.
 *
 * A poster URL that 404s is fine, by contrast: the spec falls back to the first
 * frame on a failed *download*. It's the 200-that-isn't-an-image that breaks. So
 * this only has to reject non-images, not verify they load.
 *
 * With no poster, `preload="metadata"` paints frame one — the same trick, and the
 * same reasoning, as the video tile in SharedPostCard.
 */
const posterFor = (item) => {
  const thumb = item?.thumbnail;
  if (!thumb || thumb === item?.url) return undefined;
  return IMAGE_URL.test(thumb) ? thumb : undefined;
};

/** The full-screen player. Portalled to `body` so no bubble's stacking context can clip it. */
const VideoPlayerOverlay = ({ src, poster, onClose }) => {
  const videoRef = useRef(null);
  const dialogRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, []);

  /*
   * Focus moves into the dialog on open, and back out is the caller's business.
   * Without this the thread behind keeps focus and Tab walks content the user
   * can't see — the same gap the image lightbox had (#155).
   */
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  /*
   * Autoplay. Opening the player is a click, so this counts as user activation and
   * is allowed to play with sound — but a rejected promise still has to leave the
   * button showing the true state rather than a play icon over a playing video.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.play().then(
      () => setIsPlaying(true),
      () => setIsPlaying(false)
    );
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(
        () => setIsPlaying(true),
        () => setIsPlaying(false)
      );
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  const handleSeek = (event) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(duration) || duration <= 0) return;
    const next = (Number(event.target.value) / 1000) * duration;
    video.currentTime = next;
    setCurrentTime(next);
  };

  const remaining = duration > 0 ? Math.max(0, duration - currentTime) : 0;
  const progressValue = duration > 0 ? Math.round((currentTime / duration) * 1000) : 0;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Video player"
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-[60] bg-black flex items-center justify-center"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          return;
        }
        // Space is the conventional play/pause key, but only when focus isn't
        // already on a control that uses it for something else.
        if (event.key === " " && event.target === dialogRef.current) {
          event.preventDefault();
          togglePlay();
        }
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close video"
        // 44px, the minimum touch target, clear of the notch on iOS.
        className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 w-11 h-11 rounded-full bg-black/60 backdrop-blur flex items-center justify-center text-white hover:bg-black/80 transition-colors z-10"
      >
        <Icons.close className="w-5 h-5" />
      </button>

      {/*
        The video itself is the play/pause target, which is what people expect from
        a full-screen player. It carries no `controls`: the strip below is ours.
      */}
      <video
        ref={videoRef}
        src={src}
        poster={poster || undefined}
        playsInline
        onClick={togglePlay}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        className="max-w-full max-h-full w-auto h-auto"
      >
        Your browser does not support video.
      </video>

      {/* Control strip */}
      <div className="absolute bottom-0 left-0 right-0 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8 px-4 bg-gradient-to-t from-black/80 to-transparent flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center shrink-0 text-white transition-colors active:scale-95"
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px]">
              <rect x="5" y="4" width="4.5" height="16" rx="2" />
              <rect x="14.5" y="4" width="4.5" height="16" rx="2" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-[18px] h-[18px] translate-x-[1px]"
            >
              <path d="M6.5 4.98c0-1.37 1.5-2.17 2.67-1.43l10.6 7.02c1.1.73 1.1 2.33 0 3.06L9.17 20.45C7.99 21.19 6.5 20.39 6.5 19V4.98z" />
            </svg>
          )}
        </button>

        {/*
          A range input rather than a hand-rolled div: it is draggable, keyboard
          operable and announced as a slider for free. 1000 steps keeps seeking
          smooth on a long clip without depending on the duration being known
          at mount.
        */}
        <input
          type="range"
          min={0}
          max={1000}
          value={progressValue}
          onChange={handleSeek}
          aria-label="Seek"
          className="flex-1 h-1 accent-white cursor-pointer"
        />

        <span className="text-[12px] text-white/80 tabular-nums shrink-0 min-w-[42px] text-right">
          -{fmtTime(remaining)}
        </span>
      </div>
    </div>,
    document.body
  );
};

const ChatVideoBubble = ({ item, cornerClass = "rounded-[18px]" }) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef(null);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    // Focus returns to the bubble that opened the player, so a keyboard user
    // doesn't land back at the top of the thread.
    triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={item.caption ? `Play video: ${item.caption}` : "Play video"}
        className="relative block w-fit"
      >
        {/*
          `preload="metadata"` is what paints the first frame, which is the whole
          reason there is usually no `poster` here (see posterFor above) — with
          `preload="none"` the bubble is an empty black box. `muted` matters even
          though nothing is playing: iOS will not render a frame for an unmuted
          video it hasn't been told it may load.

          `min-w`/`min-h` because a `<video>` with no metadata yet and `w-auto` has
          no intrinsic size to lay out, so the bubble would collapse to nothing
          before the first byte arrives and the badges would have no box to sit in.
        */}
        <video
          src={item.url}
          poster={posterFor(item)}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          width={item.dimensions?.width || undefined}
          height={item.dimensions?.height || undefined}
          className={`block max-w-[260px] max-h-[340px] min-w-[160px] min-h-[120px] w-auto h-auto bg-black/40 pointer-events-none ${cornerClass}`}
        >
          Your browser does not support video.
        </video>

        {/*
          The badge: icon only. Without a control strip a paused frame reads as a
          photo, and this is the only thing that says otherwise.

          No duration here. It competed with the centre play button for the same
          job, and a runtime is not what you need before you've decided to watch —
          the player shows time remaining once you're in it.
        */}
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 flex items-center justify-center w-6 h-6 rounded-full bg-black/55 backdrop-blur-sm text-white pointer-events-none"
        >
          <Icons.videocam className="w-3.5 h-3.5" />
        </span>

        {/* Centre play affordance, so the bubble reads as something you activate. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
        >
          <span className="w-12 h-12 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-6 h-6 text-white translate-x-[1px]"
            >
              <path d="M6.5 4.98c0-1.37 1.5-2.17 2.67-1.43l10.6 7.02c1.1.73 1.1 2.33 0 3.06L9.17 20.45C7.99 21.19 6.5 20.39 6.5 19V4.98z" />
            </svg>
          </span>
        </span>
      </button>

      {isOpen && (
        <VideoPlayerOverlay
          src={item.url}
          poster={posterFor(item)}
          onClose={handleClose}
        />
      )}
    </>
  );
};

export default ChatVideoBubble;
