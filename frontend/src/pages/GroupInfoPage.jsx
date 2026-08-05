import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Camera, ChevronRight, Link2, Pencil, Users } from "lucide-react";
import { describeMembers } from "../lib/groupMembers";
import GroupInviteSheet from "../components/Chat/GroupInviteSheet";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "react-hot-toast";
import { UserContext } from "../contexts/UserContext";
import { Icons } from "../components/icons";
import { groupAPI } from "../services/api";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const SLOW_MODE_OPTIONS = [
  { label: "Off", seconds: 0 },
  { label: "5 seconds", seconds: 5 },
  { label: "10 seconds", seconds: 10 },
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "5 minutes", seconds: 300 },
];

const MEMBERS_PAGE_SIZE = 30;

const errorMessage = (err, fallback) => err?.response?.data?.error || fallback;

/*
 * `isCurrentlyMuted`, `MEMBER_ACTION_PATCH`, `RoleBadge` and `MemberRow` were all
 * defined here and are now shared — lib/groupMembers.js and Chat/GroupRoleBadge.jsx —
 * because GroupPeoplePage needs the same rules and the same badges. Two screens
 * listing the same members with their own copies is how they drift.
 */

/** The settings switches below. Stays here: nothing else uses it. */
const Toggle = ({ checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={!!checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40 disabled:cursor-default cursor-pointer ${
      checked ? "bg-violet-600" : "bg-neutral-700"
    }`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
        checked ? "translate-x-5" : ""
      }`}
    />
  </button>
);

const GroupInfoPage = () => {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const currentUserId = userAuth?._id || userAuth?.id;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [group, setGroup] = useState(null);
  const [membership, setMembership] = useState(null);

  const [members, setMembers] = useState([]);
  const [membersTotal, setMembersTotal] = useState(0);

  const [editingInfo, setEditingInfo] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [savingInfo, setSavingInfo] = useState(false);

  const [settingsSaving, setSettingsSaving] = useState(false);

  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);

  /*
   * Banned members, listed separately.
   *
   * They're filtered out of the member list by every membership query, so without
   * their own list a ban would be one-way: nothing to select, nothing to lift it
   * from. Only fetched for someone who could ban in the first place — the server
   * gates the `?banned=true` branch on the same permission.
   */
  const [bannedMembers, setBannedMembers] = useState([]);
  const [banTarget, setBanTarget] = useState(null);
  const [banning, setBanning] = useState(false);


  const [inviteOpen, setInviteOpen] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  /*
   * `alive` guards the writes, not just the ones in the effect below.
   *
   * fetchMembers sets four pieces of state of its own, so the effect's own
   * `cancelled` flag protected setGroup/setMembership and nothing else — a
   * StrictMode double-mount, or switching groups mid-flight, wrote the old
   * group's members over the new one's.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /*
   * One page, for the People row's preview only.
   *
   * The full paginated list moved to GroupPeoplePage; this page needs enough rows to
   * name two people and the `total` to count the rest, so it no longer tracks a cursor.
   */
  const fetchMembers = useCallback(async () => {
    const res = await groupAPI.getMembers(groupId, { skip: 0, limit: MEMBERS_PAGE_SIZE });
    if (!alive.current) return;
    setMembers(res.members || []);
    setMembersTotal(res.total ?? 0);
  }, [groupId]);

  /*
   * Declared above the mount effect, which is the whole bug.
   *
   * This was a `const` a hundred lines further down, and the effect below both calls it
   * and lists it in its dependency array — and a dependency array is evaluated *during
   * render*, top to bottom. So every mount of this page threw
   * `ReferenceError: Cannot access 'fetchBannedMembers' before initialization` before
   * the effect ever ran: the group info screen did not render at all.
   */
  const fetchBannedMembers = useCallback(async () => {
    try {
      const res = await groupAPI.getMembers(groupId, { banned: true, limit: 100 });
      if (alive.current) setBannedMembers(res.members || []);
    } catch {
      // A 403 here just means this caller can't ban, so there is nothing to show.
      if (alive.current) setBannedMembers([]);
    }
  }, [groupId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [groupRes] = await Promise.all([groupAPI.getGroup(groupId), fetchMembers()]);
        if (cancelled) return;
        setGroup(groupRes.group);
        setMembership(groupRes.membership);
        // Only worth asking for if this caller can act on it; the endpoint 403s
        // otherwise and fetchBannedMembers swallows that.
        if (groupRes.membership?.permissions?.removeMembers) fetchBannedMembers();
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "This group could not be loaded"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, fetchMembers, fetchBannedMembers]);


  /*
   * Name and photo are open to any member who can post, matching every other messenger
   * — a typo in a group's name shouldn't need an admin. `sendMessages` rather than an
   * unconditional yes, so someone with the `restricted` role (silenced in this group)
   * can't rename it instead. The server applies the same rule, and every change writes a
   * system notice naming who made it.
   *
   * Governance — slow mode, media sharing, history visibility — stays admin-only.
   *
   * Read off `membership` rather than the `permissions` const further down: that one is
   * declared *after* the loading and error early-returns, so referencing it up here would
   * be a temporal-dead-zone crash on every render — the same trap `fetchBannedMembers`
   * fell into in this very file.
   */
  const canEditIdentity = !!membership?.permissions?.sendMessages;

  const handleAvatarChange = async (event) => {
    const file = event.target.files?.[0];
    // Reset immediately: without this, picking the same file twice in a row fires no
    // change event the second time.
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("That image is too large (10MB max)");
      return;
    }

    setUploadingAvatar(true);
    try {
      const res = await groupAPI.updateAvatar(groupId, file);
      // The server's URL, not a local preview: the preview would be a blob URL that
      // dies on reload, and the difference wouldn't show up until then.
      setGroup((g) => ({ ...g, avatar: res.avatar }));
      toast.success("Group photo updated");
    } catch (err) {
      toast.error(errorMessage(err, "Could not update the photo"));
    } finally {
      if (alive.current) setUploadingAvatar(false);
    }
  };

  const startEditingInfo = () => {
    setNameDraft(group.name || "");
    setDescDraft(group.description || "");
    setEditingInfo(true);
  };

  const handleSaveInfo = async () => {
    setSavingInfo(true);
    try {
      const trimmedName = nameDraft.trim();
      const res = await groupAPI.updateGroup(groupId, {
        name: trimmedName,
        description: descDraft,
      });
      setGroup((g) => ({
        ...g,
        name: res?.group?.name ?? trimmedName,
        description: res?.group?.description ?? descDraft,
      }));
      setEditingInfo(false);
      toast.success("Group info updated");
    } catch (err) {
      // Drafts and edit mode are left untouched on failure — the user's typed
      // text must survive a rejected save, not vanish with it.
      toast.error(errorMessage(err, "Could not update group info"));
    } finally {
      setSavingInfo(false);
    }
  };

  const updateSetting = async (patch) => {
    const prevSettings = group.settings;
    const nextSettings = { ...prevSettings, ...patch };
    setGroup((g) => ({ ...g, settings: nextSettings }));
    setSettingsSaving(true);
    try {
      await groupAPI.updateGroup(groupId, { settings: nextSettings });
    } catch (err) {
      setGroup((g) => ({ ...g, settings: prevSettings }));
      toast.error(errorMessage(err, "Could not update settings"));
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSlowModeChange = (seconds) => updateSetting({ slowModeSeconds: seconds });
  const handleToggleMediaSharing = () =>
    updateSetting({ mediaSharing: !group.settings?.mediaSharing });
  /*
   * No-ops when the value hasn't changed, because `updateGroup` answers 400 for an empty
   * update and re-selecting the current option would surface that as a failed save.
   *
   * Worth knowing what this does *not* do: a client that already holds the thread keeps
   * rendering it until it refetches. The setting governs what the server will hand out
   * from now on, not what has already been delivered — nothing can recall that, and the
   * value of switching to `hidden` is about members who join later rather than about
   * retracting history from the people already reading it.
   */
  const handleMessageHistoryChange = async (messageHistory) => {
    if (messageHistory === (group.settings?.messageHistory ?? "visible")) return;
    await updateSetting({ messageHistory });
  };


  const confirmRemoveMember = async () => {
    if (!removeTarget) return;
    const userId = removeTarget.user._id;
    setRemoving(true);
    try {
      await groupAPI.removeMember(groupId, userId);
      setMembers((prev) => prev.filter((m) => m.user?._id !== userId));
      setMembersTotal((t) => Math.max(0, t - 1));
      setRemoveTarget(null);
      toast.success("Member removed");
    } catch (err) {
      toast.error(errorMessage(err, "Could not remove member"));
    } finally {
      setRemoving(false);
    }
  };

  const confirmBanMember = async () => {
    if (!banTarget) return;
    const userId = banTarget.user._id;
    setBanning(true);
    try {
      const res = await groupAPI.setMemberBan(groupId, userId, true);
      // Out of the member list and into the banned one, from the row the server
      // returned rather than the one this page was holding.
      setMembers((prev) => prev.filter((m) => m.user?._id !== userId));
      setBannedMembers((prev) => [
        res.member ?? banTarget,
        // Idempotent: a retry, or a second admin banning the same person first,
        // answers `changed: false` and must not add a duplicate row.
        ...prev.filter((m) => m.user?._id !== userId),
      ]);
      /*
       * Only when this request is what changed it.
       *
       * The endpoint is idempotent and reports `changed`, so decrementing
       * unconditionally took the member total down twice for one ban — once on the
       * request that banned them and again on a retry that found them already
       * banned.
       */
      if (res.changed !== false) setMembersTotal((t) => Math.max(0, t - 1));
      setBanTarget(null);
      toast.success("Member banned");
    } catch (err) {
      toast.error(errorMessage(err, "Could not ban member"));
    } finally {
      setBanning(false);
    }
  };

  const handleUnban = async (member) => {
    const userId = member.user._id;
    try {
      await groupAPI.setMemberBan(groupId, userId, false);
      setBannedMembers((prev) => prev.filter((m) => m.user?._id !== userId));
      /*
       * Refetched rather than spliced back in. An unban restores a membership row
       * whose joinedAt decides where it belongs in the list, and this page pages
       * by skip — inserting locally would put them in the wrong place and throw
       * the paging offsets out by one.
       */
      await fetchMembers();
      toast.success("Ban lifted");
    } catch (err) {
      toast.error(errorMessage(err, "Could not lift the ban"));
    }
  };






  const handleLeaveGroup = async () => {
    setLeaving(true);
    try {
      const res = await groupAPI.leaveGroup(groupId);
      if (res?.groupClosed) {
        toast.success("Group closed — you were the last member");
      }
      navigate("/chat");
    } catch (err) {
      toast.error(errorMessage(err, "Could not leave group"));
      setLeaving(false);
      setLeaveConfirmOpen(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-black text-white min-h-0">
        <Icons.spinner className="w-8 h-8 animate-spin text-neutral-500" />
      </div>
    );
  }

  if (loadError || !group || !membership) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden bg-black text-white min-h-0">
        <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
          <button
            type="button"
            onClick={() => navigate("/chat")}
            className="text-neutral-400 hover:text-white transition-colors p-1 -ml-1"
            aria-label="Go back"
          >
            <Icons.back className="w-5 h-5" />
          </button>
          <h1 className="flex-1 text-center text-sm font-semibold text-neutral-200 truncate">
            Group info
          </h1>
          <span className="w-7" aria-hidden="true" />
        </header>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-neutral-400">
            {loadError || "This group could not be found"}
          </p>
          <button
            type="button"
            onClick={() => navigate("/chat")}
            className="px-4 py-2 rounded-lg bg-white text-black text-sm font-medium"
          >
            Back to chats
          </button>
        </div>
      </div>
    );
  }

  const permissions = membership.permissions || {};

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-black text-white min-h-0">
      <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
        <button
          type="button"
          onClick={() => navigate(`/chat/group/${groupId}`)}
          className="text-neutral-400 hover:text-white transition-colors p-1 -ml-1"
          aria-label="Go back"
        >
          <Icons.back className="w-5 h-5" />
        </button>
        <h1 className="flex-1 text-center text-sm font-semibold text-neutral-200 truncate">
          {group.name}
        </h1>
        <span className="w-7" aria-hidden="true" />
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="flex flex-col items-center pt-8 pb-6 px-4 border-b border-neutral-900">
          {/*
            The photo, now changeable. `Group.avatar` existed from the start with no
            write path anywhere — no endpoint, no upload, no UI — so every group has
            shown the default image since the feature was written.
          */}
          <div className="relative">
            <img
              // `/default-group-avatar.png`, which is what the server defaults to. This
              // read `/default-avatar.png` — the *person* placeholder — so a group with
              // no photo showed a generic human silhouette.
              src={group.avatar || "/default-group-avatar.png"}
              alt=""
              className="w-24 h-24 rounded-full object-cover border border-neutral-700 shadow-lg bg-neutral-900"
            />
            {canEditIdentity && (
              <>
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  aria-label="Change group photo"
                  className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-white text-black flex items-center justify-center shadow-lg border-2 border-black active:scale-90 transition-transform disabled:opacity-60"
                >
                  {uploadingAvatar ? (
                    <Icons.spinner className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Camera className="w-4 h-4" strokeWidth={2.2} />
                  )}
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  className="hidden"
                  onChange={handleAvatarChange}
                />
              </>
            )}
          </div>

          {/* Tap the name to rename, for anyone who can post in the group. */}
          {canEditIdentity ? (
            <button
              type="button"
              onClick={startEditingInfo}
              className="mt-3 flex items-center gap-1.5 group/name"
            >
              <h2 className="text-lg font-semibold text-white text-center">
                {group.name}
              </h2>
              <Pencil className="w-3.5 h-3.5 text-neutral-500 group-hover/name:text-white transition-colors" />
            </button>
          ) : (
            <h2 className="mt-3 text-lg font-semibold text-white text-center">
              {group.name}
            </h2>
          )}

          <p className="text-sm text-neutral-500 mt-1">
            {membersTotal} members ·{" "}
            {group.type === "public" ? "Public" : "Private"} group
          </p>
        </div>

        <section className="px-3 sm:px-4 py-5 border-b border-neutral-900">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              About
            </h2>
            {permissions.changeGroupInfo && !editingInfo && (
              <button
                type="button"
                onClick={startEditingInfo}
                className="text-neutral-400 hover:text-white transition-colors"
                aria-label="Edit group info"
              >
                <Icons.edit className="w-4 h-4" />
              </button>
            )}
          </div>

          {editingInfo ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Name</label>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={100}
                  className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-500"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Description</label>
                <textarea
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  rows={3}
                  maxLength={500}
                  className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-neutral-500"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setEditingInfo(false)}
                  disabled={savingInfo}
                  className="px-3 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveInfo}
                  disabled={savingInfo || !nameDraft.trim()}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white text-black disabled:opacity-50"
                >
                  {savingInfo ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-neutral-300 whitespace-pre-wrap">
              {group.description || "No description yet"}
            </p>
          )}
        </section>

        {permissions.changeGroupInfo && (
          <section className="px-3 sm:px-4 py-5 border-b border-neutral-900">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">
              Settings
            </h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white">Slow mode</p>
                  <p className="text-xs text-neutral-500">
                    Limit how often members can send messages
                  </p>
                </div>
                <select
                  value={group.settings?.slowModeSeconds ?? 0}
                  onChange={(e) => handleSlowModeChange(Number(e.target.value))}
                  disabled={settingsSaving}
                  className="rounded-lg bg-neutral-900 border border-neutral-700 text-sm text-white px-2 py-1.5 focus:outline-none focus:border-neutral-500 disabled:opacity-50 shrink-0"
                >
                  {SLOW_MODE_OPTIONS.map((opt) => (
                    <option key={opt.seconds} value={opt.seconds}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-sm text-white">Media sharing</p>
                <Toggle
                  checked={!!group.settings?.mediaSharing}
                  onChange={handleToggleMediaSharing}
                  disabled={settingsSaving}
                />
              </div>
              {/*
                * A select rather than a Toggle, because the two states aren't on and off —
                * "hidden" is the restrictive one and a toggle gives no room to say what it
                * restricts. The default is spelled out for the same reason: an admin needs
                * to know which way round it is before flipping it.
                */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white">Message history</p>
                  <p className="text-xs text-neutral-500">
                    {group.settings?.messageHistory === "hidden"
                      ? "Members only see messages sent after they joined"
                      : "New members can read the whole history"}
                  </p>
                </div>
                <select
                  value={group.settings?.messageHistory ?? "visible"}
                  onChange={(e) => handleMessageHistoryChange(e.target.value)}
                  disabled={settingsSaving}
                  className="rounded-lg bg-neutral-900 border border-neutral-700 text-sm text-white px-2 py-1.5 focus:outline-none focus:border-neutral-500 disabled:opacity-50 shrink-0"
                >
                  <option value="visible">Visible to all</option>
                  <option value="hidden">Hidden before joining</option>
                </select>
              </div>
            </div>
          </section>
        )}

        {/*
          People, as one row into its own page.
          The full list used to render here — every member, with pagination, wedged
          between the settings and the banned list. On a group of any size that meant
          scrolling past everything to reach "Leave group", and there was nowhere to put
          per-person actions that wasn't already crowded. The row names two people the
          viewer is likely to recognise and counts the rest.
        */}
        {/*
          Invite link, above People — it's how you get people in, so it belongs next to
          the list of who's already there.
        */}
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="w-full py-4 px-3 sm:px-4 border-b border-neutral-900 flex items-center gap-3 text-left hover:bg-neutral-950 transition-colors"
        >
          <span className="w-9 h-9 rounded-full bg-neutral-900 flex items-center justify-center shrink-0">
            <Link2 className="w-[18px] h-[18px] text-neutral-300" strokeWidth={2.1} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] font-medium">Invite link</span>
            <span className="block text-xs text-neutral-500">
              Anyone can join with this link
            </span>
          </span>
          <ChevronRight className="w-4 h-4 text-neutral-500 shrink-0" strokeWidth={2.1} />
        </button>

        <button
          type="button"
          onClick={() => navigate(`/chat/group/${groupId}/people`)}
          className="w-full py-4 px-3 sm:px-4 border-b border-neutral-900 flex items-center gap-3 text-left hover:bg-neutral-950 transition-colors"
        >
          <span className="w-9 h-9 rounded-full bg-neutral-900 flex items-center justify-center shrink-0">
            <Users className="w-[18px] h-[18px] text-neutral-300" strokeWidth={2.1} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] font-medium">People</span>
            <span className="block text-xs text-neutral-500 truncate">
              {describeMembers(members, currentUserId, membersTotal)}
            </span>
          </span>
          <span className="text-sm text-neutral-500 shrink-0">{membersTotal}</span>
          <ChevronRight className="w-4 h-4 text-neutral-500 shrink-0" strokeWidth={2.1} />
        </button>

        {/*
          * Banned members. The only place a ban can be lifted from — they're
          * filtered out of the member list by every membership query, so a ban
          * with no list to review would be permanent by accident.
          */}
        {permissions.removeMembers && bannedMembers.length > 0 && (
          <section className="py-5 border-b border-neutral-900">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1 px-3 sm:px-4">
              Banned ({bannedMembers.length})
            </h2>
            <div className="divide-y divide-neutral-900">
              {bannedMembers.map((m) => (
                <div key={m._id} className="flex items-center gap-3 px-3 sm:px-4 py-2.5">
                  <img
                    src={m.user?.profilePic || "/default-avatar.png"}
                    alt=""
                    className="w-11 h-11 rounded-full object-cover border border-neutral-800 shrink-0 opacity-60"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-neutral-300 truncate block">
                      {m.user?.name || m.user?.username}
                    </span>
                    <p className="text-xs text-neutral-500 truncate">
                      @{m.user?.username}
                      {m.banReason ? ` — ${m.banReason}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleUnban(m)}
                    className="shrink-0 rounded-full bg-neutral-800 px-3 py-1.5 text-xs text-white hover:bg-neutral-700"
                  >
                    Lift ban
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}


        <section className="px-3 sm:px-4 py-6">
          <button
            type="button"
            onClick={() => setLeaveConfirmOpen(true)}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-red-900/50 text-red-500 text-sm font-medium py-2.5 hover:bg-red-950/30 transition-colors"
          >
            <Icons.logout className="w-4 h-4" />
            Leave group
          </button>
        </section>
      </div>

      {inviteOpen && (
        <GroupInviteSheet
          groupId={groupId}
          group={group}
          memberCount={membersTotal}
          onClose={() => setInviteOpen(false)}
        />
      )}

      {leaveConfirmOpen && (
        <ConfirmDialog
          title="Leave this group?"
          confirmLabel="Leave"
          busy={leaving}
          onConfirm={handleLeaveGroup}
          onCancel={() => setLeaveConfirmOpen(false)}
        >
          {membership.role === "super_admin"
            ? "You're the owner. Leaving will pass ownership to the longest-serving admin."
            : "You won't be able to see this group's messages again unless someone adds you back."}
        </ConfirmDialog>
      )}

      {removeTarget && (
        <ConfirmDialog
          title={`Remove ${removeTarget.user?.name || removeTarget.user?.username} from the group?`}
          confirmLabel="Remove"
          busy={removing}
          onConfirm={confirmRemoveMember}
          onCancel={() => setRemoveTarget(null)}
        >
          They'll need to be added back to rejoin.
        </ConfirmDialog>
      )}

      {banTarget && (
        <ConfirmDialog
          title={`Ban ${banTarget.user?.name || banTarget.user?.username} from the group?`}
          confirmLabel="Ban"
          busy={banning}
          onConfirm={confirmBanMember}
          onCancel={() => setBanTarget(null)}
        >
          They'll be removed and can't be added back until the ban is lifted from
          the Banned list.
        </ConfirmDialog>
      )}
    </div>
  );
};

export default GroupInfoPage;
