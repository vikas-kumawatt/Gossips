import React, { useEffect, useState, useContext } from "react";
import { X, Smartphone, Monitor, Globe, Shield, LogOut, CheckCircle } from "lucide-react";
import { authAPI } from "../services/api";
import { UserContext } from "../contexts/UserContext";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

const ActiveSessionsModal = ({ isOpen, onClose }) => {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const { setUserAuth } = useContext(UserContext);
  const navigate = useNavigate();

  const fetchSessions = async () => {
    try {
      setLoading(true);
      const data = await authAPI.listSessions();
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
    } catch (err) {
      console.error("Failed to load active sessions:", err);
      toast.error("Could not load active sessions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchSessions();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleRevokeSingle = async (sessionId) => {
    try {
      setActionLoading(true);
      const res = await authAPI.revokeSession(sessionId);
      toast.success(res.message || "Session revoked");
      if (res.isCurrent) {
        setUserAuth(null);
        navigate("/login");
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to revoke session");
    } finally {
      setActionLoading(false);
    }
  };

  const handleLogoutOthers = async () => {
    if (!window.confirm("Are you sure you want to log out of all other devices?")) return;
    try {
      setActionLoading(true);
      const res = await authAPI.logoutOthers();
      toast.success(res.message || "Logged out of other devices");
      setSessions((prev) => prev.filter((s) => s.isCurrent));
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to log out of other devices");
    } finally {
      setActionLoading(false);
    }
  };

  const handleLogoutAll = async () => {
    if (!window.confirm("Are you sure you want to log out of all devices including this one?")) return;
    try {
      setActionLoading(true);
      const res = await authAPI.logoutAll();
      toast.success(res.message || "Logged out of all devices");
      setUserAuth(null);
      navigate("/login");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to log out of all devices");
    } finally {
      setActionLoading(false);
    }
  };

  const formatTime = (dateStr) => {
    if (!dateStr) return "Recently";
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "Recently";
    }
  };

  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/80 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[500px] max-h-[85vh] flex flex-col rounded-2xl bg-[#181818] border border-neutral-700 overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-blue-500" />
            <h2 className="font-semibold text-[16px] text-white">Active Logins & Devices</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1 space-y-4">
          <p className="text-xs text-neutral-400">
            These are devices where your account is currently signed in. If you see a session you don't recognise, revoke it immediately.
          </p>

          {loading ? (
            <div className="py-12 text-center text-sm text-neutral-400">
              Loading active sessions…
            </div>
          ) : sessions.length === 0 ? (
            <div className="py-12 text-center text-sm text-neutral-400">
              No active sessions found.
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`p-3.5 rounded-xl border flex items-start justify-between gap-3 transition-colors ${
                    s.isCurrent
                      ? "bg-blue-950/20 border-blue-500/30"
                      : "bg-neutral-900/60 border-neutral-800 hover:border-neutral-700"
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2 rounded-lg bg-neutral-800 text-neutral-300 mt-0.5 shrink-0">
                      {s.deviceType === "phone" ? (
                        <Smartphone className="w-5 h-5" />
                      ) : s.deviceType === "tablet" ? (
                        <Smartphone className="w-5 h-5" />
                      ) : (
                        <Monitor className="w-5 h-5" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-white truncate">
                          {s.browser || "Browser"} on {s.os || "Device"}
                        </span>
                        {s.isCurrent && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
                            <CheckCircle className="w-3 h-3" /> Current Device
                          </span>
                        )}
                        {/* Only shown when it means something: the server now
                            sends this only for a device that passed a 2FA
                            challenge and was remembered, and only while that
                            is still in date. */}
                        {s.isTrusted && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                            <Shield className="w-3 h-3" /> Trusted
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-neutral-400 mt-0.5 space-y-0.5">
                        {s.ipAddress && (
                          <p className="flex items-center gap-1">
                            <Globe className="w-3 h-3" /> {s.ipAddress}
                          </p>
                        )}
                        <p>Last active: {formatTime(s.lastActiveAt)}</p>
                        {s.isTrusted && s.trustedUntil && (
                          <p>Skips 2FA until {formatTime(s.trustedUntil)}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {!s.isCurrent && (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={() => handleRevokeSingle(s.id)}
                      className="px-3 py-1 text-xs font-semibold text-red-400 hover:text-red-300 hover:bg-red-950/30 border border-red-900/40 rounded-lg transition-colors shrink-0 disabled:opacity-50 cursor-pointer"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {sessions.length > 0 && (
          <div className="p-4 bg-neutral-900/80 border-t border-neutral-800 flex flex-col sm:flex-row gap-2.5">
            {otherSessionsCount > 0 && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleLogoutOthers}
                className="flex-1 py-2 px-3 text-xs font-semibold text-neutral-200 bg-neutral-800 hover:bg-neutral-700 rounded-xl transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" /> Log Out Other Devices ({otherSessionsCount})
              </button>
            )}
            <button
              type="button"
              disabled={actionLoading}
              onClick={handleLogoutAll}
              className="py-2 px-3 text-xs font-semibold text-red-400 bg-red-950/30 hover:bg-red-900/40 border border-red-900/40 rounded-xl transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" /> Log Out Everywhere
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ActiveSessionsModal;
