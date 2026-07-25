import { createContext } from "react";

export const defaultSocketContextValue = {
  socket: null,
  isConnected: false,
};

export const SocketContext = createContext(defaultSocketContextValue);
