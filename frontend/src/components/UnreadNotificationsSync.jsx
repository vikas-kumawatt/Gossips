import { useContext } from "react";
import { UserContext } from "../contexts/UserContext";
import { useSocket } from "../contexts/useSocket";
import { useUnreadNotifications } from "../hooks/useUnreadNotifications";

/**
 * Owns the unread-notification count, once, for the whole app.
 *
 * Renders nothing. It exists because the count needs both UserContext and the
 * socket, and there is no single component that sits inside both and is
 * mounted exactly once — Navigation looked like it, but it is rendered twice
 * on nearly every page: once inside SiteHeader for desktop and once inside
 * MobileNavbar for phones. Both are mounted at all times, only one is visible,
 * so its socket listener ran twice and every notification counted as two.
 */
const UnreadNotificationsSync = () => {
  const { userAuth, setUnreadNotificationCount } = useContext(UserContext);
  const { socket } = useSocket();

  useUnreadNotifications({
    token: userAuth?.token,
    socket,
    setCount: setUnreadNotificationCount,
  });

  return null;
};

export default UnreadNotificationsSync;
