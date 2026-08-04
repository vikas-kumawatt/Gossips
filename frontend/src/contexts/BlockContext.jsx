import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { toast } from "react-hot-toast";
import { UserContext } from "./UserContext";
import { userAPI } from "../services/api";
import ConfirmDialog from "../components/ui/ConfirmDialog";

/**
 * BlockContext — single source of truth for which accounts the current user has
 * blocked, so Block / Unblock affordances stay consistent everywhere (post menu,
 * profile, chat, settings). Blocking goes through a confirmation dialog (rendered
 * here); unblocking is immediate. Mutations are optimistic.
 *
 * `syncBlocked` is how the rest of the app writes *server* truth back in. Three
 * payloads state whether you have blocked someone — this Set, a profile's
 * `relationship.youBlocked`, and a thread's `blockState.youBlocked` — and nothing
 * used to reconcile them. A page that learned the authoritative answer kept it in
 * local state, so the conversation banner could say "You blocked @x" while the menu
 * two taps away still offered "Block", and taking that offer failed.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const BlockContext = createContext({
  isBlocked: () => false,
  block: async () => {},
  unblock: async () => {},
  requestBlock: () => {},
  syncBlocked: () => {},
  refreshBlocked: async () => {},
  blocked: { ids: new Set(), usernames: new Set() },
});

/**
 * Pull `{id, username}` out of whatever a caller passed.
 *
 * Accepts a bare username (what every call site used to pass), or a user object —
 * a post author, a chat row's peer, a profile. Passing the object is what makes a
 * lookup survive a rename, because the id is stable and the handle is not.
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

export const BlockProvider = ({ children }) => {
  const { userAuth } = useContext(UserContext);
  /*
   * Blocked accounts, indexed by id *and* by handle.
   *
   * This was a Set of lowercased usernames only, which meant a blocked account that
   * changed its handle silently stopped counting as blocked — their posts came back
   * into the feed and every menu offered "Block" again — until the next full fetch.
   * The id never changes, so it is the real key; the handle set stays because plenty
   * of call sites only have a handle to go on (a @mention, a route param).
   */
  const [blocked, setBlocked] = useState(() => ({
    ids: new Set(),
    usernames: new Set(),
  }));
  // { username, name } of the account pending a block confirmation, or null.
  const [pending, setPending] = useState(null);
  const [working, setWorking] = useState(false);

  /*
   * Usernames with a mutation in flight are exempt from a refresh overwriting them.
   * Without this, a `refreshBlocked` that started before a block and answered after
   * it would reinstate the pre-block list and undo the optimistic update.
   */
  const inFlightRef = useRef(new Set());

  const applyServerList = useCallback((data) => {
    const list = Array.isArray(data?.blocked) ? data.blocked : [];
    const ids = new Set();
    const usernames = new Set();
    list.forEach((entry) => {
      if (entry?._id) ids.add(String(entry._id));
      if (entry?.username) usernames.add(entry.username.toLowerCase());
    });

    setBlocked((prev) => {
      // Anything mid-flight keeps whatever the optimistic update decided, in both
      // indexes — otherwise a refresh that started before the mutation and answered
      // after it would reinstate the pre-mutation list.
      inFlightRef.current.forEach((name) => {
        const serverEntry = list.find(
          (entry) => entry?.username?.toLowerCase() === name
        );
        const id = serverEntry?._id ? String(serverEntry._id) : null;
        if (prev.usernames.has(name)) {
          usernames.add(name);
          if (id) ids.add(id);
        } else {
          usernames.delete(name);
          if (id) ids.delete(id);
        }
      });
      return { ids, usernames };
    });
  }, []);

  /** Add or remove one account locally, keeping both indexes in step. */
  const applyLocal = useCallback((target, nowBlocked) => {
    const { id, username } = identityOf(target);
    const lower = username?.toLowerCase() || null;
    if (!id && !lower) return;

    setBlocked((prev) => {
      /*
       * No-op guard, so a redundant sync doesn't re-render every consumer.
       *
       * Both indexes have to already agree, not just one of them. Checking "is this
       * account blocked at all" would bail early on the case that matters most: an
       * entry recorded by handle alone, for which we have now learned the id. That
       * id would never be stored, and the rename-proofing it exists for would
       * silently not apply.
       */
      const idAgrees = !id || prev.ids.has(id) === nowBlocked;
      const nameAgrees = !lower || prev.usernames.has(lower) === nowBlocked;
      if (idAgrees && nameAgrees) return prev;

      const ids = new Set(prev.ids);
      const usernames = new Set(prev.usernames);
      if (nowBlocked) {
        if (id) ids.add(id);
        if (lower) usernames.add(lower);
      } else {
        if (id) ids.delete(id);
        if (lower) usernames.delete(lower);
      }
      return { ids, usernames };
    });
  }, []);

  const refreshBlocked = useCallback(async () => {
    if (!userAuth?.token) return;
    try {
      applyServerList(await userAPI.getBlocked());
    } catch (error) {
      // Left as-is rather than cleared: an empty Set would read as "you have
      // blocked nobody", which is a worse answer than the last known one.
      console.error("Failed to load blocked accounts:", error);
    }
  }, [userAuth?.token, applyServerList]);

  useEffect(() => {
    if (!userAuth?.token) {
      setBlocked({ ids: new Set(), usernames: new Set() });
      return undefined;
    }
    let active = true;
    userAPI
      .getBlocked()
      .then((data) => {
        if (active) applyServerList(data);
      })
      .catch((error) => console.error("Failed to load blocked accounts:", error));
    return () => {
      active = false;
    };
  }, [userAuth?.token, applyServerList]);

  /**
   * @param target A user object (preferred — survives a rename), a user id, or a
   *   username. A bare string is checked against both indexes, so callers that only
   *   have one of the two don't need to say which it is.
   */
  const isBlocked = useCallback(
    (target) => {
      if (!target) return false;
      if (typeof target === "string") {
        return blocked.ids.has(target) || blocked.usernames.has(target.toLowerCase());
      }
      const { id, username } = identityOf(target);
      if (id && blocked.ids.has(id)) return true;
      return username ? blocked.usernames.has(username.toLowerCase()) : false;
    },
    [blocked]
  );

  /**
   * Record what the server says about one account, without a request.
   *
   * For callers that already hold authoritative state — a profile's
   * `relationship.youBlocked`, a thread's `blockState.youBlocked` — so the answer
   * reaches every other surface instead of dying in one page's local state.
   */
  const syncBlocked = useCallback(
    (target, nowBlocked) => {
      const { username } = identityOf(target);
      // Never contradict an in-flight mutation with an older server read.
      if (username && inFlightRef.current.has(username.toLowerCase())) return;
      applyLocal(target, Boolean(nowBlocked));
    },
    [applyLocal]
  );

  const block = useCallback(
    async (target) => {
      const { username } = identityOf(target);
      if (!username) return;
      const lower = username.toLowerCase();
      const me = userAuth?.username?.toLowerCase();
      // Blocking yourself is not a thing the UI should ever ask for, and the server
      // used to accept it — which put your own account in this set and hid your own
      // posts from you.
      if (me && lower === me) return;

      inFlightRef.current.add(lower);
      applyLocal(target, true); // optimistic
      try {
        await userAPI.block(username);
      } catch (err) {
        /*
         * "Already blocked" is success, not failure. The endpoint answered 400 for a
         * duplicate, and rolling back on it produced a stuck toggle: the label said
         * "Block", the click 400'd, the optimistic add reverted, and the label said
         * "Block" again — forever. The server is idempotent now; this keeps old
         * builds and races from regressing it.
         */
        const status = err?.response?.status;
        const message = err?.response?.data?.error || "";
        if (status === 400 && /already blocked/i.test(message)) return;

        applyLocal(target, false);
        throw err;
      } finally {
        inFlightRef.current.delete(lower);
      }
    },
    [userAuth?.username, applyLocal]
  );

  const unblock = useCallback(
    async (target) => {
      const { username } = identityOf(target);
      if (!username) return;
      const lower = username.toLowerCase();
      inFlightRef.current.add(lower);
      applyLocal(target, false); // optimistic
      try {
        await userAPI.unblock(username);
        toast.success(`Unblocked @${username}`);
      } catch (err) {
        applyLocal(target, true);
        toast.error("Couldn't unblock");
        throw err;
      } finally {
        inFlightRef.current.delete(lower);
      }
    },
    [applyLocal]
  );

  // Open the confirmation dialog before blocking.
  const requestBlock = useCallback((account) => {
    if (!account?.username) return;
    setPending(account);
  }, []);

  const confirmBlock = useCallback(async () => {
    if (!pending?.username) return;
    setWorking(true);
    try {
      // The whole account, not just the handle — `requestBlock` callers pass `_id`
      // where they have it, and that is what keeps the block keyed to the account
      // rather than to a name they can change.
      await block(pending);
      toast.success(`Blocked @${pending.username}`);
      setPending(null);
    } catch {
      toast.error("Couldn't block");
      // Dialog closes either way: leaving it open with no error state inside it
      // just looked frozen, and the toast has already said what happened.
      setPending(null);
    } finally {
      setWorking(false);
    }
  }, [pending, block]);

  /*
   * Memoised. This was a fresh object literal every render, so every `pending` /
   * `working` transition during the confirm dialog re-rendered every consumer —
   * which is PostCard, PostHeader, ProfilePage and both chat pages.
   */
  const value = useMemo(
    () => ({
      blocked,
      isBlocked,
      block,
      unblock,
      requestBlock,
      syncBlocked,
      refreshBlocked,
    }),
    [blocked, isBlocked, block, unblock, requestBlock, syncBlocked, refreshBlocked]
  );

  return (
    <BlockContext.Provider value={value}>
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
