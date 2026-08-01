import { useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-hot-toast";
import { Check, Plus } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { UserContext } from "../contexts/UserContext";
import { authAPI } from "../services/api";
import { persistUser } from "../services/authSession";
import {
  MAX_ACCOUNTS,
  getAccounts,
  reconcileAccounts,
  removeAccount,
} from "../lib/accounts";

/**
 * Switching between accounts signed in on this device.
 *
 * The local list paints immediately so the sheet never opens onto a spinner,
 * then `/auth/accounts` reconciles it — that's what catches an account whose
 * session expired, was signed out on another device, or was revoked. Rows the
 * server no longer vouches for stay visible but marked, because silently
 * removing an account someone can see in their list reads as a bug.
 *
 * A successful switch reloads the page rather than swapping state in place.
 * That looks heavy-handed and is deliberate: the app holds a lot of
 * per-account state — feed caches, an open socket, in-flight requests carrying
 * the old bearer token, contexts for follows, blocks and mutes — and a request
 * issued as one account that resolves as another is the kind of bug that
 * writes the wrong person's data into the wrong person's cache. A reload has
 * no such surface, and it is what Instagram does too.
 */

const AccountRow = ({ account, isCurrent, disabled, busy, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    disabled={disabled}
    className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-neutral-800/60 disabled:cursor-default disabled:opacity-100 cursor-pointer"
  >
    <img
      src={account.profilePic || "/default-avatar.png"}
      alt=""
      referrerPolicy="no-referrer"
      className={`h-11 w-11 shrink-0 rounded-full border border-neutral-700 object-cover ${
        account.expired ? "opacity-40" : ""
      }`}
    />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1">
        {/* The handle truncates; the tick and the badge never do. */}
        <p
          className={`min-w-0 truncate text-[15px] font-semibold ${
            account.expired ? "text-neutral-500" : "text-white"
          }`}
        >
          {account.username}
        </p>
        {account.isVerified && !account.expired && (
          <span className="shrink-0">
            <Icons.verified />
          </span>
        )}
      </div>
      <p className="truncate text-[13px] text-neutral-500">
        {account.expired ? "Logged out · Tap to log in again" : account.name || ""}
      </p>
    </div>

    {busy ? (
      <Icons.spinner className="h-5 w-5 shrink-0 animate-spin text-neutral-400" />
    ) : isCurrent ? (
      <Check className="h-5 w-5 shrink-0 text-blue-500" strokeWidth={3} />
    ) : null}
  </button>
);

const AccountSwitcherSheet = ({ onClose }) => {
  const { userAuth } = useContext(UserContext);
  const navigate = useNavigate();

  const currentId = String(userAuth?.id || userAuth?._id || "");
  const [accounts, setAccounts] = useState(() => getAccounts());
  const [switchingId, setSwitchingId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    authAPI
      .listAccounts()
      .then(({ accounts: live }) => {
        if (cancelled) return;
        const usable = new Set((live || []).map((a) => String(a.id)));
        const merged = reconcileAccounts(live);

        /*
         * reconcileAccounts drops what the server didn't vouch for. Add those
         * back as marked-expired rows so the list doesn't silently shrink —
         * except the account you're using, which is by definition fine.
         *
         * Compared against the state snapshot taken before reconciling, not
         * against storage: reconcileAccounts has already written the pruned
         * list, so reading storage here would find nothing missing.
         */
        const missing = accounts.filter(
            (a) =>
              !usable.has(a.id) &&
              a.id !== currentId &&
              !merged.some((m) => m.id === a.id)
          );

        const seen = new Set();
        setAccounts(
          [...merged, ...missing.map((a) => ({ ...a, expired: true }))].filter((a) =>
            seen.has(a.id) ? false : seen.add(a.id)
          )
        );
      })
      .catch(() => {
        // Offline. The local list is still the best thing to show, and a
        // switch will fail loudly rather than silently doing the wrong thing.
      });

    return () => {
      cancelled = true;
    };
    // Runs once: re-running on `accounts` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const handleAdd = (close) => {
    close();
    // `add=1` keeps the login page from bouncing a signed-in user home.
    navigate("/login?add=1");
  };

  const handleSelect = async (account, close) => {
    if (account.id === currentId || switchingId) return;

    if (account.expired) {
      close();
      navigate(`/login?add=1&username=${encodeURIComponent(account.username)}`);
      return;
    }

    setSwitchingId(account.id);
    try {
      const data = await authAPI.switchAccount(account.id);
      persistUser(data);
      /*
       * A hard navigation, not react-router. Every provider, cache and socket
       * is rebuilt from scratch for the new account — see the note above.
       */
      window.location.assign("/");
    } catch (error) {
      setSwitchingId(null);
      const message = error?.response?.data?.error;
      // The session died between the list being drawn and the tap. Mark the
      // row rather than leaving a button that just fails.
      setAccounts((prev) =>
        prev.map((a) => (a.id === account.id ? { ...a, expired: true } : a))
      );
      removeAccount(account.id);
      toast.error(message || "Couldn't switch account");
    }
  };

  const canAdd = accounts.filter((a) => !a.expired).length < MAX_ACCOUNTS;

  // The one you're using goes first, which is where the eye starts.
  const ordered = [
    ...accounts.filter((a) => a.id === currentId),
    ...accounts.filter((a) => a.id !== currentId),
  ];

  return (
    <ResponsiveSheet title="Switch account" onClose={onClose}>
      {(close) => (
        <div className="pb-2">
          <div className="divide-y divide-neutral-800/70">
            {ordered.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                isCurrent={account.id === currentId}
                disabled={Boolean(switchingId) || account.id === currentId}
                busy={switchingId === account.id}
                onSelect={() => handleSelect(account, close)}
              />
            ))}
          </div>

          <div className="border-t border-neutral-800">
            <button
              type="button"
              onClick={() => handleAdd(close)}
              disabled={!canAdd || Boolean(switchingId)}
              className="flex w-full cursor-pointer items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-neutral-800/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-dashed border-neutral-600">
                <Plus className="h-5 w-5 text-neutral-400" />
              </span>
              <span className="text-[15px] font-semibold text-white">Add account</span>
            </button>

            {!canAdd && (
              <p className="px-5 pb-3 text-[12px] text-neutral-500">
                You can be logged into {MAX_ACCOUNTS} accounts at a time. Log out of one to
                add another.
              </p>
            )}
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default AccountSwitcherSheet;
