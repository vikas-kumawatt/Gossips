import React from "react";
import { Icons } from "../icons";

/**
 * A finished call, in the thread.
 *
 * Call logs have always been written to the database — `messageType: "call"` with a
 * `call` subdocument — and nothing on the client rendered them. `getMessageBody`
 * returns `message.content || ""` and a call log has no content, so every call in
 * every conversation was an empty bubble with a timestamp.
 *
 * Deliberately quiet: this is a record, not a message. It reads as a line of history
 * rather than something someone said, which is why it is centred, dimmed and has no
 * gradient — the same treatment a system notice gets.
 */

const fmtDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
};

const CallLogBubble = ({ call, isOwn }) => {
  const isVideo = call?.type === "video";
  const status = call?.status;

  /*
   * "Missed" is the callee's word for it. The same row is an *unanswered* call to the
   * person who placed it — telling the caller they "missed" a call they made is
   * nonsense, and it's the one label people read closely.
   */
  const label = (() => {
    if (status === "answered") {
      return isVideo ? "Video call" : "Voice call";
    }
    if (status === "rejected") return isOwn ? "Call declined" : "Call declined";
    return isOwn ? "No answer" : `Missed ${isVideo ? "video" : "voice"} call`;
  })();

  const missed = status !== "answered";

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 min-w-[170px] max-w-[260px] rounded-2xl bg-white/[0.06] border border-white/10">
      <span
        aria-hidden="true"
        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
          missed ? "bg-red-500/15 text-red-400" : "bg-white/10 text-white/80"
        }`}
      >
        {isVideo ? (
          <Icons.videocam className="w-4 h-4" />
        ) : (
          <Icons.phone className="w-4 h-4" />
        )}
      </span>
      <div className="min-w-0">
        <p className={`text-[13.5px] font-medium ${missed ? "text-red-400" : "text-white/90"}`}>
          {label}
        </p>
        {/* Only for a call that actually happened — a duration on a missed call would
            be 0s, which reads as a bug. */}
        {status === "answered" && call?.duration > 0 && (
          <p className="text-[11px] text-white/45 tabular-nums">
            {fmtDuration(call.duration)}
          </p>
        )}
      </div>
    </div>
  );
};

export default CallLogBubble;
