import { useCallback, useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { shareAPI } from "../services/api";

/**
 * Pick people for a brand-new group and send the post into it.
 *
 * Opened from the share sheet's group button. Kept as its own sheet rather
 * than a mode of ShareSheet — the two have different inputs, different lists
 * and a different send action, and folding them together made both harder to
 * follow.
 */
const CreateGroupShareSheet = ({ targetType, targetId, onSent, onClose }) => {
  const [groupName, setGroupName] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  // Locally hidden ids, so a removed suggestion disappears before the refetch.
  const [hidden, setHidden] = useState([]);
  const [confirmHide, setConfirmHide] = useState(null);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      const res = await shareAPI.targets({ q: q || undefined });
      setPeople(res.targets || []);
    } catch {
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => load(query), query ? 250 : 0);
    return () => clearTimeout(id);
  }, [query, load]);

  const toggle = (user) => {
    setSelected((prev) =>
      prev.some((s) => s._id === user._id)
        ? prev.filter((s) => s._id !== user._id)
        : [...prev, user]
    );
  };

  const hideSuggestion = async (user) => {
    setHidden((prev) => [...prev, user._id]);
    setSelected((prev) => prev.filter((s) => s._id !== user._id));
    setConfirmHide(null);
    try {
      await shareAPI.hideSuggestion(user._id);
    } catch {
      // Put it back rather than pretend it worked.
      setHidden((prev) => prev.filter((id) => id !== user._id));
      toast.error("Couldn't hide that suggestion");
    }
  };

  const send = async () => {
    if (selected.length < 2 || sending) return;
    setSending(true);
    try {
      const res = await shareAPI.send({
        targetType,
        targetId,
        newGroupMemberIds: selected.map((s) => s._id),
        groupName: groupName.trim() || undefined,
        note: note.trim() || undefined,
      });

      if (res.sent?.length) {
        toast.success(res.message);
        onSent?.();
        onClose();
        return;
      }
      toast.error(res.failed?.[0]?.reason || "Couldn't create the group");
    } catch (error) {
      toast.error(error.response?.data?.error || "Couldn't create the group");
    } finally {
      setSending(false);
    }
  };

  const visible = people.filter(({ user }) => !hidden.includes(user._id));

  return (
    <ResponsiveSheet onClose={onClose} title="New group" onBack={onClose} scrollBody={false}>
      {/* A flex item, not h-full — see the note in ResponsiveSheet. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 px-4 pt-3 pb-2 flex flex-col gap-2.5">
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name (optional)"
            maxLength={100}
            className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3.5 py-2.5 text-[15px] text-white placeholder:text-neutral-500 outline-none focus:border-neutral-600"
          />

          <div className="relative">
            <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-9 py-2.5 text-[15px] text-white placeholder:text-neutral-500 outline-none focus:border-neutral-600"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-neutral-800 cursor-pointer"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5 text-neutral-400" />
              </button>
            )}
          </div>

          {/* Chosen people, directly under the search so the picks stay visible */}
          {selected.length > 0 && (
            <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-1 -mx-1 px-1">
              {selected.map((user) => (
                <button
                  key={user._id}
                  type="button"
                  onClick={() => toggle(user)}
                  className="relative shrink-0 flex flex-col items-center gap-1 w-[58px] cursor-pointer group"
                >
                  <span className="relative">
                    <img
                      src={user.profilePic || "https://via.placeholder.com/48"}
                      alt=""
                      className="w-12 h-12 rounded-full object-cover bg-neutral-800"
                    />
                    <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-neutral-700 border border-[#181818] flex items-center justify-center group-hover:bg-neutral-600">
                      <X className="w-2.5 h-2.5 text-white" />
                    </span>
                  </span>
                  <span className="text-[10px] text-neutral-400 truncate w-full text-center leading-tight">
                    {user.name?.split(" ")[0] || user.username}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Suggestions / results */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-2 pb-2">
          {loading && !people.length ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
            </div>
          ) : !visible.length ? (
            <p className="py-12 text-center text-neutral-500 text-sm">
              {query ? "No one matches that." : "No suggestions left."}
            </p>
          ) : (
            <ul className="flex flex-col">
              {visible.map(({ user }) => {
                const picked = selected.some((s) => s._id === user._id);
                return (
                  <li key={user._id} className="flex items-center gap-3 px-2">
                    <button
                      type="button"
                      onClick={() => toggle(user)}
                      className="flex-1 min-w-0 flex items-center gap-3 py-2.5 text-left cursor-pointer"
                    >
                      <img
                        src={user.profilePic || "https://via.placeholder.com/44"}
                        alt=""
                        className="w-11 h-11 rounded-full object-cover bg-neutral-800 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1">
                          <span className="text-[15px] text-white truncate">
                            {user.name || user.username}
                          </span>
                          {user.isVerified && <Icons.verified />}
                        </span>
                      </span>
                      <span
                        className={`w-[22px] h-[22px] rounded-full border shrink-0 flex items-center justify-center ${
                          picked ? "border-transparent" : "border-neutral-600"
                        }`}
                      >
                        {picked && <Icons.checkCircle color="#3b82f6" />}
                      </span>
                    </button>

                    {/* Only suggestions can be dismissed; search results can't. */}
                    {!query && (
                      <button
                        type="button"
                        onClick={() => setConfirmHide(user)}
                        className="p-1.5 rounded-full hover:bg-neutral-800 shrink-0 cursor-pointer"
                        aria-label={`Hide ${user.username} from suggestions`}
                      >
                        <X className="w-4 h-4 text-neutral-500" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selected.length >= 2 && (
          <div className="shrink-0 px-4 py-3 border-t border-neutral-800 flex flex-col gap-2.5">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Write a message…"
              maxLength={1000}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3.5 py-2.5 text-[15px] text-white placeholder:text-neutral-500 outline-none focus:border-neutral-600"
            />
            <button
              type="button"
              onClick={send}
              disabled={sending}
              className="w-full py-3 rounded-xl bg-white text-black text-[15px] font-semibold hover:bg-neutral-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
            >
              {sending && <Loader2 className="w-4 h-4 animate-spin" />}
              Send to group ({selected.length})
            </button>
          </div>
        )}

        {selected.length === 1 && (
          <p className="shrink-0 px-4 py-3 border-t border-neutral-800 text-[13px] text-neutral-500 text-center">
            Pick one more person to start a group.
          </p>
        )}
      </div>

      {confirmHide && (
        <HideConfirm
          user={confirmHide}
          onCancel={() => setConfirmHide(null)}
          onConfirm={() => hideSuggestion(confirmHide)}
        />
      )}
    </ResponsiveSheet>
  );
};

/**
 * Rendered inside the sheet's own portal, above its content — a second
 * ResponsiveSheet would fight the first one's scroll lock and backdrop.
 */
const HideConfirm = ({ user, onCancel, onConfirm }) => (
  <div
    className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/80 px-4"
    onClick={onCancel}
  >
    <div
      className="w-full max-w-[320px] rounded-2xl bg-[#1A1A1A] border border-neutral-700 overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-5 pt-5 pb-4 text-center border-b border-neutral-700">
        <h2 className="text-[17px] font-bold text-white">Hide from suggestions</h2>
        <p className="mt-2 text-neutral-400 text-[13px] leading-relaxed">
          {user.username} will no longer show as a suggestion to message.
        </p>
      </div>
      <button
        type="button"
        onClick={onConfirm}
        className="w-full py-3 text-red-500 font-semibold text-[15px] hover:bg-neutral-800 cursor-pointer"
      >
        Hide
      </button>
      <div className="border-t border-neutral-700" />
      <button
        type="button"
        onClick={onCancel}
        className="w-full py-3 font-medium text-[15px] text-white hover:bg-neutral-800 cursor-pointer"
      >
        Cancel
      </button>
    </div>
  </div>
);

export default CreateGroupShareSheet;
