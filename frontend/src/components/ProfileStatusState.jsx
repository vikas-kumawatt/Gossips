import React from "react";
import { UserX, Lock, ShieldAlert, ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

const ProfileStatusState = ({
  type = "not-found", // "not-found" | "blocked" | "private"
  title,
  message,
  actionButton,
  onAction,
}) => {
  const navigate = useNavigate();

  const configs = {
    "not-found": {
      icon: <UserX className="h-10 w-10 text-neutral-500" />,
      defaultTitle: "User not found",
      defaultMessage: "This page isn't available. The link may be broken, or the page may have been removed.",
    },
    blocked: {
      icon: <ShieldAlert className="h-10 w-10 text-red-400" />,
      defaultTitle: "You blocked this account",
      defaultMessage: "Unblock to see their posts and interact with them again.",
    },
    private: {
      icon: <Lock className="h-10 w-10 text-neutral-400" />,
      defaultTitle: "This profile is private",
      defaultMessage: "Follow this profile to see their photos, replies, and posts.",
    },
  };

  const config = configs[type] || configs["not-found"];

  return (
    <div className="flex flex-col items-center justify-center py-20 px-4 text-center max-w-sm mx-auto">
      <div className="mb-4 p-4 rounded-full bg-neutral-900 border border-neutral-800">
        {config.icon}
      </div>
      <h3 className="text-xl font-bold text-white mb-2">{title || config.defaultTitle}</h3>
      <p className="text-sm text-neutral-400 leading-relaxed mb-6">
        {message || config.defaultMessage}
      </p>

      {actionButton ? (
        actionButton
      ) : type === "not-found" ? (
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Go back
        </button>
      ) : null}
    </div>
  );
};

export default ProfileStatusState;
