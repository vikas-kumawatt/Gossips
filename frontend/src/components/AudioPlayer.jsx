import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { formatDuration } from "../lib/mediaTypes";

/**
 * Plays an audio attachment.
 *
 * Two things it deliberately doesn't do: autoplay (a feed of talking posts is
 * unusable), and play alongside another clip. A module-level registry stops
 * the previous one when a new one starts, which is simpler and more reliable
 * than threading a context through every card.
 */

// The element currently playing, app-wide.
let activePlayer = null;

const BARS = 48;

/**
 * Resamples the recorded waveform to a fixed bar count so every clip renders
 * the same width. Uploaded files have no waveform, so they get a flat bar.
 */
const toBars = (waveform) => {
  if (!Array.isArray(waveform) || waveform.length === 0) {
    return Array.from({ length: BARS }, () => 0.35);
  }
  if (waveform.length === BARS) return waveform;

  const step = waveform.length / BARS;
  return Array.from({ length: BARS }, (_, i) => {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    const slice = waveform.slice(start, end);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
};

const AudioPlayer = ({ item }) => {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // The file's own duration once known; the stored one is a good enough
  // placeholder until then.
  const [duration, setDuration] = useState(item?.duration || 0);

  const bars = toBars(item?.waveform);
  const progress = duration ? Math.min(1, elapsed / duration) : 0;

  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (activePlayer === el) activePlayer = null;
    };
  }, []);

  const toggle = (e) => {
    // The card underneath navigates to the post; playing audio shouldn't.
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;

    if (el.paused) {
      if (activePlayer && activePlayer !== el) activePlayer.pause();
      activePlayer = el;
      el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  };

  /** Scrub by clicking the waveform. */
  const seek = (e) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setElapsed(el.currentTime);
  };

  return (
    <div
      className="mb-3 flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <audio
        ref={audioRef}
        src={item.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={(e) => {
          setPlaying(false);
          if (activePlayer === e.currentTarget) activePlayer = null;
        }}
        onEnded={() => {
          setPlaying(false);
          setElapsed(0);
        }}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          // Infinity turns up for streamed webm until it's fully buffered.
          if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black transition-opacity hover:opacity-90 cursor-pointer"
        aria-label={playing ? "Pause audio" : "Play audio"}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(elapsed)}
        onClick={seek}
        onKeyDown={(e) => {
          const el = audioRef.current;
          if (!el || !duration) return;
          if (e.key === "ArrowRight") el.currentTime = Math.min(duration, el.currentTime + 5);
          if (e.key === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 5);
        }}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-[2px]"
      >
        {bars.map((level, i) => (
          <div
            key={i}
            className={`flex-1 rounded-full transition-colors ${
              i / bars.length <= progress ? "bg-white" : "bg-neutral-600"
            }`}
            style={{ height: `${Math.max(10, level * 100)}%` }}
          />
        ))}
      </div>

      <span className="shrink-0 text-[12px] tabular-nums text-neutral-400">
        {formatDuration(playing || elapsed ? duration - elapsed : duration)}
      </span>
    </div>
  );
};

export default AudioPlayer;
