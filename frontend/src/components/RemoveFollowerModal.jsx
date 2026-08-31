import React from "react";
import { X, UserMinus } from "lucide-react";
import Avatar from "./Avatar";

const RemoveFollowerModal = ({
  isOpen,
  user,
  isAccountPrivate = false,
  loading = false,
  onClose,
  onConfirm,
}) => {
  if (!isOpen || !user) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-2xl border border-neutral-800 bg-[#141414] p-6 text-center shadow-2xl">
        <button
          onClick={onClose}
          disabled={loading}
          className="absolute right-4 top-4 rounded-full p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mx-auto mb-4 flex justify-center">
          <Avatar
            src={user.profilePic}
            name={user.name || user.username}
            size="2xl"
            className="ring-4 ring-neutral-800"
          />
        </div>

        <h3 className="text-lg font-bold text-white mb-2">
          Remove follower?
        </h3>

        <p className="text-xs text-neutral-400 leading-relaxed mb-6">
          Gossips won't tell <span className="font-semibold text-neutral-200">@{user.username}</span> that they were removed from your followers.
          {isAccountPrivate && (
            <span className="block mt-1 text-neutral-400">
              Because your account is private, they won't be able to see your posts or replies unless they request to follow you again.
            </span>
          )}
        </p>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="w-full rounded-xl bg-red-600 hover:bg-red-500 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50 cursor-pointer"
          >
            {loading ? "Removing..." : "Remove"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="w-full rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default RemoveFollowerModal;
