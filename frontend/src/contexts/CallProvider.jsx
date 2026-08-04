import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { useSocket } from "./useSocket";
import { UserContext } from "./UserContext";
import { CallContext } from "./CallContext";
import { chatAPI } from "../services/api";

/**
 * One 1:1 WebRTC call, and the signalling that sets it up.
 *
 * The server already had the whole call lifecycle — `initiateCall` / `answerCall` /
 * `rejectCall` / `endCall`, a ring timeout, blocks and `whoCanCall`, plus an
 * authenticated `iceCandidate` / `rtcOffer` / `rtcAnswer` relay. Nothing on the client
 * had ever spoken to it: no `RTCPeerConnection` existed anywhere in the app and the
 * two call buttons in the chat header had empty handlers.
 *
 * Held above the router so a call survives navigation. Ringing has to reach you
 * wherever you are in the app, and answering a call must not be interrupted by
 * changing route — which is why this provider is not inside the chat pages.
 *
 * ── The handshake ────────────────────────────────────────────────────────────
 * The initial offer and answer do *not* travel over `rtcOffer`/`rtcAnswer`. They ride
 * inside `initiateCall` and `answerCall`, because the offer has to exist before there
 * is a call to relay it through. `rtcOffer`/`rtcAnswer` are for renegotiation of an
 * established call. Getting this backwards produces a call that rings and never
 * connects, so:
 *
 *   caller                                  callee
 *   getUserMedia
 *   createOffer  ──initiateCall(offer)──▶    (server rings every socket)
 *                                            incomingCall{offer}
 *                                            getUserMedia on accept
 *                                            setRemoteDescription(offer)
 *                                            createAnswer
 *   callAnswered{answer}  ◀──answerCall(answer)──
 *   setRemoteDescription(answer)
 *   ◀────────────── iceCandidate (both ways, trickle) ──────────────▶
 */

/** Nothing is a legitimate call once this long has passed with no media. */
const CONNECT_TIMEOUT_MS = 30_000;

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/*
 * `facingMode: "user"` and a modest cap.
 *
 * Mobile-first: an uncapped request on a phone hands back the rear camera's full
 * sensor resolution, which is both the wrong camera for a call and more pixels than
 * the encoder or the network want. `ideal` rather than `exact` so a device that can't
 * oblige still returns a track instead of throwing.
 */
const VIDEO_CONSTRAINTS = {
  facingMode: "user",
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 30, max: 30 },
};

