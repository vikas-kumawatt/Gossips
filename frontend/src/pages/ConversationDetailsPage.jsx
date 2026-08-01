import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { UserContext } from "../contexts/UserContext";
import { useBlock } from "../contexts/BlockContext";
import { useReport } from "../contexts/ReportContext";
import { Icons } from "../components/icons";
import { chatAPI, userAPI } from "../services/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const DISAPPEAR_PRESETS = [
  { label: "Off", seconds: null },
  { label: "24 hours", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
  { label: "90 days", seconds: 7776000 },
];

const THEME_OPTIONS = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

function formatDisappearingLabel(seconds) {
  if (seconds == null) return "Off";
  const preset = DISAPPEAR_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} days`;
  return `${Math.round(seconds / 3600)} hours`;
}

const ConversationDetailsPage = () => {
  const { username } = useParams();
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);

  const [peer, setPeer] = useState(null);
  // Tracked but not surfaced anywhere yet; only the setter is used.
  const [, setBlockedByThem] = useState(false);
  const { isBlocked: isUserBlocked, requestBlock, unblock: unblockUser } = useBlock();
  const { openReport } = useReport();
  const youBlocked = isUserBlocked(username);
  const [loadingUser, setLoadingUser] = useState(true);
  const [media, setMedia] = useState([]);
  const [loadingMedia, setLoadingMedia] = useState(true);
  const [toast, setToast] = useState(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [theme, setTheme] = useState("system");
  const [disappearingSeconds, setDisappearingSeconds] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const chatKey = useMemo(
    () => (peer?._id ? `user_${peer._id}` : null),
    [peer?._id]
  );

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!username || !userAuth?.token) return;
      setLoadingUser(true);
      setBlockedByThem(false);
      try {
        const data = await userAPI.getProfile(username);
        if (!cancelled) setPeer(data);
      } catch (e) {
        // They blocked us → profile 404s. Show an anonymized "Gossips User".
        if (e?.response?.status === 404) {
          if (!cancelled) {
            setPeer({ username, name: "Gossips User", profilePic: "" });
            setBlockedByThem(true);
          }
        } else {
          console.error(e);
          if (!cancelled) showToast("Could not load profile");
        }
      } finally {
        if (!cancelled) setLoadingUser(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [username, userAuth?.token, showToast]);

  useEffect(() => {
    if (!peer?._id || !userAuth?.token) {
      setPrefsLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const prefs = await chatAPI.getPreferences();
        if (cancelled) return;
        const key = `user_${peer._id}`;
        setIsMuted((prefs.mutedChats || []).includes(key));
        setTheme(prefs.theme || "system");
        const row = (prefs.disappearingByChat || []).find((x) => x.chatId === key);
        setDisappearingSeconds(row?.seconds ?? null);
      } catch (e) {
        console.error(e);
        showToast("Could not load chat settings");
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peer?._id, userAuth?.token, showToast]);

  const handleToggleMute = async () => {
    if (!chatKey || actionLoading) return;
    setActionLoading("mute");
    try {
      const res = await chatAPI.updateChatState(chatKey, "mute", !isMuted);
      setIsMuted(!!res.enabled);
      showToast(res.enabled ? "Notifications muted" : "Unmuted");
    } catch (e) {
      console.error(e);
      showToast("Could not update mute");
    } finally {
      setActionLoading(null);
    }
  };

  const handleThemeSelect = async (value) => {
    if (actionLoading) return;
    setActionLoading("theme");
    try {
      const res = await chatAPI.updateChatTheme(value);
      setTheme(res.theme);
      showToast("Theme saved");
    } catch (e) {
      console.error(e);
      showToast("Could not save theme");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisappearingSelect = async (seconds) => {
    if (!chatKey || actionLoading) return;
    setActionLoading("disappear");
    try {
      await chatAPI.setDisappearingTimer(chatKey, seconds);
      setDisappearingSeconds(seconds);
      showToast(
        seconds == null ? "Disappearing messages off" : "Disappearing messages saved"
      );
    } catch (e) {
      console.error(e);
      showToast("Could not save timer");
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadMedia = async () => {
      if (!username || !userAuth?.token) return;
      setLoadingMedia(true);
      try {
        const res = await chatAPI.getConversationMedia(username, { limit: 120 });
        if (!cancelled) setMedia(res.media || []);
      } catch (e) {
        console.error(e);
        if (!cancelled) setMedia([]);
      } finally {
        if (!cancelled) setLoadingMedia(false);
      }
    };
    loadMedia();
    return () => {
      cancelled = true;
    };
  }, [username, userAuth?.token]);

  const handleRestrict = async () => {
    try {
      await userAPI.restrict(username);
      showToast("User restricted");
    } catch (e) {
      console.error(e);
      showToast("Could not update restrict");
    }
  };

  const handleBlock = () => {
    // Shared confirmation dialog + app-wide block state.
    requestBlock({ username, name: peer?.name });
  };

  const handleUnblock = async () => {
    try {
      await unblockUser(username);
    } catch {
      // toast handled in context
    }
  };

  const handleReport = () => {
    openReport({
      targetType: "conversation",
      username,
      name: peer?.name,
    });
  };

  const handleDeleteChat = async () => {
    if (
      !window.confirm(
        "Delete this entire conversation? This action cannot be undone."
      )
    )
      return;
    try {
      await chatAPI.deleteChat(username);
      navigate("/chat");
    } catch (e) {
      console.error(e);
      showToast("Failed to delete chat");
    }
  };

  const actionBtn =
    "flex flex-col items-center gap-1.5 min-w-0 flex-1 py-2 rounded-xl hover:bg-neutral-900 transition-colors";

  const settingRow =
    "flex items-center justify-between w-full px-4 py-3.5 rounded-xl hover:bg-neutral-900 transition-colors text-left";

  const profilePic = peer?.profilePic || "/default-avatar.png";
  const displayName = peer?.name || peer?.username || username || "User";

  const mediaKey = (item, index) =>
    `${item.messageId || "m"}-${item.url}-${index}`;

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-black text-white min-h-0">
      <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
        <button
          type="button"
          onClick={() => navigate(`/chat/${username}`)}
          className="text-neutral-400 hover:text-white transition-colors p-1 -ml-1"
          aria-label="Go back"
        >
          <Icons.back className="w-5 h-5" />
        </button>
        <h1 className="flex-1 text-center text-sm font-semibold text-neutral-200 pr-7 truncate">
          {displayName}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="flex flex-col items-center pt-8 pb-6 px-4">
          {loadingUser ? (
            <div className="w-28 h-28 rounded-full bg-neutral-800 animate-pulse" />
          ) : (
            <img
              src={profilePic}
              alt=""
              className="w-28 h-28 rounded-full object-cover border border-neutral-700 shadow-lg"
            />
          )}
        </div>

        <div className="flex justify-between items-start px-3 sm:px-6 pb-6 border-b border-neutral-900">
          <button
            type="button"
            className={actionBtn}
            onClick={() => navigate(`/${username}`)}
          >
            <Icons.profile className="w-6 h-6" strokeColor="#fafafa" />
            <span className="text-[11px] text-neutral-300">Profile</span>
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              navigate(`/chat/${username}`, {
                state: { openConversationSearch: true },
              })
            }
          >
            <Icons.search className="w-6 h-6" strokeColor="#fafafa" />
            <span className="text-[11px] text-neutral-300">Search</span>
          </button>
          <button
            type="button"
            className={`${actionBtn} disabled:opacity-40`}
            onClick={handleToggleMute}
            disabled={!prefsLoaded || !chatKey || actionLoading === "mute"}
          >
            {actionLoading === "mute" ? (
              <Icons.spinner className="w-6 h-6 animate-spin text-neutral-400" />
            ) : (
              <Icons.mute className="w-6 h-6 text-neutral-100" />
            )}
            <span className="text-[11px] text-neutral-300">
              {isMuted ? "Unmute" : "Mute"}
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={actionBtn} aria-label="Options">
                <Icons.circleMenu className="w-6 h-6 text-neutral-100" />
                <span className="text-[11px] text-neutral-300">Options</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent sheetTitle="Chat options"
              align="end"
              className="bg-neutral-900 border-neutral-700 rounded-2xl w-56 p-2"
            >
              <DropdownMenuItem
                onClick={handleRestrict}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
              >
                <span>Restrict</span>
                <Icons.restrict className="w-5 h-5" />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={youBlocked ? handleUnblock : handleBlock}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
              >
                <span>{youBlocked ? "Unblock" : "Block"}</span>
                <Icons.block className="w-5 h-5" />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleReport}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
              >
                <span>Report</span>
                <Icons.report className="w-5 h-5" />
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-neutral-700 my-2" />
              <DropdownMenuItem
                onClick={handleDeleteChat}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
              >
                <span>Delete Chat</span>
                <Icons.delete className="w-5 h-5" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="px-3 sm:px-4 pt-2 pb-4 space-y-1 border-b border-neutral-900">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`${settingRow} w-full disabled:opacity-40`}
                disabled={!prefsLoaded || actionLoading === "theme"}
              >
                <span className="flex items-center gap-3 text-sm">
                  <Icons.dark className="w-5 h-5 text-neutral-400 shrink-0" />
                  Theme
                  <span className="text-xs text-neutral-500 capitalize">
                    {theme}
                  </span>
                </span>
                {actionLoading === "theme" ? (
                  <Icons.spinner className="w-4 h-4 animate-spin text-neutral-500 shrink-0" />
                ) : (
                  <Icons.chevronRight className="w-4 h-4 text-neutral-600 shrink-0" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent sheetTitle="Theme"
              align="start"
              className="bg-neutral-900 border-neutral-700 rounded-xl w-52 p-1"
            >
              {THEME_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleThemeSelect(opt.value)}
                  className="rounded-lg cursor-pointer"
                >
                  <span className="flex w-full justify-between items-center gap-2">
                    {opt.label}
                    {theme === opt.value ? (
                      <span className="text-violet-400 text-xs">✓</span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`${settingRow} w-full disabled:opacity-40`}
                disabled={!prefsLoaded || !chatKey || actionLoading === "disappear"}
              >
                <span className="flex items-center gap-3 text-sm min-w-0">
                  <Icons.schedule className="w-5 h-5 text-neutral-400 shrink-0" />
                  <span className="truncate">
                    Disappearing messages
                    <span className="block text-xs text-neutral-500 font-normal mt-0.5">
                      {formatDisappearingLabel(disappearingSeconds)}
                    </span>
                  </span>
                </span>
                {actionLoading === "disappear" ? (
                  <Icons.spinner className="w-4 h-4 animate-spin text-neutral-500 shrink-0" />
                ) : (
                  <Icons.chevronRight className="w-4 h-4 text-neutral-600 shrink-0" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent sheetTitle="Disappearing messages"
              align="start"
              className="bg-neutral-900 border-neutral-700 rounded-xl w-56 p-1"
            >
              {DISAPPEAR_PRESETS.map((opt) => (
                <DropdownMenuItem
                  key={opt.label}
                  onClick={() => handleDisappearingSelect(opt.seconds)}
                  className="rounded-lg cursor-pointer"
                >
                  <span className="flex w-full justify-between items-center gap-2">
                    {opt.label}
                    {(disappearingSeconds === opt.seconds ||
                      (opt.seconds == null && disappearingSeconds == null)) ? (
                      <span className="text-violet-400 text-xs">✓</span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            className={settingRow}
            onClick={() => navigate("/settings")}
          >
            <span className="flex items-center gap-3 text-sm">
              <Icons.lock className="w-5 h-5 text-neutral-400 shrink-0" />
              Privacy &amp; Safety
            </span>
            <Icons.chevronRight className="w-4 h-4 text-neutral-600 shrink-0" />
          </button>
          <button
            type="button"
            className={settingRow}
            onClick={() => showToast("Nicknames — coming soon")}
          >
            <span className="flex items-center gap-3 text-sm">
              <Icons.profileplus className="w-5 h-5 text-neutral-400 shrink-0" />
              Nicknames
            </span>
            <Icons.chevronRight className="w-4 h-4 text-neutral-600 shrink-0" />
          </button>
          <button
            type="button"
            className={settingRow}
            onClick={() =>
              showToast("Use your chat list to start a new group conversation")
            }
          >
            <span className="flex items-center gap-3 text-sm">
              <Icons.group className="w-5 h-5 text-neutral-400 shrink-0" />
              Create a group chat
            </span>
            <Icons.chevronRight className="w-4 h-4 text-neutral-600 shrink-0" />
          </button>
        </div>

        <section className="px-3 sm:px-4 pt-6 pb-10">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">
            Shared Media
          </h2>
          {loadingMedia ? (
            <div className="flex justify-center py-12">
              <Icons.spinner className="w-8 h-8 animate-spin text-neutral-500" />
            </div>
          ) : media.length === 0 ? (
            <p className="text-sm text-neutral-500 text-center py-8">
              No photos or videos shared yet
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5">
              {media.map((item, index) => {
                const src =
                  item.thumbnail ||
                  (item.type === "video" ? item.thumbnail : item.url) ||
                  item.url;
                const isVideo =
                  item.type === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(item.url || "");
                return (
                  <a
                    key={mediaKey(item, index)}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative aspect-square overflow-hidden rounded-sm bg-neutral-900 block group"
                  >
                    <img
                      src={src}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                    {isVideo && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/25 pointer-events-none">
                        <Icons.video className="w-8 h-8 text-white/90 drop-shadow-md" />
                      </div>
                    )}
                  </a>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-sm text-neutral-200 shadow-lg max-w-[90vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
};

export default ConversationDetailsPage;
