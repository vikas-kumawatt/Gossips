import React, { useState, useEffect, useRef, useMemo } from "react";

/*
 * Instagram-style voice note player bubble.
 *
 * Lived inside UserConversationPage, which meant group threads had no way to render
 * a voice note at all — the group composer has always been able to *send* one
 * (GroupChatPage's uploadVoice path), so those messages were saved and then
 * displayed as nothing. Moved here so both threads share one player.
 */

const VOICE_BUBBLE_GRADIENT = {
  background:
    "linear-gradient(to bottom, #C026D3, #A21CAF, #8B5CF6, #7C3AED, #5B21B6, #4F46E5, #2563EB, #1D4ED8, #C026D3, #A21CAF)",
  backgroundAttachment: "fixed",
};

const VoiceNoteBubble = ({ item, isOwn = false, bubbleRadius = "rounded-[18px]" }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(item.duration || 0);
  const audioRef = useRef(null);

  // Normalise waveform to 0-1 range for 32 display bars
  const waveformBars = useMemo(() => {
    if (item.waveform?.length >= 10) {
      const bars = [];
      const step = item.waveform.length / 32;
      for (let i = 0; i < 32; i++) {
        const val = item.waveform[Math.floor(i * step)] || 0;
        // backend sends 0-1 values; clamp just in case
        bars.push(Math.min(1, Math.max(0, val)));
      }
      return bars;
    }
    return Array.from({ length: 32 }, (_, i) => 0.15 + Math.abs(Math.sin(i * 0.7 + 1)) * 0.65);
  }, [item.waveform]);

  const progress = audioDuration > 0 ? currentTime / audioDuration : 0;

  const togglePlay = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(item.url);
      audioRef.current.onloadedmetadata = () => {
        if (audioRef.current) setAudioDuration(audioRef.current.duration);
      };
      audioRef.current.ontimeupdate = () => {
        if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
      };
      audioRef.current.onended = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
    }
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(console.error);
      setIsPlaying(true);
    }
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, []);

  const fmtTime = (s) => {
    const t = Math.floor(s || 0);
    return `${Math.floor(t / 60).toString().padStart(2, "0")}:${(t % 60).toString().padStart(2, "0")}`;
  };

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-[9px] min-w-[220px] max-w-[260px] ${bubbleRadius} ${
        isOwn ? "" : "bg-[#262626]"
      }`}
      style={isOwn ? VOICE_BUBBLE_GRADIENT : undefined}
    >
      <button
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
        className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center shrink-0 hover:bg-white/30 active:scale-95 transition-all"
      >
        {isPlaying ? (
          /* Pause — two thick rounded bars */
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] text-white">
            <rect x="5" y="4" width="4.5" height="16" rx="2" />
            <rect x="14.5" y="4" width="4.5" height="16" rx="2" />
          </svg>
        ) : (
          /* Play — bold solid teardrop triangle */
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] text-white translate-x-[1px]">
            <path d="M6.5 4.98c0-1.37 1.5-2.17 2.67-1.43l10.6 7.02c1.1.73 1.1 2.33 0 3.06L9.17 20.45C7.99 21.19 6.5 20.39 6.5 19V4.98z" />
          </svg>
        )}
      </button>
      <div className="flex flex-col gap-[5px] flex-1 min-w-0">
        <div className="flex items-center gap-[2.5px] h-[20px]">
          {waveformBars.map((amp, i) => (
            <div
              key={i}
              className={`w-[2px] rounded-full flex-none transition-colors duration-75 ${
                i / waveformBars.length < progress ? "bg-white" : "bg-white/30"
              }`}
              style={{ height: `${Math.max(3, amp * 18)}px` }}
            />
          ))}
        </div>
        <span className="text-[11px] text-white/50 leading-none tabular-nums">
          {isPlaying || currentTime > 0 ? fmtTime(currentTime) : fmtTime(audioDuration)}
        </span>
      </div>
    </div>
  );
};

export default VoiceNoteBubble;
