import { useContext } from "react";
import { SocketContext, defaultSocketContextValue } from "./SocketSharedContext";

export const useSocket = () => {
  return useContext(SocketContext) || defaultSocketContextValue;
};
