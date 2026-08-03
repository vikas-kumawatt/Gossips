import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "react-hot-toast";
import { UserContext } from "../contexts/UserContext";
import { Icons } from "../components/icons";
import api, { groupAPI } from "../services/api";
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

const isCurrentlyMuted = (mutedUntil) =>
  !!mutedUntil && new Date(mutedUntil) > new Date();

const MEMBER_ACTION_PATCH = {
  make_admin: { role: "admin" },
  remove_admin: { role: "member" },
  restrict: { role: "restricted" },
  unrestrict: { role: "member" },
  unmute: { mutedUntil: null },
};

/**
 * Same on/off pill used for the admin settings page. Kept local rather than
 * imported from components/admin/ui — that file is scoped to /admin pages,
 * and this one is a two-state control, not worth a shared dependency for.
 */
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

const RoleBadge = ({ role }) => {
  if (role === "restricted") {
    // Restricted is a state with real consequences — they can't send anything —
    // and it was visible only by opening the menu and reading whether it
    // offered "Restrict" or "Un-restrict".
    return (
      <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 text-[11px] font-medium shrink-0">
        Restricted
      </span>
    );
  }
  if (role === "super_admin") {
    return (
      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[11px] font-medium shrink-0">
        Owner
      </span>
    );
  }
  if (role === "admin") {
    return (
      <span className="px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400 text-[11px] font-medium shrink-0">
        Admin
      </span>
    );
  }
  return null;
};

/**
 * One member row. Network calls and optimistic state live on the page; this
 * only renders and reports the intent, so the row stays a plain function
 * declared once at module scope instead of a closure recreated every render.
 */
