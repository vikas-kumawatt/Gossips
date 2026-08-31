import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-hot-toast";
import { userAPI } from "../services/api";
import Avatar from "./Avatar";
import { Icons } from "./icons";

/**
 * Restricted accounts list (opened from Settings → Restricted profiles).
 * Lists accounts the user has restricted with an Unrestrict action.
 */
const RestrictedAccountsModal = ({ isOpen, onClose }) => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingUser, setPendingUser] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setLoading(true);
    userAPI
      .getRestricted()
      .then((data) => {
        if (active) setAccounts(Array.isArray(data?.restricted) ? data.restricted : []);
      })
      .catch((error) => console.error("Failed to load restricted accounts:", error))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleUnrestrict = async (account) => {
    setPendingUser(account.username);
    try {
      await userAPI.unrestrict(account.username);
      setAccounts((prev) =>
        prev.filter(
          (entry) =>
            entry.username?.toLowerCase() !== account.username?.toLowerCase()
        )
      );
      toast.success(`Removed restriction for @${account.username}`);
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to remove restriction");
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
        className="w-full max-w-[440px] max-h-[80vh] flex flex-col rounded-2xl bg-[#181818] border border-neutral-700 overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <h2 className="font-semibold text-[15px] text-white">Restricted profiles</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
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
              You haven't restricted anyone.
            </p>
          ) : (
            accounts.map((u) => (
              <div
                key={u._id || u.username}
                className="flex items-center gap-3 px-4 py-3 hover:bg-neutral-900 transition-colors"
              >
                <div
                  onClick={() => {
                    onClose();
                    navigate(`/${u.username}`);
                  }}
                  className="cursor-pointer shrink-0"
                >
                  <Avatar
                    src={u.profilePic}
                    name={u.name || u.username}
                    size="md"
                  />
                </div>
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
                  type="button"
                  onClick={() => handleUnrestrict(u)}
                  disabled={pendingUser === u.username}
                  className="px-4 py-1.5 rounded-lg text-sm font-semibold cursor-pointer bg-white text-black hover:bg-gray-200 disabled:opacity-60 transition-colors"
                >
                  {pendingUser === u.username ? "Updating..." : "Unrestrict"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default RestrictedAccountsModal;
