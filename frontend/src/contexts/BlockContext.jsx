import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  useCallback,
} from "react";
import { toast } from "react-hot-toast";
import { UserContext } from "./UserContext";
import { userAPI } from "../services/api";
import ConfirmDialog from "../components/ui/ConfirmDialog";

/**
 * BlockContext — single source of truth for which accounts the current user has
 * blocked, so Block / Unblock affordances stay consistent everywhere (post menu,
 * profile, chat, settings). Blocking goes through a confirmation dialog (rendered
 * here); unblocking is immediate. Mutations are optimistic and reconciled.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const BlockContext = createContext({
  isBlocked: () => false,
  block: async () => {},
  unblock: async () => {},
  requestBlock: () => {},
  blockedUsers: new Set(),
});

export const BlockProvider = ({ children }) => {
  const { userAuth } = useContext(UserContext);
  const [blockedUsers, setBlockedUsers] = useState(() => new Set());
  // { username, name } of the account pending a block confirmation, or null.
  const [pending, setPending] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!userAuth?.token) {
      setBlockedUsers(new Set());
      return;
    }
    let active = true;
    userAPI
      .getBlocked()
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data?.blocked) ? data.blocked : [];
        setBlockedUsers(new Set(list.map((u) => u.username?.toLowerCase()).filter(Boolean)));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userAuth?.token]);

  const isBlocked = useCallback(
    (username) => (username ? blockedUsers.has(username.toLowerCase()) : false),
    [blockedUsers]
  );

  const block = useCallback(async (username) => {
    if (!username) return;
    const lower = username.toLowerCase();
    setBlockedUsers((prev) => new Set(prev).add(lower)); // optimistic
    try {
      await userAPI.block(username);
    } catch (err) {
      setBlockedUsers((prev) => {
        const next = new Set(prev);
        next.delete(lower);
        return next;
      });
      throw err;
    }
  }, []);

  const unblock = useCallback(async (username) => {
    if (!username) return;
    const lower = username.toLowerCase();
    setBlockedUsers((prev) => {
      const next = new Set(prev);
      next.delete(lower);
      return next;
    }); // optimistic
    try {
      await userAPI.unblock(username);
      toast.success(`Unblocked @${username}`);
    } catch (err) {
      setBlockedUsers((prev) => new Set(prev).add(lower));
      toast.error("Couldn't unblock");
      throw err;
    }
  }, []);

  // Open the confirmation dialog before blocking.
  const requestBlock = useCallback((account) => {
    if (!account?.username) return;
    setPending(account);
  }, []);

  const confirmBlock = useCallback(async () => {
    if (!pending?.username) return;
    setWorking(true);
    try {
      await block(pending.username);
      toast.success(`Blocked @${pending.username}`);
      setPending(null);
    } catch {
      toast.error("Couldn't block");
    } finally {
      setWorking(false);
    }
  }, [pending, block]);

  return (
    <BlockContext.Provider
      value={{ blockedUsers, isBlocked, block, unblock, requestBlock }}
    >
      {children}
      {pending && (
        <ConfirmDialog
          title={`Block @${pending.username}?`}
          confirmLabel="Block"
          busy={working}
          onConfirm={confirmBlock}
          onCancel={() => !working && setPending(null)}
        >
          They won't be able to find your profile, posts or message you on
          Gossips. We won't let them know you blocked them.
        </ConfirmDialog>
      )}
    </BlockContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useBlock = () => useContext(BlockContext);