const MemberRow = ({ member, isSelf, permissions, onAction }) => {
  const { user, role, mutedUntil } = member;
  const muted = isCurrentlyMuted(mutedUntil);
  /*
   * Rank matters, not just the permission bit.
   *
   * The server refuses everything against a super_admin whoever asks, and
   * refuses anything touching an *admin* unless the caller is the owner —
   * `removeMembers` is true for every admin, so gating on it alone offered
   * three menu items that would come back 403 whenever one admin acted on
   * another.
   */
  const outranked = role !== "super_admin" && (role !== "admin" || !!permissions?.manageAdmins);
  const canManageAdmins = !!permissions?.manageAdmins && role !== "super_admin";
  const canModerate = !!permissions?.removeMembers && outranked;
  const showMenu = !isSelf && (canManageAdmins || canModerate);

  return (
    <div className="flex items-center gap-3 px-3 sm:px-4 py-2.5">
      <img
        src={user?.profilePic || "/default-avatar.png"}
        alt=""
        className="w-11 h-11 rounded-full object-cover border border-neutral-800 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium text-white truncate">
            {user?.name || user?.username}
          </span>
          {user?.isVerified && <Icons.verified />}
          <RoleBadge role={role} />
          {muted && (
            <span className="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 text-[11px] shrink-0">
              Muted
            </span>
          )}
        </div>
        <p className="text-xs text-neutral-500 truncate">@{user?.username}</p>
      </div>

      {showMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="p-2 text-neutral-400 hover:text-white transition-colors shrink-0"
              aria-label="Member options"
            >
              <Icons.more className="w-5 h-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            sheetTitle={user?.name || user?.username}
            align="end"
            className="bg-neutral-900 border-neutral-700 rounded-2xl w-52 p-2"
          >
            {canManageAdmins && (
              <DropdownMenuItem
                onClick={() => onAction(role === "admin" ? "remove_admin" : "make_admin")}
                className="p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
              >
                {role === "admin" ? "Remove admin" : "Make admin"}
              </DropdownMenuItem>
            )}
            {canModerate && (
              <>
                <DropdownMenuItem
                  onClick={() => onAction(role === "restricted" ? "unrestrict" : "restrict")}
                  className="p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                >
                  {role === "restricted" ? "Un-restrict" : "Restrict"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onAction(muted ? "unmute" : "mute")}
                  className="p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                >
                  {muted ? "Unmute" : "Mute for 24 hours"}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-neutral-700 my-1" />
                <DropdownMenuItem
                  onClick={() => onAction("remove")}
                  className="p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
                >
                  Remove from group
                </DropdownMenuItem>
                {/*
                  * Ban, next to Remove because the difference is easy to miss:
                  * removing lets anyone with "Add people" bring them back, banning
                  * doesn't. Banned members are listed separately below, which is
                  * the only way back from here.
                  */}
                <DropdownMenuItem
                  onClick={() => onAction("ban")}
                  className="p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
                >
                  Ban from group
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};

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
  const [nextSkip, setNextSkip] = useState(0);
  const [hasMoreMembers, setHasMoreMembers] = useState(false);
  const [loadingMoreMembers, setLoadingMoreMembers] = useState(false);

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

  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState([]);
  const [addSearching, setAddSearching] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [addingMembers, setAddingMembers] = useState(false);
  const addSearchTimeout = useRef(null);

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

  const fetchMembers = useCallback(
    async (skip) => {
      const res = await groupAPI.getMembers(groupId, { skip, limit: MEMBERS_PAGE_SIZE });
      if (!alive.current) return;
      setMembers((prev) => (skip === 0 ? res.members || [] : [...prev, ...(res.members || [])]));
      setMembersTotal(res.total ?? 0);
      setHasMoreMembers(!!res.hasMore);
      setNextSkip(res.nextSkip ?? skip + (res.members?.length || 0));
    },
    [groupId]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [groupRes] = await Promise.all([groupAPI.getGroup(groupId), fetchMembers(0)]);
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

  // The debounce timer outlives the page otherwise, and fires setState on an
  // unmounted component if you navigate away mid-keystroke.
  useEffect(
    () => () => {
      if (addSearchTimeout.current) clearTimeout(addSearchTimeout.current);
    },
    []
  );

  const handleLoadMoreMembers = async () => {
    if (loadingMoreMembers || !hasMoreMembers) return;
    setLoadingMoreMembers(true);
    try {
      await fetchMembers(nextSkip);
    } catch (err) {
      toast.error(errorMessage(err, "Could not load more members"));
    } finally {
      setLoadingMoreMembers(false);
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
  const handleToggleFileSharing = () =>
    updateSetting({ fileSharing: !group.settings?.fileSharing });
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

  const applyMemberPatch = (userId, patch) => {
    setMembers((prev) => prev.map((m) => (m.user?._id === userId ? { ...m, ...patch } : m)));
  };

  const fetchBannedMembers = useCallback(async () => {
    try {
      const res = await groupAPI.getMembers(groupId, { banned: true, limit: 100 });
      if (alive.current) setBannedMembers(res.members || []);
    } catch {
      // A 403 here just means this caller can't ban, so there is nothing to show.
      if (alive.current) setBannedMembers([]);
    }
  }, [groupId]);

  const handleMemberAction = async (member, action) => {
    if (action === "remove") {
      setRemoveTarget(member);
      return;
    }
    if (action === "ban") {
      setBanTarget(member);
      return;
    }
    // "mute" needs a timestamp computed at click time, not at module load, so
    // it isn't in the static MEMBER_ACTION_PATCH map above.
    const patch =
      action === "mute"
        ? { mutedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
        : MEMBER_ACTION_PATCH[action];
    if (!patch) return;

    const userId = member.user._id;
    const prevPatch = { role: member.role, mutedUntil: member.mutedUntil };
    applyMemberPatch(userId, patch);
    try {
      await groupAPI.updateMember(groupId, userId, patch);
    } catch (err) {
      applyMemberPatch(userId, prevPatch);
      toast.error(errorMessage(err, "Could not update member"));
    }
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
      await fetchMembers(0);
      toast.success("Ban lifted");
    } catch (err) {
      toast.error(errorMessage(err, "Could not lift the ban"));
    }
  };

  const existingMemberIds = useMemo(() => new Set(members.map((m) => m.user?._id).filter(Boolean)), [members]);
  const addableResults = useMemo(
    () => addResults.filter((u) => !existingMemberIds.has(u._id)),
    [addResults, existingMemberIds]
  );

  const searchAddUsers = useCallback(async (query) => {
    if (!query.trim()) {
      setAddResults([]);
      return;
    }
    setAddSearching(true);
    try {
      // No groupAPI method exists for this — it's the same endpoint ChatPage
      // uses to search users, called uncached for the same reason its own
      // search results are: the query changes every keystroke.
      const res = await api.get("/user/search", {
        params: { q: query },
        skipRequestCacheInterceptor: true,
      });
      setAddResults(res.data?.users || []);
    } catch {
      setAddResults([]);
    } finally {
      setAddSearching(false);
    }
  }, []);

  const handleAddQueryChange = (e) => {
    const query = e.target.value;
    setAddQuery(query);
    if (addSearchTimeout.current) clearTimeout(addSearchTimeout.current);
    addSearchTimeout.current = setTimeout(() => searchAddUsers(query), 300);
  };

  const toggleSelectedUser = (user) => {
    setSelectedUsers((prev) =>
      prev.some((u) => u._id === user._id)
        ? prev.filter((u) => u._id !== user._id)
        : [...prev, user]
    );
  };

  const handleAddMembers = async () => {
    if (selectedUsers.length === 0) return;
    setAddingMembers(true);
    try {
      await groupAPI.addMembers(
        groupId,
        selectedUsers.map((u) => u._id)
      );
      setSelectedUsers([]);
      setAddQuery("");
      setAddResults([]);
      await fetchMembers(0);
      toast.success("Members added");
    } catch (err) {
      toast.error(errorMessage(err, "Nobody you picked can be added"));
    } finally {
      setAddingMembers(false);
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
          <img
            src={group.avatar || "/default-avatar.png"}
            alt=""
            className="w-24 h-24 rounded-full object-cover border border-neutral-700 shadow-lg mb-3"
          />
          <h2 className="text-lg font-semibold text-white text-center">{group.name}</h2>
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
              <div className="flex items-center justify-between">
                <p className="text-sm text-white">File sharing</p>
                <Toggle
                  checked={!!group.settings?.fileSharing}
                  onChange={handleToggleFileSharing}
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

        <section className="py-5 border-b border-neutral-900">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1 px-3 sm:px-4">
            Members ({membersTotal})
          </h2>
          <div className="divide-y divide-neutral-900">
            {members.map((m) => (
              <MemberRow
                key={m._id}
                member={m}
                isSelf={m.user?._id === currentUserId}
                permissions={permissions}
                onAction={(action) => handleMemberAction(m, action)}
              />
            ))}
          </div>
          {hasMoreMembers && (
            <div className="flex justify-center pt-3">
              <button
                type="button"
                onClick={handleLoadMoreMembers}
                disabled={loadingMoreMembers}
                className="text-sm text-neutral-400 hover:text-white transition-colors disabled:opacity-50"
              >
                {loadingMoreMembers ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </section>

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

        {permissions.addMembers && (
          <section className="px-3 sm:px-4 py-5 border-b border-neutral-900">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">
              Add members
            </h2>
            <div className="relative mb-3">
              <Icons.search
                strokeColor="#737373"
                className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              />
              <input
                value={addQuery}
                onChange={handleAddQueryChange}
                placeholder="Search people to add"
                className="w-full rounded-lg bg-neutral-900 border border-neutral-700 pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-500"
              />
            </div>

            {selectedUsers.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {selectedUsers.map((u) => (
                  <span
                    key={u._id}
                    className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-neutral-800 text-xs text-white"
                  >
                    <img
                      src={u.profilePic || "/default-avatar.png"}
                      alt=""
                      className="w-5 h-5 rounded-full object-cover"
                    />
                    {u.username}
                    <button
                      type="button"
                      onClick={() => toggleSelectedUser(u)}
                      aria-label={`Remove ${u.username}`}
                    >
                      <Icons.close className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {addSearching ? (
              <div className="flex justify-center py-4">
                <Icons.spinner className="w-6 h-6 animate-spin text-neutral-500" />
              </div>
            ) : (
              addQuery.trim() &&
              (addableResults.length === 0 ? (
                <p className="text-sm text-neutral-500 py-2">No matching users</p>
              ) : (
                <div className="max-h-64 overflow-y-auto divide-y divide-neutral-900 rounded-lg border border-neutral-800 mb-3">
                  {addableResults.map((u) => {
                    const selected = selectedUsers.some((s) => s._id === u._id);
                    return (
                      <button
                        key={u._id}
                        type="button"
                        onClick={() => toggleSelectedUser(u)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-neutral-900 transition-colors text-left"
                      >
                        <img
                          src={u.profilePic || "/default-avatar.png"}
                          alt=""
                          className="w-9 h-9 rounded-full object-cover shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{u.name || u.username}</p>
                          <p className="text-xs text-neutral-500 truncate">@{u.username}</p>
                        </div>
                        <span className="w-5 h-5 shrink-0 flex items-center justify-center">
                          {selected ? (
                            <Icons.checkCircle className="w-5 h-5" />
                          ) : (
                            <span className="w-4 h-4 rounded-full border border-neutral-600" />
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}

            <button
              type="button"
              onClick={handleAddMembers}
              disabled={selectedUsers.length === 0 || addingMembers}
              className="w-full rounded-lg bg-white text-black text-sm font-medium py-2.5 disabled:opacity-40"
            >
              {addingMembers ? "Adding…" : `Add${selectedUsers.length ? ` (${selectedUsers.length})` : ""}`}
            </button>
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
