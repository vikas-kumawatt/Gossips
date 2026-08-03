import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { io } from "socket.io-client";
import { UserContext } from "./UserContext";
import { SocketContext } from "./SocketSharedContext";

export const SocketProvider = ({ children }) => {
  const { userAuth } = useContext(UserContext);
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  /*
   * Whether reconnection has been abandoned, and a way to start it again (#92).
   *
   * `reconnectionAttempts: 5` means socket.io stops trying after about five seconds
   * and then does nothing forever — silently. The app went on looking connected:
   * no typing indicators, no incoming messages, no presence, and no indication that
   * anything was wrong. Anyone who noticed had to guess that reloading would fix it.
   *
   * Exposed rather than handled here, because the honest response is a banner the
   * user can act on and only the consuming UI can place that.
   */
  const [reconnectFailed, setReconnectFailed] = useState(false);
  /*
   * Counts *completed* connections, so consumers can tell a reconnect from a first
   * connect. A reconnect means messages arrived while the socket was down and the
   * thread and chat list are stale by the length of the outage — the unread counts
   * already refetch on `isConnected`, and nothing else did.
   */
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  useEffect(() => {
    if (userAuth?.token) {
      const newSocket = io(import.meta.env.VITE_SERVER, {
        withCredentials: true,
        transports: ["websocket", "polling"],
        auth: { token: userAuth.token },
        query: { userId: userAuth.id },
        reconnection: true,
        reconnectionDelay: 1000,
        /*
         * Was 5. socket.io backs off between attempts, so a cap this low gives up
         * inside a few seconds — shorter than a lift, a tunnel, or a phone waking
         * up. With a delay ceiling the retries settle to one every five seconds and
         * cost nothing while the tab is idle.
         */
        reconnectionAttempts: 20,
        reconnectionDelayMax: 5000,
      });

      newSocket.on("connect", () => {
        setIsConnected(true);
        setReconnectFailed(false);
        setConnectionEpoch((n) => n + 1);
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

      // Fires once, after the last attempt. Without a listener this was the point
      // at which the app went quiet with nothing said.
      newSocket.io.on("reconnect_failed", () => {
        setReconnectFailed(true);
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
      setReconnectFailed(false);
    }
  }, [userAuth?.token, userAuth?.id]);

  /** Try again after reconnection was abandoned. */
  const retryConnection = useCallback(() => {
    if (!socket) return;
    setReconnectFailed(false);
    // `connect()` restarts the manager's attempt counter, so this is a fresh 20
    // rather than a single try.
    socket.connect();
  }, [socket]);

  const value = useMemo(
    () => ({ socket, isConnected, reconnectFailed, connectionEpoch, retryConnection }),
    [socket, isConnected, reconnectFailed, connectionEpoch, retryConnection]
  );

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
};
