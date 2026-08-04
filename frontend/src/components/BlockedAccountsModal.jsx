import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { userAPI } from "../services/api";
import { useBlock } from "../contexts/BlockContext";
import { Icons } from "./icons";

/**
 * Blocked accounts list (opened from Settings → Blocked profiles).
 * Lists accounts the user has blocked with an Unblock action each.
 */
const BlockedAccountsModal = ({ isOpen, onClose }) => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingUser, setPendingUser] = useState(null);
  const { unblock, requestBlock, isBlocked } = useBlock();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setLoading(true);
    userAPI
      .getBlocked()
      .then((data) => {
        if (active) setAccounts(Array.isArray(data?.blocked) ? data.blocked : []);
      })
      .catch((error) => console.error("Failed to load blocked accounts:", error))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  /*
   * Unblocking removes the row.
   *
   * It used to only flip the button to "Block" and leave the account sitting in a
   * list titled "Blocked profiles" — which is a list of people you have blocked, so
   * an unblocked account has no business being in it. It also made the "You haven't
   * blocked anyone" empty state unreachable: unblock everyone and you were left
   * looking at a full list of people you hadn't blocked.
   *
   * Re-blocking goes through `requestBlock` so it gets the same confirmation dialog
   * as every other entry point; this was the one place that blocked without asking.
   */
  const handleUnblock = async (account) => {
    setPendingUser(account.username);
    try {
      await unblock(account);
      setAccounts((prev) =>
        prev.filter(
          (entry) =>
            entry.username?.toLowerCase() !== account.username?.toLowerCase()
        )
      );
    } catch {
      // BlockContext has rolled its optimistic update back and toasted; the row
      // stays, which is the correct outcome.
    } finally {
      setPendingUser(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/80 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[440px] max-h-[80vh] flex flex-col rounded-2xl bg-[#181818] border border-neutral-700 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <h2 className="font-semibold text-[15px]">Blocked profiles</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-neutral-800 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto">
          {loading ? (
            <p className="text-center text-neutral-400 py-10 text-sm">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-center text-neutral-400 py-10 text-sm">
              You haven't blocked anyone.
            </p>
          ) : (
            accounts.map((u) => {
              // The whole entry: it carries `_id`, which is the rename-proof key.
              const stillBlocked = isBlocked(u);
              return (
                <div
                  key={u._id || u.username}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-neutral-900"
                >
                  <img
                    src={u.profilePic || "/default-avatar.png"}
                    alt={u.username}
                    onClick={() => {
                      onClose();
                      navigate(`/${u.username}`);
                    }}
                    className="w-10 h-10 rounded-full object-cover cursor-pointer"
                  />
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => {
                      onClose();
                      navigate(`/${u.username}`);
                    }}
                  >
                    <p className="text-white font-medium truncate flex items-center gap-1">
                      {u.username}
                      {u.isVerified && <Icons.verified />}
                    </p>
                    {u.name && (
                      <p className="text-neutral-500 text-sm truncate">{u.name}</p>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      stillBlocked
                        ? handleUnblock(u)
                        : requestBlock({ _id: u._id, username: u.username, name: u.name })
                    }
                    disabled={pendingUser === u.username}
                    className={`px-4 py-1.5 rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-60 ${
                      stillBlocked
                        ? "bg-white text-black hover:bg-gray-200"
                        : "border border-neutral-700 text-white"
                    }`}
                  >
                    {stillBlocked ? "Unblock" : "Block"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default BlockedAccountsModal;
