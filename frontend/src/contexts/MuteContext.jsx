import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { UserContext } from "./UserContext";
import { userAPI } from "../services/api";

/**
 * MuteContext — single source of truth for which accounts the current user has
 * muted, indexed by BOTH `id` and lowercased `username` (matching BlockContext)
 * so a mute survives if the muted account renames their handle.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const MuteContext = createContext({
  isMuted: () => false,
  mute: async () => {},
  unmute: async () => {},
  syncMuted: () => {},
  refreshMuted: async () => {},
  muted: { ids: new Set(), usernames: new Set() },
});

/**
 * Extract `{ id, username }` from whatever a caller passed (string handle or user object).
 */
const identityOf = (target) => {
  if (!target) return { id: null, username: null };
  if (typeof target === "string") return { id: null, username: target };
  const raw = target._id ?? target.id ?? null;
  return {
    id: raw ? String(raw) : null,
    username: target.username || null,
  };
};

export const MuteProvider = ({ children }) => {
  const { userAuth } = useContext(UserContext);

  /*
   * Muted accounts, dual-indexed by id and lowercased handle.
   */
  const [muted, setMuted] = useState(() => ({
    ids: new Set(),
    usernames: new Set(),
  }));

  const inFlightRef = useRef(new Set());

  const applyServerList = useCallback((data) => {
    const list = Array.isArray(data?.muted) ? data.muted : [];
    const ids = new Set();
    const usernames = new Set();

    list.forEach((entry) => {
      if (typeof entry === "string") {
        usernames.add(entry.toLowerCase());
      } else if (entry && typeof entry === "object") {
        if (entry._id || entry.id) ids.add(String(entry._id || entry.id));
        if (entry.username) usernames.add(entry.username.toLowerCase());
      }
    });

    setMuted((prev) => {
      inFlightRef.current.forEach((name) => {
        if (prev.usernames.has(name)) {
          usernames.add(name);
        } else {
          usernames.delete(name);
        }
      });
      return { ids, usernames };
    });
  }, []);

  const refreshMuted = useCallback(async () => {
    if (!userAuth?.token) return;
    try {
      const data = await userAPI.getMuted();
      applyServerList(data);
    } catch {
      // Ignored
    }
  }, [userAuth?.token, applyServerList]);

  useEffect(() => {
    if (!userAuth?.token) {
      setMuted({ ids: new Set(), usernames: new Set() });
      return;
    }
    refreshMuted();
  }, [userAuth?.token, refreshMuted]);

  const isMuted = useCallback(
    (target) => {
      const { id, username } = identityOf(target);
      if (id && muted.ids.has(id)) return true;
      if (username && muted.usernames.has(username.toLowerCase())) return true;
      return false;
    },
    [muted]
  );

  const mute = useCallback(
    async (target) => {
      const { id, username } = identityOf(target);
      if (!username) return;

      const lower = username.toLowerCase();
      inFlightRef.current.add(lower);

      // Optimistic update in both indexes
      setMuted((prev) => ({
        ids: id ? new Set(prev.ids).add(id) : prev.ids,
        usernames: new Set(prev.usernames).add(lower),
      }));

      try {
        await userAPI.mute(username);
      } catch (err) {
        setMuted((prev) => {
          const nextIds = new Set(prev.ids);
          const nextUsernames = new Set(prev.usernames);
          if (id) nextIds.delete(id);
          nextUsernames.delete(lower);
          return { ids: nextIds, usernames: nextUsernames };
        });
        throw err;
      } finally {
        inFlightRef.current.delete(lower);
      }
    },
    []
  );

  const unmute = useCallback(
    async (target) => {
      const { id, username } = identityOf(target);
      if (!username) return;

      const lower = username.toLowerCase();
      inFlightRef.current.add(lower);

      // Optimistic update in both indexes
      setMuted((prev) => {
        const nextIds = new Set(prev.ids);
        const nextUsernames = new Set(prev.usernames);
        if (id) nextIds.delete(id);
        nextUsernames.delete(lower);
        return { ids: nextIds, usernames: nextUsernames };
      });

      try {
        await userAPI.unmute(username);
      } catch (err) {
        setMuted((prev) => ({
          ids: id ? new Set(prev.ids).add(id) : prev.ids,
          usernames: new Set(prev.usernames).add(lower),
        }));
        throw err;
      } finally {
        inFlightRef.current.delete(lower);
      }
    },
    []
  );

  const syncMuted = useCallback((target, shouldBeMuted) => {
    const { id, username } = identityOf(target);
    if (!id && !username) return;
    const lower = username ? username.toLowerCase() : null;

    setMuted((prev) => {
      const nextIds = new Set(prev.ids);
      const nextUsernames = new Set(prev.usernames);

      if (shouldBeMuted) {
        if (id) nextIds.add(id);
        if (lower) nextUsernames.add(lower);
      } else {
        if (id) nextIds.delete(id);
        if (lower) nextUsernames.delete(lower);
      }

      return { ids: nextIds, usernames: nextUsernames };
    });
  }, []);

  const value = useMemo(
    () => ({
      muted,
      isMuted,
      mute,
      unmute,
      syncMuted,
      refreshMuted,
    }),
    [muted, isMuted, mute, unmute, syncMuted, refreshMuted]
  );

  return <MuteContext.Provider value={value}>{children}</MuteContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useMute = () => useContext(MuteContext);
