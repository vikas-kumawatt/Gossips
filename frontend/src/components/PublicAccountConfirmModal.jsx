import React from "react";
import { Globe, X, AlertTriangle } from "lucide-react";

const PublicAccountConfirmModal = ({ isOpen, onClose, onConfirm, loading = false }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-neutral-800 bg-[#121212] p-6 shadow-2xl">
        <button
          onClick={onClose}
          disabled={loading}
          className="absolute right-4 top-4 rounded-full p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 mb-5">
          <div className="p-3 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Globe className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Switch to Public Account?</h2>
            <p className="text-xs text-neutral-400">Review before making your profile public</p>
          </div>
        </div>

        <div className="rounded-xl bg-neutral-900 border border-neutral-800 p-4 space-y-2.5 text-xs text-neutral-300 leading-relaxed mb-6">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <p>
              Anyone on Gossips will be able to see your posts, reposts, replies, and bio.
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <p>
              <strong className="text-white">All pending follow requests will be automatically accepted</strong> immediately.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 rounded-xl bg-white text-black hover:bg-neutral-200 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {loading ? "Switching..." : "Switch to Public"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PublicAccountConfirmModal;
