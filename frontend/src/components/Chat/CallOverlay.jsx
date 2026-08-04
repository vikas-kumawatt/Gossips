import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icons } from "../icons";
import { useCall } from "../../contexts/CallContext";
import { lockBodyScroll, unlockBodyScroll } from "../../lib/scrollLock";

/**
 * The call screen: ringing, dialling and in-call.
 *
 * Portalled to `body` and rendered from App, so it survives navigation — a call must
 * not end because you tapped back — and so no page's stacking context can clip it.
 *
 * Mobile-first: this is a full-viewport surface with a single column of 64px controls
 * along the bottom, inside the safe area. The desktop treatment is the same layout with
 * a wider video pane, because a call is a call.
 */

const fmtDuration = (seconds) => {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const hrs = Math.floor(mins / 60);
  return hrs > 0
    ? `${hrs}:${(mins % 60).toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
    : `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

/**
 * A `<video>` bound to a MediaStream.
 *
 * `srcObject` is a property, not an attribute — it cannot be set through JSX, so it has
 * to be assigned to the node. Split into its own component so the assignment effect
 * keys on the stream rather than re-running on every parent render.
 */
const StreamVideo = ({ stream, muted, mirrored, className }) => {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.srcObject = stream || null;
    return () => {
      // Released on unmount so the element doesn't hold the last frame — and, on some
      // browsers, the underlying track — after the call has gone.
      el.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      /*
       * `muted` on the local preview is not cosmetic: playing your own microphone back
       * through the speakers is a feedback loop. The remote video is never muted.
       */
      muted={muted}
      className={`${className} ${mirrored ? "[transform:rotateY(180deg)]" : ""}`}
    />
  );
};

const CallOverlay = () => {
  const {
    phase,
    call,
    peer,
    localStream,
    remoteStream,
    micEnabled,
    cameraEnabled,
    isRemoteVideoLive,
    connectionState,
    acceptCall,
    rejectCall,
    endCall,
    toggleMic,
    toggleCamera,
  } = useCall();

  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(null);

  const isVideo = call?.callType === "video";
  const visible = phase !== "idle";

  useEffect(() => {
    if (!visible) return undefined;
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, [visible]);

  /*
   * The duration clock starts when the call goes active, not when it was placed —
   * ringing time is not call time, and billing-style displays that include it look
   * broken. Wall-clock rather than a counter so a throttled background tab doesn't
   * drift.
   */
  useEffect(() => {
    if (phase !== "active") {
      startedAtRef.current = null;
      setElapsed(0);
      return undefined;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      if (startedAtRef.current) {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  if (!visible) return null;

  const displayName = peer?.name || peer?.username || "Unknown";

  const statusLine = () => {
    if (phase === "incoming") return isVideo ? "Incoming video call" : "Incoming voice call";
    if (phase === "outgoing") return "Ringing…";
    if (phase === "connecting") return "Connecting…";
    if (phase === "active") {
      // `disconnected` is a recoverable blip, so it is surfaced rather than treated as
      // the end of the call — the user should know why the audio just went quiet.
      if (connectionState === "disconnected") return "Reconnecting…";
      return fmtDuration(elapsed);
    }
    return "";
  };

  /* Remote video fills the screen only once there is something to show. */
  const showRemoteVideo = isVideo && remoteStream && isRemoteVideoLive && phase === "active";

  const controlButton =
    "w-14 h-14 rounded-full flex items-center justify-center transition-colors active:scale-95 shrink-0";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${displayName}`}
      className="fixed inset-0 z-[70] bg-neutral-950 text-white flex flex-col"
    >
      {/* ── Stage ── */}
      <div className="relative flex-1 min-h-0 flex flex-col items-center justify-center overflow-hidden">
        {showRemoteVideo ? (
          <StreamVideo
            stream={remoteStream}
            muted={false}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          /*
           * The identity card: shown for a voice call, and for a video call until the
           * far side's video actually arrives. A black rectangle with no explanation is
           * the worst thing to show while a call is connecting.
           */
          <div className="flex flex-col items-center gap-4 px-8 text-center">
            <div className="relative">
              <img
                src={peer?.profilePic || "/default-avatar.png"}
                alt=""
                className="w-28 h-28 rounded-full object-cover border border-white/10"
              />
              {/* A ring that pulses only while ringing, so "waiting" is visible
                  without reading the label. */}
              {(phase === "incoming" || phase === "outgoing") && (
                <span
                  aria-hidden="true"
                  className="absolute -inset-2 rounded-full border-2 border-white/30 animate-pulse"
                />
              )}
            </div>
            <div>
              <h2 className="text-xl font-semibold">{displayName}</h2>
              <p className="text-sm text-neutral-400 mt-1 tabular-nums" role="status">
                {statusLine()}
              </p>
            </div>
          </div>
        )}

        {/* Name and timer over the video, where the card isn't showing them. */}
        {showRemoteVideo && (
          <div className="absolute top-[max(1rem,env(safe-area-inset-top))] left-0 right-0 px-4 flex flex-col items-center pointer-events-none">
            <p className="text-sm font-medium drop-shadow">{displayName}</p>
            <p className="text-xs text-white/70 tabular-nums drop-shadow" role="status">
              {statusLine()}
            </p>
          </div>
        )}

        {/* Local preview: a corner tile, mirrored like a mirror. */}
        {isVideo && localStream && phase !== "incoming" && (
          <div className="absolute bottom-3 right-3 w-24 h-32 sm:w-32 sm:h-44 rounded-2xl overflow-hidden bg-black border border-white/15 shadow-lg">
            {cameraEnabled ? (
              <StreamVideo
                stream={localStream}
                muted
                mirrored
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-neutral-900">
                <Icons.videoOff className="w-6 h-6 text-neutral-500" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Controls ── */}
      <div className="shrink-0 px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {phase === "incoming" ? (
          /*
           * Decline left, accept right, far apart.
           * These are the two highest-stakes buttons in the app and they are pressed
           * without looking, so they are 64px and separated by the full width rather
           * than sitting next to each other where a mis-tap declines a call.
           */
          <div className="flex items-center justify-between max-w-xs mx-auto">
            <button
              type="button"
              onClick={rejectCall}
              aria-label="Decline call"
              className={`${controlButton} bg-red-500 hover:bg-red-600`}
            >
              <Icons.phoneOff className="w-6 h-6" />
            </button>
            <button
              type="button"
              onClick={acceptCall}
              aria-label="Accept call"
              className={`${controlButton} bg-green-500 hover:bg-green-600`}
            >
              {isVideo ? (
                <Icons.videocam className="w-6 h-6" />
              ) : (
                <Icons.phone className="w-6 h-6" />
              )}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={toggleMic}
              aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
              aria-pressed={!micEnabled}
              className={`${controlButton} ${
                micEnabled ? "bg-white/15 hover:bg-white/25" : "bg-white text-black"
              }`}
            >
              {micEnabled ? (
                <Icons.mic className="w-6 h-6" />
              ) : (
                <Icons.micOff className="w-6 h-6" />
              )}
            </button>

            {isVideo && (
              <button
                type="button"
                onClick={toggleCamera}
                aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                aria-pressed={!cameraEnabled}
                className={`${controlButton} ${
                  cameraEnabled ? "bg-white/15 hover:bg-white/25" : "bg-white text-black"
                }`}
              >
                {cameraEnabled ? (
                  <Icons.videocam className="w-6 h-6" />
                ) : (
                  <Icons.videoOff className="w-6 h-6" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={endCall}
              aria-label="End call"
              className={`${controlButton} bg-red-500 hover:bg-red-600`}
            >
              <Icons.phoneOff className="w-6 h-6" />
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default CallOverlay;
