import { createContext } from "react";

export const defaultSocketContextValue = {
  socket: null,
  isConnected: false,
  // Reconnection state, so a consumer outside the provider reads "fine, not
  // connected yet" rather than "gave up" — see SocketContext for what these mean.
  reconnectFailed: false,
  connectionEpoch: 0,
  retryConnection: () => {},
};

export const SocketContext = createContext(defaultSocketContextValue);
