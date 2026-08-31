import React, { useState, useEffect } from "react";
import { X, Shield, Key, Smartphone, AlertCircle, CheckCircle, Copy, Lock, Eye, EyeOff } from "lucide-react";
import { userAPI } from "../services/api";
import toast from "react-hot-toast";

const SecurityTwoFactorModal = ({ isOpen, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [securitySettings, setSecuritySettings] = useState({
    loginAlerts: true,
    unrecognizedDeviceAlerts: true,
    endToEndEncryption: true,
  });

  // Setup state
  const [setupStep, setSetupStep] = useState("idle"); // "idle" | "setup" | "backupCodes" | "disable"
  const [setupData, setSetupData] = useState(null); // { secret, otpauthUrl, backupCodes }
  const [verificationCode, setVerificationCode] = useState("");
  const [password, setPassword] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const data = await userAPI.getSecuritySettings();
      setTwoFactorEnabled(data.twoFactorEnabled);
      setSecuritySettings({
        loginAlerts: data.loginAlerts,
        unrecognizedDeviceAlerts: data.unrecognizedDeviceAlerts,
        endToEndEncryption: data.endToEndEncryption,
      });
    } catch (err) {
      toast.error("Failed to load security settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchSettings();
      setSetupStep("idle");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleToggleSecurity = async (key) => {
    const next = !securitySettings[key];
    const prev = securitySettings[key];
    setSecuritySettings((s) => ({ ...s, [key]: next }));
    try {
      await userAPI.updateSecuritySettings({ [key]: next });
      toast.success("Security preferences updated");
    } catch (err) {
      setSecuritySettings((s) => ({ ...s, [key]: prev }));
      toast.error("Failed to update security preferences");
    }
  };

  const handleStartSetup = async () => {
    try {
      setActionLoading(true);
      const data = await userAPI.setupTwoFactor();
      setSetupData(data);
      setSetupStep("setup");
    } catch (err) {
      toast.error("Failed to initialize 2FA setup");
    } finally {
      setActionLoading(false);
    }
  };

  const handleVerifyEnable = async (e) => {
    e.preventDefault();
    if (!verificationCode) {
      toast.error("Please enter the 6-digit code");
      return;
    }
    try {
      setActionLoading(true);
      await userAPI.enableTwoFactor({
        secret: setupData.secret,
        code: verificationCode,
        backupCodes: setupData.backupCodes,
      });
      toast.success("2FA enabled successfully!");
      setTwoFactorEnabled(true);
      setSetupStep("backupCodes");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Invalid verification code");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisable2FA = async (e) => {
    e.preventDefault();
    try {
      setActionLoading(true);
      await userAPI.disableTwoFactor({ password });
      toast.success("2FA has been disabled");
      setTwoFactorEnabled(false);
      setSetupStep("idle");
      setPassword("");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to disable 2FA");
    } finally {
      setActionLoading(false);
    }
  };

  const copyBackupCodes = () => {
    if (setupData?.backupCodes) {
      navigator.clipboard.writeText(setupData.backupCodes.join("\n"));
      setCopied(true);
      toast.success("Backup codes copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-2xl border border-neutral-800 bg-[#121212] p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-full bg-blue-500/10 text-blue-400">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Security & 2-Factor Auth</h2>
            <p className="text-xs text-neutral-400">Protect your account and login sessions</p>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-neutral-500">Loading security settings...</div>
        ) : setupStep === "setup" ? (
          /* 2FA Setup Screen */
          <div className="space-y-5">
            <div className="rounded-xl bg-blue-500/10 border border-blue-500/20 p-3.5 text-xs text-blue-200/90 leading-relaxed">
              Scan this key or enter it in your authenticator app (Google Authenticator, 1Password, Authy):
            </div>

            <div className="rounded-xl bg-neutral-900 border border-neutral-800 p-4 text-center">
              <p className="text-xs text-neutral-400 mb-1">Your Secret Key (Base32)</p>
              <p className="font-mono text-base font-bold text-white tracking-widest selection:bg-blue-600">
                {setupData?.secret}
              </p>
            </div>

            <form onSubmit={handleVerifyEnable} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                  Enter 6-digit code from your app
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className="w-full text-center tracking-[0.5em] font-mono rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-3 text-lg text-white placeholder-neutral-600 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setSetupStep("idle")}
                  className="flex-1 rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || verificationCode.length !== 6}
                  className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
                >
                  {actionLoading ? "Verifying..." : "Verify & Enable"}
                </button>
              </div>
            </form>
          </div>
        ) : setupStep === "backupCodes" ? (
          /* Backup Codes Screen */
          <div className="space-y-5">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3.5 text-xs text-emerald-200/90 leading-relaxed">
              Two-Factor Authentication is enabled! Save these one-time backup codes in a safe place in case you lose access to your authenticator app:
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-xl bg-neutral-900 border border-neutral-800 p-4">
              {setupData?.backupCodes?.map((code, idx) => (
                <div key={idx} className="font-mono text-sm font-semibold text-white text-center py-1 bg-black/40 rounded border border-neutral-800/80">
                  {code}
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={copyBackupCodes}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                <Copy className="h-4 w-4" />
                {copied ? "Copied!" : "Copy Codes"}
              </button>
              <button
                type="button"
                onClick={() => setSetupStep("idle")}
                className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : setupStep === "disable" ? (
          /* Disable 2FA Screen */
          <form onSubmit={handleDisable2FA} className="space-y-4">
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3.5 text-xs text-red-200/90 leading-relaxed">
              Disabling Two-Factor Authentication removes the extra security layer from your account.
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

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setSetupStep("idle")}
                className="flex-1 rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={actionLoading}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {actionLoading ? "Disabling..." : "Disable 2FA"}
              </button>
            </div>
          </form>
        ) : (
          /* Main Security Settings Overview */
          <div className="space-y-6">
            {/* 2FA Card */}
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Key className="h-5 w-5 text-neutral-400" />
                  <div>
                    <p className="text-sm font-semibold text-white">Two-Factor Authentication</p>
                    <p className="text-xs text-neutral-500">
                      {twoFactorEnabled ? "Active (TOTP Authenticator App)" : "Disabled"}
                    </p>
                  </div>
                </div>

                {twoFactorEnabled ? (
                  <button
                    type="button"
                    onClick={() => setSetupStep("disable")}
                    className="rounded-lg border border-red-800/40 bg-red-950/40 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-900/60 transition-colors"
                  >
                    Disable
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartSetup}
                    disabled={actionLoading}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 transition-colors"
                  >
                    {actionLoading ? "Loading..." : "Set Up"}
                  </button>
                )}
              </div>
            </div>

            {/* Security Alerts Section */}
            <div className="space-y-4 pt-2">
              <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Alerts & Protection</h3>

              {/* Login Alerts */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm text-white">Login Alerts</p>
                  <p className="text-xs text-neutral-500">Get notified when a new sign-in occurs</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={securitySettings.loginAlerts}
                  onClick={() => handleToggleSecurity("loginAlerts")}
                  className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
                    securitySettings.loginAlerts ? "bg-blue-600" : "bg-neutral-700"
                  }`}
                >
                  <span
                    className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform ${
                      securitySettings.loginAlerts ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Unrecognized Device Alerts */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm text-white">Unrecognized Device Alerts</p>
                  <p className="text-xs text-neutral-500">Alert on logins from unfamiliar browsers</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={securitySettings.unrecognizedDeviceAlerts}
                  onClick={() => handleToggleSecurity("unrecognizedDeviceAlerts")}
                  className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
                    securitySettings.unrecognizedDeviceAlerts ? "bg-blue-600" : "bg-neutral-700"
                  }`}
                >
                  <span
                    className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform ${
                      securitySettings.unrecognizedDeviceAlerts ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* End-to-End Encryption */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm text-white">End-to-End Encrypted Backups</p>
                  <p className="text-xs text-neutral-500">Secure private key sync across active sessions</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={securitySettings.endToEndEncryption}
                  onClick={() => handleToggleSecurity("endToEndEncryption")}
                  className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
                    securitySettings.endToEndEncryption ? "bg-blue-600" : "bg-neutral-700"
                  }`}
                >
                  <span
                    className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform ${
                      securitySettings.endToEndEncryption ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SecurityTwoFactorModal;
