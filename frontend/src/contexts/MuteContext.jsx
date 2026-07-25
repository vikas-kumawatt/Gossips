import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  useCallback,
} from "react";
import { UserContext } from "./UserContext";
import { userAPI } from "../services/api";

/**
 * MuteContext — single source of truth for which accounts the current user has
 * muted, so the Mute / Unmute affordance stays consistent everywhere in the app
 * (post menus, profile menu, etc.). Mutations are optimistic and reconciled with
 * the server.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const MuteContext = createContext({
  isMuted: () => false,
  mute: async () => {},
  unmute: async () => {},
  mutedUsers: new Set(),
});

export const MuteProvider = ({ children }) => {
  const { userAuth } = useContext(UserContext);
  const [mutedUsers, setMutedUsers] = useState(() => new Set());

  // Hydrate the muted set once we have an authenticated user.
  useEffect(() => {
    if (!userAuth?.token) {
      setMutedUsers(new Set());
      return;
    }
    let active = true;
    userAPI
      .getMuted()
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data?.muted) ? data.muted : [];
        setMutedUsers(new Set(list.map((u) => u.toLowerCase())));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userAuth?.token]);

  const isMuted = useCallback(
    (username) => (username ? mutedUsers.has(username.toLowerCase()) : false),
    [mutedUsers]
  );

  const mute = useCallback(async (username) => {
    if (!username) return;
    const lower = username.toLowerCase();
    setMutedUsers((prev) => new Set(prev).add(lower)); // optimistic
    try {
      await userAPI.mute(username);
    } catch (err) {
      setMutedUsers((prev) => {
        const next = new Set(prev);
        next.delete(lower);
        return next;
      });
      throw err;
    }
  }, []);

  const unmute = useCallback(async (username) => {
    if (!username) return;
    const lower = username.toLowerCase();
    setMutedUsers((prev) => {
      const next = new Set(prev);
      next.delete(lower);
      return next;
    }); // optimistic
    try {
      await userAPI.unmute(username);
    } catch (err) {
      setMutedUsers((prev) => new Set(prev).add(lower));
      throw err;
    }
  }, []);

  return (
    <MuteContext.Provider value={{ mutedUsers, isMuted, mute, unmute }}>
      {children}
    </MuteContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useMute = () => useContext(MuteContext);
