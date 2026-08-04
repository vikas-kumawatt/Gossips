import { createContext, useContext } from "react";

/**
 * Split from CallProvider so consumers can import the hook without pulling in the
 * WebRTC machinery — the same reason SocketSharedContext exists.
 */
export const defaultCallContextValue = {
  /** "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended" */
  phase: "idle",
  call: null,
  peer: null,
  localStream: null,
  remoteStream: null,
  micEnabled: true,
  cameraEnabled: true,
  isRemoteVideoLive: false,
  connectionState: "new",
  error: null,
  startCall: async () => {},
  acceptCall: async () => {},
  rejectCall: () => {},
  endCall: () => {},
  toggleMic: () => {},
  toggleCamera: () => {},
  dismissError: () => {},
};

export const CallContext = createContext(defaultCallContextValue);

export const useCall = () => useContext(CallContext) || defaultCallContextValue;
