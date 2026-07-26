import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Square, Trash2, Upload } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import { formatDuration } from "../lib/mediaTypes";

/**
 * Records an audio clip for a post or reply, or takes an existing file.
 *
 * The recording half is the same approach as the DM voice notes: MediaRecorder
 * plus a Web Audio AnalyserNode sampling amplitude as it goes. The waveform is
 * captured here rather than computed server-side because the samples are free
 * while recording and expensive afterwards — and it means the player can draw
 * the shape before the file has downloaded.
 */

const MAX_SECONDS = 5 * 60;
// Enough bars to look like a waveform, few enough to store on the document.
const WAVEFORM_BARS = 60;

const pickMimeType = () => {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
};

const AudioRecorderSheet = ({ onDone, onClose }) => {
  const [phase, setPhase] = useState("idle"); // idle | recording | ready | denied
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState([]);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);

  // The finished clip, held in memory until the composer submits it.
  const [clip, setClip] = useState(null); // { blob, url, duration, waveform }

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioCtxRef = useRef(null);
  const rafRef = useRef(null);
  const tickRef = useRef(null);
  const startedAt = useRef(0);
  const levelsRef = useRef([]);
  const playerRef = useRef(null);

  /** Everything that has to be released whether we finish or bail. */
  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    clearInterval(tickRef.current);
    if (recorderRef.current?.state === "recording") {
      try { recorderRef.current.stop(); } catch { /* already stopped */ }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  // A live microphone and an object URL both leak if the sheet is closed
  // mid-recording, so release them on unmount too.
  useEffect(
    () => () => {
      teardown();
      if (clip?.url) URL.revokeObjectURL(clip.url);
    },
    [teardown, clip]
  );

  const startRecording = async () => {
    setError("");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Denial is a normal outcome, not a failure — say what to do about it.
      setPhase("denied");
      setError(
        err?.name === "NotAllowedError"
          ? "Microphone access was blocked. You can allow it in your browser's site settings."
          : "No microphone available."
      );
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    levelsRef.current = [];
    setLevels([]);
    setSeconds(0);

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
      const duration = Math.max(0.1, (Date.now() - startedAt.current) / 1000);
      setClip({
        blob,
        url: URL.createObjectURL(blob),
        duration,
        waveform: levelsRef.current.slice(-WAVEFORM_BARS),
      });
      setPhase("ready");
      teardown();
    };

    // Amplitude sampling for the waveform.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    let lastSample = 0;
    const sample = () => {
      analyser.getByteTimeDomainData(buffer);
      // RMS around the 128 midpoint — a rough loudness, which is all a
      // waveform bar needs.
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const v = (buffer[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buffer.length);

      const now = performance.now();
      // One bar per ~100ms regardless of frame rate, so the waveform's shape
      // doesn't depend on how fast the device renders.
      if (now - lastSample > 100) {
        lastSample = now;
        levelsRef.current.push(Math.min(1, rms * 2.5));
        setLevels(levelsRef.current.slice(-WAVEFORM_BARS));
      }
      rafRef.current = requestAnimationFrame(sample);
    };

    startedAt.current = Date.now();
    recorder.start();
    setPhase("recording");
    rafRef.current = requestAnimationFrame(sample);

    tickRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) stopRecording();
    }, 250);
  };

  const stopRecording = () => {
    clearInterval(tickRef.current);
    cancelAnimationFrame(rafRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const discard = () => {
    if (clip?.url) URL.revokeObjectURL(clip.url);
    setClip(null);
    setPhase("idle");
    setSeconds(0);
    setLevels([]);
    setPlaying(false);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setError("That isn't an audio file");
      return;
    }

    const url = URL.createObjectURL(file);
    // Duration has to be read from the decoded file; without it the player
    // can't show a length until it loads.
    const probe = new Audio(url);
    probe.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
      if (duration > MAX_SECONDS) {
        URL.revokeObjectURL(url);
        setError("Audio clips can be up to 5 minutes");
        return;
      }
      setError("");
      // No waveform for an uploaded file — the player falls back to a plain bar.
      setClip({ blob: file, url, duration, waveform: [] });
      setPhase("ready");
    });
    probe.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      setError("Couldn't read that audio file");
    });
  };

  const togglePlay = () => {
    const el = playerRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const bars = phase === "ready" ? clip.waveform : levels;

  return (
    <ResponsiveSheet title="Add audio" onClose={onClose}>
      {(close) => (
        <div className="flex flex-col px-5 py-6">
          {/* Waveform, or a flat line before anything has been captured. */}
          <div className="flex h-24 items-center justify-center gap-[3px] rounded-xl bg-neutral-800/60 px-4">
            {bars.length === 0 ? (
              <div className="h-[2px] w-full rounded bg-neutral-700" />
            ) : (
              bars.map((level, i) => (
                <div
                  key={i}
                  className={`w-[3px] shrink-0 rounded-full ${
                    phase === "recording" ? "bg-rose-500" : "bg-neutral-400"
                  }`}
                  style={{ height: `${Math.max(3, level * 100)}%` }}
                />
              ))
            )}
          </div>

          <p className="mt-3 text-center text-sm tabular-nums text-neutral-400">
            {phase === "ready"
              ? formatDuration(clip.duration)
              : `${formatDuration(seconds)} / ${formatDuration(MAX_SECONDS)}`}
          </p>

          {error && <p className="mt-3 text-center text-sm text-rose-400">{error}</p>}

          {phase === "ready" && (
            <audio
              ref={playerRef}
              src={clip.url}
              onEnded={() => setPlaying(false)}
              className="hidden"
            />
          )}

          <div className="mt-6 flex items-center justify-center gap-3">
            {phase === "recording" ? (
              <button
                type="button"
                onClick={stopRecording}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white transition-opacity hover:opacity-90 cursor-pointer"
                aria-label="Stop recording"
              >
                <Square className="h-5 w-5 fill-current" />
              </button>
            ) : phase === "ready" ? (
              <>
                <button
                  type="button"
                  onClick={discard}
                  className="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-700 text-neutral-300 transition-colors hover:bg-neutral-800 cursor-pointer"
                  aria-label="Discard and start over"
                >
                  <Trash2 className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={togglePlay}
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black transition-opacity hover:opacity-90 cursor-pointer"
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={startRecording}
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white transition-opacity hover:opacity-90 cursor-pointer"
                  aria-label="Start recording"
                >
                  <Mic className="h-6 w-6" />
                </button>
                <label
                  className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-neutral-700 text-neutral-300 transition-colors hover:bg-neutral-800"
                  title="Upload an audio file"
                >
                  <Upload className="h-5 w-5" />
                  <input type="file" accept="audio/*" onChange={handleFile} className="hidden" />
                </label>
              </>
            )}
          </div>

          <button
            type="button"
            disabled={phase !== "ready"}
            onClick={() => {
              onDone(clip);
              close();
            }}
            className="mt-8 w-full rounded-xl bg-white py-3 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            Attach
          </button>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default AudioRecorderSheet;
