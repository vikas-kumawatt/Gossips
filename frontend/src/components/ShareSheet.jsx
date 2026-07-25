import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import CreateGroupShareSheet from "./CreateGroupShareSheet";
import { Icons } from "./icons";
import { shareAPI } from "../services/api";
import {
  EXTERNAL_TARGETS,
  buildShareUrl,
  canUseNativeShare,
  nativeShare,
  openShareTarget,
} from "../lib/shareTargets";

/**
 * ShareSheet — send a post or comment into DMs, or out to another app.
 *
 * With people picked, the external row is hidden: the sheet is committed to
 * sending, and leaving nine other destinations on screen invites a misclick
 * that abandons the selection.
 */
const ShareSheet = ({ targetType, targetId, postId, authorUsername, previewText, onClose }) => {
  const [query, setQuery] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]); // [{ id, name, username, profilePic, isGroup }]
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState([]);
  const [copied, setCopied] = useState(false);
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);

  // A comment lives on its parent post's page, so both link to the post.
  const shareUrl = useMemo(
    () => buildShareUrl({ username: authorUsername, postId: postId || targetId }),
    [authorUsername, postId, targetId]
  );
  const shareText = previewText?.trim()
    ? previewText.trim().slice(0, 120)
    : "Check this out on Gossips";

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      setData(await shareAPI.targets({ q: q || undefined }));
    } catch {
      setData({ targets: [], groups: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => load(query), query ? 250 : 0);
    return () => clearTimeout(id);
  }, [query, load]);

  const isSelected = (id) => selected.some((s) => s.id === id);

  const toggle = (entry) =>
    setSelected((prev) =>
      prev.some((s) => s.id === entry.id)
        ? prev.filter((s) => s.id !== entry.id)
        : [...prev, entry]
    );

  const peopleSelected = selected.filter((s) => !s.isGroup);
  const multiple = selected.length > 1;

  const send = async ({ asGroup = false } = {}) => {
    if (!selected.length || sending) return;
    setSending(true);

    const groupIds = selected.filter((s) => s.isGroup).map((s) => s.id);
    const personIds = peopleSelected.map((s) => s.id);

    try {
      const res = await shareAPI.send({
        targetType,
        targetId,
        note: note.trim() || undefined,
        groupIds,
        ...(asGroup ? { newGroupMemberIds: personIds } : { recipientIds: personIds }),
      });

      if (res.sent?.length) {
        // Only ids the server confirmed — a rejected recipient marked "Sent"
        // also gets its row disabled, which makes retrying impossible.
        const deliveredIds = res.sent.map((s) => s.id);
        setSentTo((prev) => [...prev, ...deliveredIds]);
        setSelected((prev) => prev.filter((s) => !deliveredIds.includes(s.id)));
        setNote("");
        toast.success(res.message);
      }
      if (res.failed?.length) {
        const first = res.failed[0];
        toast.error(
          res.failed.length === 1
            ? `${first.username ? `@${first.username}: ` : ""}${first.reason}`
            : `Couldn't send to ${res.failed.length} of them`
        );
      }
    } catch (error) {
      toast.error(error.response?.data?.error || "Couldn't send");
    } finally {
      setSending(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const openExternal = async (target) => {
    if (target.copyOnly) {
      await navigator.clipboard.writeText(shareUrl).catch(() => {});
      toast.success(target.note || "Link copied");
    }
    openShareTarget(target, shareUrl, shareText);
  };

  const targets = data?.targets || [];
  const groups = data?.groups || [];

  if (groupSheetOpen) {
    return (
      <CreateGroupShareSheet
        targetType={targetType}
        targetId={targetId}
        onSent={onClose}
        onClose={() => setGroupSheetOpen(false)}
      />
    );
  }

  return (
    <ResponsiveSheet onClose={onClose} title="Share" scrollBody={false}>
      {/* A flex item, not h-full — see the note in ResponsiveSheet. */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Search + new group, one line */}
        <div className="shrink-0 px-4 pt-3 pb-2 flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
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

          <button
            type="button"
            onClick={() => setGroupSheetOpen(true)}
            title="New group"
            aria-label="New group"
            className="shrink-0 w-[42px] h-[42px] rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-center hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            <Icons.newGroup />
          </button>
        </div>

        {/* Recipients */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-2">
          {loading && !data ? (
            <div className="flex items-center justify-center py-14">
              <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
            </div>
          ) : !targets.length && !groups.length ? (
            <p className="py-14 text-center text-neutral-500 text-sm">
              {query ? "No one matches that." : "No one to share with yet."}
            </p>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-1">
              {groups.map((group) => (
                <RecipientCell
                  key={group._id}
                  label={group.name}
                  avatar={group.avatar}
                  selected={isSelected(group._id)}
                  sent={sentTo.includes(group._id)}
                  onClick={() => toggle({ id: group._id, name: group.name, isGroup: true })}
                />
              ))}

              {targets.map(({ user }) => (
                <RecipientCell
                  key={user._id}
                  label={user.name || user.username}
                  avatar={user.profilePic}
                  verified={user.isVerified}
                  selected={isSelected(user._id)}
                  sent={sentTo.includes(user._id)}
                  onClick={() =>
                    toggle({
                      id: user._id,
                      username: user.username,
                      name: user.name,
                      profilePic: user.profilePic,
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* Send — one recipient */}
        {selected.length === 1 && (
          <div className="shrink-0 px-4 py-3 border-t border-neutral-800 flex flex-col gap-2.5">
            <MessageInput value={note} onChange={setNote} onEnter={() => send()} />
            <button
              type="button"
              onClick={() => send()}
              disabled={sending}
              className="w-full py-3 rounded-xl bg-white text-black text-[15px] font-semibold hover:bg-neutral-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
            >
              {sending && <Loader2 className="w-4 h-4 animate-spin" />}
              Send
            </button>
          </div>
        )}

        {/* Send — several recipients */}
        {multiple && (
          <div className="shrink-0 px-4 py-3 border-t border-neutral-800 flex flex-col gap-2.5">
            <MessageInput value={note} onChange={setNote} onEnter={() => send()} />

            <button
              type="button"
              onClick={() => send()}
              disabled={sending}
              className="w-full py-3 rounded-xl bg-white text-black text-[15px] font-semibold hover:bg-neutral-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
            >
              {sending && <Loader2 className="w-4 h-4 animate-spin" />}
              Send separately
            </button>

            {/* A group needs at least two people; selected groups can't join one. */}
            {peopleSelected.length >= 2 && (
              <button
                type="button"
                onClick={() => send({ asGroup: true })}
                disabled={sending}
                className="w-full py-2.5 rounded-xl border border-neutral-700 hover:bg-neutral-800 transition-colors disabled:opacity-50 flex items-center justify-center gap-3 cursor-pointer"
              >
                <AvatarStack people={peopleSelected} />
                <span className="text-[15px] font-semibold text-white">
                  Send to new group chat ({peopleSelected.length})
                </span>
              </button>
            )}
          </div>
        )}

        {/* External destinations — hidden once the sheet is committed to sending */}
        {selected.length === 0 && (
          <div className="shrink-0 border-t border-neutral-800 pt-3 pb-2">
            <div className="flex gap-1 overflow-x-auto custom-scrollbar px-3 pb-1">
              <ExternalCell label={copied ? "Copied" : "Copy link"} onClick={copyLink}>
                {copied ? <Icons.checkCircle /> : <Icons.copy />}
              </ExternalCell>

              {canUseNativeShare() && (
                <ExternalCell label="More" onClick={() => nativeShare(shareUrl, shareText)}>
                  <Icons.shareTo />
                </ExternalCell>
              )}

              {EXTERNAL_TARGETS.map((target) => {
                const Icon = Icons[target.icon];
                return (
                  <ExternalCell
                    key={target.id}
                    label={target.label}
                    onClick={() => openExternal(target)}
                  >
                    {Icon ? <Icon /> : null}
                  </ExternalCell>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </ResponsiveSheet>
  );
};

const MessageInput = ({ value, onChange, onEnter }) => (
  <input
    value={value}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={(e) => e.key === "Enter" && onEnter()}
    placeholder="Write a message…"
    maxLength={1000}
    className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3.5 py-2.5 text-[15px] text-white placeholder:text-neutral-500 outline-none focus:border-neutral-600"
  />
);

/** Overlapping avatars, capped at three with a +N chip beyond that. */
const AvatarStack = ({ people }) => {
  const shown = people.slice(0, 3);
  const extra = people.length - shown.length;

  return (
    <span className="flex items-center shrink-0">
      {shown.map((p, i) => (
        <img
          key={p.id}
          src={p.profilePic || "https://via.placeholder.com/28"}
          alt=""
          className="w-7 h-7 rounded-full object-cover bg-neutral-800 border-2 border-[#181818]"
          style={{ marginLeft: i === 0 ? 0 : -10 }}
        />
      ))}
      {extra > 0 && (
        <span
          className="w-7 h-7 rounded-full bg-neutral-700 border-2 border-[#181818] flex items-center justify-center text-[10px] font-semibold text-white"
          style={{ marginLeft: -10 }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
};

const RecipientCell = ({ label, avatar, verified, selected, sent, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={sent}
    className={`flex flex-col items-center gap-1.5 p-2 rounded-xl transition-colors cursor-pointer disabled:cursor-default ${
      selected ? "bg-neutral-800" : "hover:bg-neutral-900"
    }`}
  >
    <span className="relative">
      <img
        src={avatar || "https://via.placeholder.com/56"}
        alt=""
        className={`w-14 h-14 rounded-full object-cover bg-neutral-800 ${sent ? "opacity-40" : ""}`}
      />
      {selected && (
        <span className="absolute -bottom-0.5 -right-0.5">
          <Icons.checkCircle color="#3b82f6" />
        </span>
      )}
    </span>
    <span className="flex items-center gap-0.5 max-w-full">
      <span className="text-[11px] text-white text-center leading-tight truncate">
        {sent ? "Sent" : label}
      </span>
      {verified && !sent && <Icons.verified />}
    </span>
  </button>
);

const ExternalCell = ({ label, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex flex-col items-center gap-1.5 p-2 rounded-xl hover:bg-neutral-900 transition-colors cursor-pointer shrink-0 w-[68px]"
  >
    <span className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center">
      {children}
    </span>
    <span className="text-[11px] text-neutral-400 text-center leading-tight truncate w-full">
      {label}
    </span>
  </button>
);

export default ShareSheet;
