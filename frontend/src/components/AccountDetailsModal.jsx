import React, { useState, useEffect } from "react";
import { X, User, Mail, Phone, Calendar, Globe, ShieldCheck, CheckCircle2, AlertCircle } from "lucide-react";
import { userAPI } from "../services/api";
import toast from "react-hot-toast";

const AccountDetailsModal = ({ isOpen, onClose, mode = "personal" }) => {
  // mode: "personal" | "status"
  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      userAPI
        .getAccountDetails()
        .then((data) => setDetails(data))
        .catch(() => toast.error("Could not load account details"))
        .finally(() => setLoading(false));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const formatDate = (isoString) => {
    if (!isoString) return "N/A";
    return new Date(isoString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
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

        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-full bg-neutral-800 text-neutral-200">
            {mode === "status" ? <ShieldCheck className="h-6 w-6 text-blue-400" /> : <User className="h-6 w-6 text-neutral-300" />}
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">
              {mode === "status" ? "Account Status" : "Personal Information"}
            </h2>
            <p className="text-xs text-neutral-400">
              {mode === "status" ? "Your standing and verification badge" : "Account details and registered contacts"}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-neutral-500">Loading details...</div>
        ) : !details ? (
          <div className="py-12 text-center text-sm text-neutral-500">Details unavailable</div>
        ) : mode === "status" ? (
          /* Account Status View */
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl bg-neutral-900 border border-neutral-800 p-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                <div>
                  <p className="text-sm font-semibold text-white">Standing</p>
                  <p className="text-xs text-neutral-400 capitalize">{details.accountStatus || "Active"}</p>
                </div>
              </div>
              <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
                Good Standing
              </span>
            </div>

            <div className="flex items-center justify-between rounded-xl bg-neutral-900 border border-neutral-800 p-4">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-blue-400" />
                <div>
                  <p className="text-sm font-semibold text-white">Verification Badge</p>
                  <p className="text-xs text-neutral-400">
                    {details.isVerified ? "Verified Account" : "Standard Account"}
                  </p>
                </div>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                details.isVerified
                  ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                  : "bg-neutral-800 text-neutral-400"
              }`}>
                {details.isVerified ? "Verified" : "Unverified"}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-xl bg-neutral-900 border border-neutral-800 p-4">
              <div className="flex items-center gap-3">
                <User className="h-5 w-5 text-neutral-400" />
                <div>
                  <p className="text-sm font-semibold text-white">Role</p>
                  <p className="text-xs text-neutral-400 uppercase font-mono">{details.role || "user"}</p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full mt-4 rounded-xl bg-neutral-800 py-2.5 text-sm font-semibold text-white hover:bg-neutral-700 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          /* Personal Information View */
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-neutral-900 border border-neutral-800 p-3.5">
              <div className="flex items-center gap-3">
                <Mail className="h-5 w-5 text-neutral-400" />
                <div>
                  <p className="text-xs text-neutral-400">Email Address</p>
                  <p className="text-sm font-medium text-white">{details.email}</p>
                </div>
              </div>
              {details.isEmailVerified && (
                <span className="text-xs text-emerald-400 font-semibold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  Verified
                </span>
              )}
            </div>

            <div className="flex items-center justify-between rounded-xl bg-neutral-900 border border-neutral-800 p-3.5">
              <div className="flex items-center gap-3">
                <Phone className="h-5 w-5 text-neutral-400" />
                <div>
                  <p className="text-xs text-neutral-400">Phone Number</p>
                  <p className="text-sm font-medium text-white">{details.phoneNumber || "Not provided"}</p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl bg-neutral-900 border border-neutral-800 p-3.5">
              <div className="flex items-center gap-3">
                <Globe className="h-5 w-5 text-neutral-400" />
                <div>
                  <p className="text-xs text-neutral-400">Country / Region</p>
                  <p className="text-sm font-medium text-white">{details.country || "Detected on sign-in"}</p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl bg-neutral-900 border border-neutral-800 p-3.5">
              <div className="flex items-center gap-3">
                <Calendar className="h-5 w-5 text-neutral-400" />
                <div>
                  <p className="text-xs text-neutral-400">Member Since</p>
                  <p className="text-sm font-medium text-white">{formatDate(details.createdAt)}</p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full mt-4 rounded-xl bg-neutral-800 py-2.5 text-sm font-semibold text-white hover:bg-neutral-700 transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AccountDetailsModal;
