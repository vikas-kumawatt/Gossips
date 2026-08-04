import React from "react";
import { Icons } from "../icons";
import { formatClock } from "../../lib/chatMessage";

/**
 * The composer's two voice states: recording, and reviewing what you recorded.
 *
 * Both threads need these and only the DM page had them, which is why the group
 * composer's microphone button did nothing visible. Moved verbatim so the bars look
 * and behave identically rather than approximately.
 *
 * Driven entirely by `useVoiceRecorder` — this component holds no state, so the two
 * pages can't drift in how a recording behaves either.
 */
const VoiceComposerBar = ({
  isRecording,
  recordingTime,
  liveWaveform,
  preview,
  previewTime,
  previewProgress,
  isPreviewPlaying,
  idleWaveform,
  sending,
  onCancelRecording,
  onStopRecording,
  onTogglePlay,
  onDiscardPreview,
  onSend,
}) => {
  // Nothing to show unless we're recording or holding a clip.
  if (!isRecording && !preview) return null;

  return (
    <>
      {isRecording ? (
                      <div className="flex items-center gap-2.5 mx-3 px-3 py-2 bg-[#0095F6] rounded-full">
              {/* Delete / cancel */}
              <button
                onClick={onCancelRecording}
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
                onClick={onStopRecording}
                className="shrink-0 w-8 h-8 bg-white rounded-full flex items-center justify-center ml-1 cursor-pointer active:scale-95 transition-transform"
                aria-label="Stop recording"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-[#0095F6]">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              </button>
            </div>

          ) : preview ? (
          /* ── Voice preview bar ── */
            <div className="flex items-center gap-2.5 mx-3 px-3 py-2 bg-[#0095F6] rounded-full">
              {/* Delete */}
              <button
                onClick={onDiscardPreview}
                className="shrink-0 p-1 text-white/80 hover:text-red-400 cursor-pointer transition-colors"
                aria-label="Delete voice note"
              >
                <Icons.trash className="w-5 h-5" />
              </button>

              {/* Play / Pause preview */}
              <button
                onClick={onTogglePlay}
                className="shrink-0 w-7 h-7 flex items-center justify-center text-white cursor-pointer"
                aria-label={isPreviewPlaying ? "Pause" : "Play"}
              >
                {isPreviewPlaying ? (
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
                    preview.waveformSnapshot?.length > 0
                      ? preview.waveformSnapshot
                      : idleWaveform;
                  return bars.map((amp, i) => (
                    <div
                      key={i}
                      // Played bars are solid, the rest are dimmed — the same
                      // treatment the sent bubble gives them.
                      className={`w-[2.5px] rounded-full shrink-0 transition-colors duration-75 ${
                        i / bars.length < previewProgress
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
                It was bound to `preview.duration` and so never moved, which made
                a playing clip indistinguishable from a stopped one.
              */}
              <span className="text-white text-[13px] font-semibold tabular-nums shrink-0 min-w-[38px] text-right">
                {formatClock(
                  isPreviewPlaying || previewTime > 0
                    ? previewTime
                    : preview.duration
                )}
              </span>

              {/* Send */}
              <button
                onClick={onSend}
                disabled={sending}
                className="shrink-0 w-8 h-8 bg-white rounded-full flex items-center justify-center ml-1 cursor-pointer active:scale-95 transition-transform disabled:opacity-60"
                aria-label="Send voice note"
              >
                {sending ? (
                  <Icons.spinner className="w-4 h-4 text-[#0095F6] animate-spin" />
                ) : (
                  <Icons.send className="w-4 h-4 text-[#0095F6]" />
                )}
              </button>
            </div>
      ) : null}
    </>
  );
};

export default VoiceComposerBar;
