import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icons } from "../icons";
import { lockBodyScroll, unlockBodyScroll } from "../../lib/scrollLock";

/**
 * Full-screen video player with chrome we own.
 *
 * Extracted from ChatVideoBubble so every full-screen video in the app uses it. The
 * message bubble had already dropped native `controls`, but the two *lightboxes* —
 * the composer's selected-media preview and the shared-media gallery's MediaModal —
 * still rendered `<video controls autoPlay>`, so opening a video from either place
 * brought back the browser's own strip: a UA-styled scrubber, a volume slider, and a
 * kebab menu offering Download and Picture-in-Picture on a raw Cloudinary URL.
 *
 * Portalled to `body` so no ancestor's stacking context or `overflow` can clip it.
 */

const fmtTime = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

const VideoPlayerOverlay = ({ src, poster, onClose }) => {
  const videoRef = useRef(null);
  const dialogRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  /* Hidden while dragging, so the thumb doesn't fight `ontimeupdate`. */
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => {
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, []);

  /*
   * Focus moves into the dialog on open, and back out is the caller's business.
   * Without this whatever is behind keeps focus and Tab walks content the user
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

  const seekTo = (fraction) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(duration) || duration <= 0) return;
    const next = Math.min(duration, Math.max(0, fraction * duration));
    video.currentTime = next;
    setCurrentTime(next);
  };

  /** How much is downloaded, for the dim band behind the played portion. */
  const readBuffered = (video) => {
    if (!video?.buffered?.length || !duration) return;
    setBuffered(Math.min(1, video.buffered.end(video.buffered.length - 1) / duration));
  };

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const pct = (n) => `${(n * 100).toFixed(3)}%`;

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
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          setDuration(Number.isFinite(value) ? value : 0);
          readBuffered(event.currentTarget);
        }}
        onTimeUpdate={(event) => {
          if (!scrubbing) setCurrentTime(event.currentTarget.currentTime || 0);
        }}
        onProgress={(event) => readBuffered(event.currentTarget)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        className="max-w-full max-h-full w-auto h-auto"
      >
        Your browser does not support video.
      </video>

      {/* Control strip */}
      <div className="absolute bottom-0 left-0 right-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 px-3 sm:px-5 bg-gradient-to-t from-black/85 via-black/45 to-transparent">
        {/*
          The scrubber, as a track we draw plus a range input laid over it.
          A bare `<input type="range">` is styled entirely by UA pseudo-elements, so
          it can't show buffered progress and looked like a system widget dropped onto
          the player. The visible track is three stacked layers — rail, buffered,
          played — and the input sits on top at full size, transparent, so dragging,
          keyboard control and the accessible slider role all still come from it.
        */}
        <div className="relative h-11 flex items-center">
          <div className="absolute inset-x-0 h-1 rounded-full bg-white/25 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-white/30"
              style={{ width: pct(buffered) }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-white"
              style={{ width: pct(progress) }}
            />
          </div>
          {/* The handle. Grows while dragging so it stays visible under a thumb. */}
          <div
            aria-hidden="true"
            className={`absolute rounded-full bg-white shadow pointer-events-none transition-[width,height] duration-100 ${
              scrubbing ? "w-4 h-4" : "w-3 h-3"
            }`}
            style={{ left: pct(progress), transform: "translateX(-50%)" }}
          />
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onChange={(event) => seekTo(Number(event.target.value) / 1000)}
            onPointerDown={() => setScrubbing(true)}
            onPointerUp={() => setScrubbing(false)}
            onPointerCancel={() => setScrubbing(false)}
            onBlur={() => setScrubbing(false)}
            aria-label="Seek"
            aria-valuetext={`${fmtTime(currentTime)} of ${fmtTime(duration)}`}
            className="video-scrubber absolute inset-0 w-full h-11 cursor-pointer"
          />
        </div>

        <div className="flex items-center gap-3 -mt-1">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="w-11 h-11 -ml-2 rounded-full flex items-center justify-center shrink-0 text-white hover:bg-white/10 active:scale-95 transition"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <rect x="5" y="4" width="4.5" height="16" rx="2" />
                <rect x="14.5" y="4" width="4.5" height="16" rx="2" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-5 h-5 translate-x-[1px]"
              >
                <path d="M6.5 4.98c0-1.37 1.5-2.17 2.67-1.43l10.6 7.02c1.1.73 1.1 2.33 0 3.06L9.17 20.45C7.99 21.19 6.5 20.39 6.5 19V4.98z" />
              </svg>
            )}
          </button>

          {/* Elapsed and total, rather than a bare countdown — a countdown alone
              never tells you how long the thing is. */}
          <span className="text-[12px] text-white tabular-nums">
            {fmtTime(currentTime)}
          </span>
          <span className="text-[12px] text-white/50 tabular-nums">
            / {fmtTime(duration)}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default VideoPlayerOverlay;
