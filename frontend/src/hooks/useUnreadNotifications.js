import { useCallback, useEffect } from "react";
import { notificationAPI } from "../services/api";

/**
 * Keeps the unread-notification badge honest.
 *
 * The badge used to be a counter that started at zero on every page load and
 * only ever went up, one live socket event at a time. Everything else about it
 * followed from that: notifications that arrived while you were logged out, on
 * your phone, or on a different tab were invisible; a dropped websocket lost
 * every event it missed; and a hard refresh silently cleared the badge whether
 * or not you'd read anything.
 *
 * So the count is *fetched*, not accumulated. Three moments:
 *
 *   - on mount, so a fresh tab starts from the truth;
 *   - on a socket event, which is the cheap fast path — it bumps optimistically
 *     rather than round-tripping, because it can and the next sync corrects it;
 *   - on reconnect and on tab focus, which is what makes it self-healing. Any
 *     event missed while the connection was down or the tab was hidden is
 *     recovered the moment you come back, without a poll.
 *
 * That third one is the part a change of transport wouldn't have given us.
 * Neither websockets nor SSE guarantee delivery across a reconnect, so either
 * way the count has to be reconcilable against the server.
 */
export const useUnreadNotifications = ({ token, socket, setCount }) => {
  const sync = useCallback(async () => {
    if (!token) return;
    try {
      const { count } = await notificationAPI.getUnreadCount();
      /*
       * Re-check the token the closure captured. On sign-out the effect below
       * sets the badge to 0, but a request already in flight for the previous
       * session resolves after that and would paint its count back.
       */
      if (!token) return;
      setCount(Number(count) || 0);
    } catch {
      // Offline or a failed request. Leave the current value alone: whatever
      // it is, it's a better guess than zero.
    }
  }, [token, setCount]);

  // Mount, and whenever the signed-in user changes.
  useEffect(() => {
    if (!token) {
      setCount(0);
      return undefined;
    }

    let ignore = false;
    notificationAPI
      .getUnreadCount()
      .then(({ count }) => {
        if (!ignore) setCount(Number(count) || 0);
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, [token, setCount]);

  useEffect(() => {
    if (!socket || !token) return undefined;

    // Optimistic: the event carries the notification, so we know it's +1
    // without asking. A wrong guess is corrected by the next sync.
    const onNew = () => setCount((prev) => prev + 1);
    /*
     * "connect", not the manager's "reconnect". The manager gives up after
     * `reconnectionAttempts` and then never emits reconnect again, so a long
     * outage would permanently disable the recovery this is here for.
     * "connect" fires on every successful (re)connection, including one made
     * by hand. The duplicate fetch on the initial connect is one cheap count.
     */
    socket.on("newNotification", onNew);
    socket.on("connect", sync);

    return () => {
      socket.off("newNotification", onNew);
      socket.off("connect", sync);
    };
  }, [socket, token, sync, setCount]);

  useEffect(() => {
    if (!token) return undefined;

    /*
     * visibilitychange rather than window focus: a background tab is throttled
     * and may have missed events even though it never lost focus in the way the
     * focus event means. This fires when the tab actually becomes visible.
     */
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [token, sync]);

  return sync;
};