export const CallProvider = ({ children }) => {
  const { socket, isConnected } = useSocket();
  const { userAuth } = useContext(UserContext);

  const [phase, setPhase] = useState("idle");
  const [call, setCall] = useState(null);
  const [peer, setPeer] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [isRemoteVideoLive, setIsRemoteVideoLive] = useState(false);
  const [connectionState, setConnectionState] = useState("new");
  const [error, setError] = useState(null);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const callRef = useRef(null);
  const socketRef = useRef(socket);
  socketRef.current = socket;

  /*
   * Candidates that arrived before the remote description did.
   *
   * `addIceCandidate` throws if there is no remote description yet, and the relay is
   * fast enough that the callee's first candidates routinely beat the caller's
   * `callAnswered`. Dropping them silently costs the connection on restrictive
   * networks, where the one candidate that would have worked is often an early one.
   */
  const pendingCandidatesRef = useRef([]);
  const connectTimerRef = useRef(null);

  callRef.current = call;

  /**
   * Set the current call in state *and* in the ref, in one step.
   *
   * `callRef.current = call` above only catches up on the next render, and the
   * signalling handlers read the ref — so between `initiateCall` being acked and React
   * committing, an arriving `callAnswered` would find `callRef.current` null, fail its
   * `callId` check and be dropped. The caller would then ring until the timeout with an
   * answer it had already been handed. Writing both closes that window.
   */
  const setActiveCall = useCallback((next) => {
    callRef.current = next;
    setCall(next);
  }, []);

  /*
   * The phase in a ref as well as in state.
   *
   * The signalling effect needs it — an incoming call while already busy has to be
   * declined — but putting it in the dependency array re-registers eight socket
   * listeners on every phase transition, mid-handshake. Same reasoning as
   * ChatProvider's socketRef: written during render, because a socket event can arrive
   * before effects have run.
   */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // ── Teardown ──────────────────────────────────────────────────────────────

  const stopLocalStream = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  /**
   * Return to idle and release the hardware.
   *
   * Every exit runs through here — hang-up, rejection, timeout, the peer
   * disconnecting, an error while dialling. A missed path leaves the camera light on,
   * which users read (correctly) as still being in a call.
   */
  const teardown = useCallback(() => {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (pcRef.current) {
      // Handlers detached before close: `close()` fires a final state change, and a
      // handler that runs during teardown re-enters it.
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      try {
        pcRef.current.close();
      } catch {
        // Already closed; nothing to do.
      }
      pcRef.current = null;
    }
    pendingCandidatesRef.current = [];
    stopLocalStream();
    setRemoteStream(null);
    setIsRemoteVideoLive(false);
    setConnectionState("closed");
    setMicEnabled(true);
    setCameraEnabled(true);
    setActiveCall(null);
    setPeer(null);
    setPhase("idle");
  }, [stopLocalStream, setActiveCall]);

  // ── Media + peer connection ───────────────────────────────────────────────

  const getMedia = useCallback(async (callType) => {
    /*
     * `getUserMedia` only exists on a secure origin. Without this check the failure is
     * a bare TypeError on `undefined`, which reads as a bug rather than as "this needs
     * https" — the same guard QRScannerSheet already makes.
     */
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Calling needs a secure (https) connection");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: callType === "video" ? VIDEO_CONSTRAINTS : false,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  /**
   * @param getCallId Called each time a candidate is gathered, rather than taking the
   *   id up front: the caller doesn't *have* an id until the server acks
   *   `initiateCall`, and that ack can't be requested until the offer exists, which
   *   requires this connection. A getter closes that circle without a second
   *   assignment to `onicecandidate` after the fact.
   */
  const createPeerConnection = useCallback(async (getCallId, stream) => {
    /*
     * ICE config from the server, per call.
     *
     * Not a constant in the bundle: TURN credentials are a bandwidth bill and most
     * providers issue short-lived ones. If the request fails we still try with public
     * STUN rather than refusing to dial — a call that works on home wifi beats no call.
     */
    let config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    try {
      const fetched = await chatAPI.getCallIceServers();
      if (Array.isArray(fetched?.iceServers) && fetched.iceServers.length) {
        config = {
          iceServers: fetched.iceServers,
          iceTransportPolicy: fetched.iceTransportPolicy || "all",
        };
      }
    } catch (fetchError) {
      console.error("Falling back to default STUN:", fetchError);
    }

    const pc = new RTCPeerConnection(config);
    pcRef.current = pc;

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      // A null candidate marks the end of gathering; there is nothing to relay.
      if (!event.candidate) return;
      const callId = getCallId();
      // No id yet means the server hasn't acked `initiateCall`. The candidate is
      // buffered by the local agent and re-offered, so dropping it here is safe.
      if (!callId) return;
      socketRef.current?.emit("iceCandidate", {
        callId,
        candidate: event.candidate.toJSON(),
      });
    };

    /*
     * One MediaStream, mutated as tracks arrive.
     *
     * Audio and video arrive as separate `track` events, so building a new stream per
     * event would swap the `<video>` element's source mid-call and drop the audio that
     * came first. `event.streams[0]` is the same object for both, so prefer it.
     */
    pc.ontrack = (event) => {
      const incoming = event.streams?.[0];
      if (incoming) {
        setRemoteStream(incoming);
      } else {
        setRemoteStream((previous) => {
          const next = previous || new MediaStream();
          next.addTrack(event.track);
          return next;
        });
      }
      if (event.track.kind === "video") {
        setIsRemoteVideoLive(true);
        event.track.addEventListener("mute", () => setIsRemoteVideoLive(false));
        event.track.addEventListener("unmute", () => setIsRemoteVideoLive(true));
        event.track.addEventListener("ended", () => setIsRemoteVideoLive(false));
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setConnectionState(state);
      if (state === "connected") {
        if (connectTimerRef.current) {
          clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        setPhase("active");
      }
      /*
       * `failed` is terminal — ICE has exhausted every candidate pair — so it ends the
       * call. `disconnected` is not: it is often a few seconds of bad network that
       * recovers on its own, and tearing down on it drops calls that would have
       * continued.
       */
      if (state === "failed") {
        toast.error("Call connection failed");
        const callId = getCallId();
        if (callId) socketRef.current?.emit("endCall", { callId });
        teardown();
      }
    };

    return pc;
  }, [teardown]);

  /** Flush candidates buffered while there was no remote description. */
  const drainPendingCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (addError) {
        // One bad candidate must not abort the rest: they are independent paths.
        console.error("Failed to add buffered ICE candidate:", addError);
      }
    }
  }, []);

  const armConnectTimeout = useCallback((callId) => {
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = setTimeout(() => {
      if (pcRef.current?.connectionState === "connected") return;
      toast.error("Couldn't connect the call");
      socketRef.current?.emit("endCall", { callId });
      teardown();
    }, CONNECT_TIMEOUT_MS);
  }, [teardown]);

  // ── Outgoing ──────────────────────────────────────────────────────────────

  /**
   * Dial someone.
   * @param target `{_id, username, name, profilePic}` — the person, for the ring UI.
   * @param callType "voice" | "video"
   */
  const startCall = useCallback(
    async (target, callType = "voice") => {
      if (!target?._id) return;
      if (phase !== "idle") {
        toast.error("You're already in a call");
        return;
      }
      if (!socketRef.current || !isConnected) {
        toast.error("You're offline — reconnect to place a call");
        return;
      }

      setError(null);
      setPeer(target);
      setPhase("outgoing");
      setCameraEnabled(callType === "video");

      let stream;
      try {
        stream = await getMedia(callType);
      } catch (mediaError) {
        console.error("Media error:", mediaError);
        setPhase("idle");
        setPeer(null);
        toast.error(
          mediaError?.name === "NotAllowedError"
            ? callType === "video"
              ? "Camera and microphone access is required"
              : "Microphone access is required"
            : mediaError?.message || "Couldn't access your microphone"
        );
        return;
      }

      /*
       * The peer connection and the offer are built *before* `initiateCall`, because
       * the server's payload carries the offer — the callee needs it in the same
       * message that rings their phone. Which means the call id doesn't exist yet, so
       * the connection is given a getter that starts returning it once the ack lands.
       */
      let pendingCallId = null;
      try {
        const pc = await createPeerConnection(() => pendingCallId, stream);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const reply = await socketRef.current
          .timeout(15000)
          .emitWithAck("initiateCall", {
            receiverId: target._id,
            callType,
            offer: { type: offer.type, sdp: offer.sdp },
          });

        if (reply?.ok === false) throw new Error(reply.error || "Couldn't start the call");

        pendingCallId = reply?.callId || null;
        if (!pendingCallId) throw new Error("Couldn't start the call");

        setActiveCall({ callId: pendingCallId, callType, isCaller: true });
        armConnectTimeout(pendingCallId);
      } catch (signalError) {
        console.error("Call setup failed:", signalError);
        toast.error(signalError?.message || "Couldn't start the call");
        teardown();
      }
    },
    [phase, isConnected, getMedia, createPeerConnection, armConnectTimeout, teardown, setActiveCall]
  );

  // ── Incoming ──────────────────────────────────────────────────────────────

  const acceptCall = useCallback(async () => {
    const incoming = callRef.current;
    if (!incoming?.callId || phase !== "incoming") return;

    setPhase("connecting");
    setCameraEnabled(incoming.callType === "video");

    try {
      const stream = await getMedia(incoming.callType);
      // The id is known up front on this side, so the getter is a constant.
      const pc = await createPeerConnection(() => incoming.callId, stream);

      await pc.setRemoteDescription(new RTCSessionDescription(incoming.offer));
      await drainPendingCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current?.emit("answerCall", {
        callId: incoming.callId,
        answer: { type: answer.type, sdp: answer.sdp },
      });
      armConnectTimeout(incoming.callId);
    } catch (acceptError) {
      console.error("Failed to answer call:", acceptError);
      toast.error(
        acceptError?.name === "NotAllowedError"
          ? "Microphone access is required"
          : acceptError?.message || "Couldn't answer the call"
      );
      // Declined rather than left ringing: the caller must not wait out the timeout
      // because our microphone was refused.
      socketRef.current?.emit("rejectCall", { callId: incoming.callId });
      teardown();
    }
  }, [phase, getMedia, createPeerConnection, drainPendingCandidates, armConnectTimeout, teardown]);

  const rejectCall = useCallback(() => {
    const incoming = callRef.current;
    if (incoming?.callId) {
      socketRef.current?.emit("rejectCall", { callId: incoming.callId });
    }
    teardown();
  }, [teardown]);

  const endCall = useCallback(() => {
    const current = callRef.current;
    if (current?.callId) {
      socketRef.current?.emit("endCall", { callId: current.callId });
    }
    teardown();
  }, [teardown]);

  // ── Controls ──────────────────────────────────────────────────────────────

  /*
   * `track.enabled`, not removing the track.
   *
   * Disabling keeps the transceiver in place and sends silence, so unmuting is
   * instant. Removing a track forces a renegotiation, which on a bad connection can
   * take longer than the mute lasted.
   */
  const toggleMic = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() || [];
    if (!tracks.length) return;
    const next = !tracks[0].enabled;
    tracks.forEach((track) => {
      track.enabled = next;
    });
    setMicEnabled(next);
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = localStreamRef.current?.getVideoTracks() || [];
    if (!tracks.length) return;
    const next = !tracks[0].enabled;
    tracks.forEach((track) => {
      track.enabled = next;
    });
    setCameraEnabled(next);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  // ── Signalling listeners ──────────────────────────────────────────────────

  useEffect(() => {
    if (!socket || !isConnected) return undefined;

    const handleIncomingCall = (payload) => {
      /*
       * Busy: decline immediately rather than letting it ring out.
       *
       * The server only reserves a callee once they have *answered*, deliberately — so
       * a second caller can still reach someone who is mid-call, and it is the client
       * that has to say no. Rejecting rather than ignoring means the other person gets
       * "declined" now instead of forty-five seconds of ringing.
       */
      if (phaseRef.current !== "idle") {
        socket.emit("rejectCall", { callId: payload?.callId });
        return;
      }
      setActiveCall({
        callId: payload.callId,
        callType: payload.callType,
        offer: payload.offer,
        isCaller: false,
      });
      setPeer({
        _id: payload.caller,
        username: payload.callerInfo?.username,
        name: payload.callerInfo?.name,
        profilePic: payload.callerInfo?.profilePic,
      });
      setPhase("incoming");
    };

    const handleCallAnswered = async ({ callId, answer }) => {
      const pc = pcRef.current;
      if (!pc || callRef.current?.callId !== callId) return;
      setPhase("connecting");
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await drainPendingCandidates();
      } catch (answerError) {
        console.error("Failed to apply answer:", answerError);
        toast.error("Couldn't connect the call");
        socket.emit("endCall", { callId });
        teardown();
      }
    };

    const handleCallRejected = () => {
      toast("Call declined");
      teardown();
    };

    const handleCallEnded = ({ reason }) => {
      /*
       * The server's own vocabulary, translated once here. `no_answer` and `timeout`
       * are the ring and max-duration timers; `callee_unavailable` is the callee's last
       * socket going away mid-ring.
       */
      const message =
        reason === "no_answer"
          ? "No answer"
          : reason === "callee_unavailable"
            ? "They're unavailable"
            : reason === "user_disconnected"
              ? "Call disconnected"
              : null;
      if (message) toast(message);
      teardown();
    };

    const handleCallError = ({ error: message }) => {
      const text = message || "Call failed";
      setError(text);
      toast.error(text);
      // Only tear down if we were dialling; a stray error must not kill a live call.
      if (phaseRef.current === "outgoing" || phaseRef.current === "connecting") {
        teardown();
      }
    };

    const handleIceCandidate = async ({ candidate }) => {
      if (!candidate) return;
      const pc = pcRef.current;
      const parsed = new RTCIceCandidate(candidate);
      // Buffered until there is a remote description to attach them to — see
      // pendingCandidatesRef.
      if (!pc || !pc.remoteDescription) {
        pendingCandidatesRef.current.push(parsed);
        return;
      }
      try {
        await pc.addIceCandidate(parsed);
      } catch (candidateError) {
        console.error("Failed to add ICE candidate:", candidateError);
      }
    };

    /*
     * Renegotiation, for an established call only.
     *
     * The initial handshake goes through initiateCall/answerCall; these events exist
     * for a mid-call change (a voice call adding video, say). Guarded on there being a
     * peer connection so a forged one can't create a call out of nothing.
     */
    const handleRtcOffer = async ({ offer }) => {
      const pc = pcRef.current;
      if (!pc || !callRef.current?.callId) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("rtcAnswer", {
          callId: callRef.current.callId,
          answer: { type: answer.type, sdp: answer.sdp },
        });
      } catch (offerError) {
        console.error("Renegotiation failed:", offerError);
      }
    };

    const handleRtcAnswer = async ({ answer }) => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (answerError) {
        console.error("Renegotiation answer failed:", answerError);
      }
    };

    socket.on("incomingCall", handleIncomingCall);
    socket.on("callAnswered", handleCallAnswered);
    socket.on("callRejected", handleCallRejected);
    socket.on("callEnded", handleCallEnded);
    socket.on("callError", handleCallError);
    socket.on("iceCandidate", handleIceCandidate);
    socket.on("rtcOffer", handleRtcOffer);
    socket.on("rtcAnswer", handleRtcAnswer);

    return () => {
      socket.off("incomingCall", handleIncomingCall);
      socket.off("callAnswered", handleCallAnswered);
      socket.off("callRejected", handleCallRejected);
      socket.off("callEnded", handleCallEnded);
      socket.off("callError", handleCallError);
      socket.off("iceCandidate", handleIceCandidate);
      socket.off("rtcOffer", handleRtcOffer);
      socket.off("rtcAnswer", handleRtcAnswer);
    };
    // `phase` is read through phaseRef, deliberately absent here — see phaseRef.
  }, [socket, isConnected, drainPendingCandidates, teardown, setActiveCall]);

  /*
   * Signing out ends the call and releases the camera. Without this, the tracks
   * outlive the session and the hardware indicator stays lit on the login screen.
   */
  useEffect(() => {
    if (!userAuth?.token && phase !== "idle") teardown();
  }, [userAuth?.token, phase, teardown]);

  // Unmount is the last line of defence for the same hardware.
  useEffect(() => () => teardown(), [teardown]);

  const value = useMemo(
    () => ({
      phase,
      call,
      peer,
      localStream,
      remoteStream,
      micEnabled,
      cameraEnabled,
      isRemoteVideoLive,
      connectionState,
      error,
      startCall,
      acceptCall,
      rejectCall,
      endCall,
      toggleMic,
      toggleCamera,
      dismissError,
    }),
    [
      phase,
      call,
      peer,
      localStream,
      remoteStream,
      micEnabled,
      cameraEnabled,
      isRemoteVideoLive,
      connectionState,
      error,
      startCall,
      acceptCall,
      rejectCall,
      endCall,
      toggleMic,
      toggleCamera,
      dismissError,
    ]
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
};

export default CallProvider;
