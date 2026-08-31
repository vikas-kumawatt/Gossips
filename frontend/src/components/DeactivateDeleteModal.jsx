import React, { useState, useContext } from "react";
import { X, AlertTriangle, ShieldAlert, Lock } from "lucide-react";
import { userAPI } from "../services/api";
import { UserContext } from "../contexts/UserContext";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

const DeactivateDeleteModal = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState("deactivate"); // "deactivate" | "delete"
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [loading, setLoading] = useState(false);
  const { setUserAuth } = useContext(UserContext);
  const navigate = useNavigate();

  if (!isOpen) return null;

  const handleDeactivate = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const res = await userAPI.deactivateAccount({ password });
      toast.success(res.message || "Account deactivated");
      setUserAuth(null);
      localStorage.removeItem("user");
      sessionStorage.clear();
      onClose();
      navigate("/login");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to deactivate account");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (e) => {
    e.preventDefault();
    if (confirmText !== "DELETE") {
      toast.error("Please type DELETE in capital letters to confirm");
      return;
    }

    try {
      setLoading(true);
      const res = await userAPI.deleteAccount({ password, confirmation: confirmText });
      toast.success(res.message || "Account permanently deleted");
      setUserAuth(null);
      localStorage.removeItem("user");
      sessionStorage.clear();
      onClose();
      navigate("/signup");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to delete account");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-neutral-800 bg-[#121212] p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 mb-5">
          <div className={`p-2.5 rounded-full ${activeTab === 'delete' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`}>
            {activeTab === "delete" ? <ShieldAlert className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">
              {activeTab === "delete" ? "Delete Account" : "Deactivate Account"}
            </h2>
            <p className="text-xs text-neutral-400">Manage your profile accessibility</p>
          </div>
        </div>

        {/* Tab Toggle */}
        <div className="flex rounded-lg bg-neutral-900 p-1 mb-5 border border-neutral-800">
          <button
            type="button"
            onClick={() => setActiveTab("deactivate")}
            className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors ${
              activeTab === "deactivate"
                ? "bg-neutral-800 text-white shadow-sm"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Temporary Deactivation
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("delete")}
            className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors ${
              activeTab === "delete"
                ? "bg-red-950/60 text-red-400 border border-red-800/40"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Permanent Deletion
          </button>
        </div>

        {activeTab === "deactivate" ? (
          <form onSubmit={handleDeactivate} className="space-y-4">
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3.5 text-xs text-amber-200/90 leading-relaxed">
              Deactivating your account is temporary. Your profile, posts, photos, and comments will be hidden until you log back in.
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                Confirm your password
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter current password"
                  className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:border-blue-500 focus:outline-none"
                />
                <Lock className="absolute right-3.5 top-3 h-4 w-4 text-neutral-500" />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 rounded-xl bg-amber-600 py-2.5 text-sm font-semibold text-white hover:bg-amber-500 transition-colors disabled:opacity-50"
              >
                {loading ? "Deactivating..." : "Deactivate Account"}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleDelete} className="space-y-4">
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3.5 text-xs text-red-200/90 leading-relaxed">
              Deleting your account is permanent. All your profile data, posts, chats, and followers will be permanently erased and cannot be recovered.
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                Confirm your password
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter current password"
                  className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:border-red-500 focus:outline-none"
                />
                <Lock className="absolute right-3.5 top-3 h-4 w-4 text-neutral-500" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                Type <span className="font-bold text-red-400">DELETE</span> to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:border-red-500 focus:outline-none"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || confirmText !== "DELETE"}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {loading ? "Deleting..." : "Permanently Delete"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default DeactivateDeleteModal;
