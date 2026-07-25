import React, {
  useContext,
  useEffect,
  useState,
} from "react";
import { io } from "socket.io-client";
import { UserContext } from "./UserContext";
import { SocketContext } from "./SocketSharedContext";

export const SocketProvider = ({ children }) => {
  const { userAuth } = useContext(UserContext);
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (userAuth?.token) {
      const newSocket = io(import.meta.env.VITE_SERVER, {
        withCredentials: true,
        transports: ["websocket", "polling"],
        auth: { token: userAuth.token },
        query: { userId: userAuth.id },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
      });

      newSocket.on("connect", () => {
        setIsConnected(true);
        // Join user room
        if (userAuth.id) {
          newSocket.emit("join", userAuth.id);
        }
      });

      newSocket.on("disconnect", () => {
        setIsConnected(false);
      });

      newSocket.on("connect_error", (err) => {
        console.error("Socket connection error:", err);
        setIsConnected(false);
      });

      setSocket(newSocket);

      return () => {
        newSocket.disconnect();
      };
    } else {
      // If no token, disconnect existing socket
      setSocket((existingSocket) => {
        if (existingSocket) {
          existingSocket.disconnect();
        }
        return null;
      });
      setIsConnected(false);
    }
  }, [userAuth?.token, userAuth?.id]);

  const value = {
    socket,
    isConnected,
  };

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
};
