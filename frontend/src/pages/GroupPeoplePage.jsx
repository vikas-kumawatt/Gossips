import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "react-hot-toast";
import { UserPlus } from "lucide-react";
import { UserContext } from "../contexts/UserContext";
import { useBlock } from "../contexts/BlockContext";
import { useReport } from "../contexts/ReportContext";
import { Icons } from "../components/icons";
import GroupRoleBadge from "../components/Chat/GroupRoleBadge";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import ResponsiveMenu from "../components/ui/ResponsiveMenu";
import { groupAPI, userAPI } from "../services/api";
import {
  MEMBER_ACTION_PATCH,
  isCurrentlyMuted,
  memberCapabilities,
  sectionMembers,
} from "../lib/groupMembers";

/**
 * Everyone in a group, in three sections: You, Following, Others.
 *
 * Its own page rather than a section of the group info screen. A member list is
 * unbounded — a big group is hundreds of rows with their own pagination — and burying
 * it under settings and a banned list meant scrolling past everything to find one
 * person.
 *
 * Two kinds of action live in the row menu and they are not the same thing:
 *
 *   group moderation  promote, demote, remove. Admin-only, and gated on *rank* as well
 *                     as permission, because the server refuses an admin acting on
 *                     another admin unless they own the group.
 *   personal          restrict, block, report. Anyone, about anyone but themselves —
 *                     the same actions the DM header offers. Being an admin is
 *                     irrelevant to them.
 */

const PAGE_SIZE = 30;

const errorMessage = (err, fallback) => err?.response?.data?.error || fallback;

const GroupPeoplePage = () => {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const currentUserId = userAuth?._id || userAuth?.id;
  const { isBlocked, requestBlock, unblock: unblockUser } = useBlock();
  const { openReport } = useReport();

  const [permissions, setPermissions] = useState(null);
  const [members, setMembers] = useState([]);
  const [total, setTotal] = useState(0);
  const [nextSkip, setNextSkip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (skip) => {
      const res = await groupAPI.getMembers(groupId, { skip, limit: PAGE_SIZE });
      if (!alive.current) return;
      setMembers((prev) => (skip === 0 ? res.members || [] : [...prev, ...(res.members || [])]));
      setTotal(res.total || 0);
      setNextSkip(res.nextSkip ?? null);
    },
    [groupId]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [info] = await Promise.all([groupAPI.getGroup(groupId), fetchPage(0)]);
        if (cancelled) return;
        setPermissions(info.membership?.permissions || null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "These members could not be loaded"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, fetchPage]);

  const loadMore = async () => {
    if (nextSkip == null || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(nextSkip);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't load more members"));
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  };

  const sections = useMemo(
    () => sectionMembers(members, currentUserId),
    [members, currentUserId]
  );

  /** Patch one row in place, so a role change doesn't need a refetch. */
  const applyPatch = (userId, patch) =>
    setMembers((prev) =>
      prev.map((m) => (m.user?._id === userId ? { ...m, ...patch } : m))
    );

  const runRoleAction = async (member, action) => {
    const patch = MEMBER_ACTION_PATCH[action];
    if (!patch) return;
    const userId = member.user._id;
    const previous = { role: member.role, mutedUntil: member.mutedUntil };

    applyPatch(userId, patch); // optimistic
    setBusy(true);
    try {
      const res = await groupAPI.updateMember(groupId, userId, patch);
      // The server's own row wins: it applies rank rules this client only predicts.
      if (res?.member) applyPatch(userId, res.member);
    } catch (err) {
      applyPatch(userId, previous);
      toast.error(errorMessage(err, "Couldn't update that member"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const confirmRemove = async () => {
    const member = removeTarget;
    if (!member) return;
    setBusy(true);
    try {
      await groupAPI.removeMember(groupId, member.user._id);
      if (!alive.current) return;
      setMembers((prev) => prev.filter((m) => m.user?._id !== member.user._id));
      setTotal((n) => Math.max(0, n - 1));
      setRemoveTarget(null);
      toast.success(`Removed @${member.user.username}`);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't remove them"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const handleAction = async (member, action) => {
    setMenuFor(null);
    const { user } = member;

    switch (action) {
      case "profile":
        navigate(`/${user.username}`);
        return;
      case "make_admin":
      case "remove_admin":
      case "restrict_in_group":
      case "unrestrict_in_group":
        await runRoleAction(member, action);
        return;
      case "remove":
        setRemoveTarget(member);
        return;
      /*
       * Account-level restrict, which is a different feature from the group's
       * `restricted` role — that one silences someone in this group, this one limits
       * their reach to you everywhere. Both are offered, labelled differently.
       */
      case "restrict":
        try {
          await userAPI.restrict(user.username);
          toast.success(`Restricted @${user.username}`);
        } catch (err) {
          toast.error(errorMessage(err, "Couldn't restrict them"));
        }
        return;
      case "block":
        if (isBlocked(user)) {
          unblockUser(user).catch(() => {});
        } else {
          requestBlock({ _id: user._id, username: user.username, name: user.name });
        }
        return;
      case "report":
        openReport({
          targetType: "user",
          targetId: user._id,
          username: user.username,
          name: user.name,
        });
        return;
      default:
        return;
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-black text-white">
        <div className="flex items-center justify-center flex-1">
          <Icons.spinner className="animate-spin w-8 h-8 text-neutral-400" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-black text-white">
        <header className="shrink-0 flex items-center gap-3 px-3 py-3 border-b border-neutral-800">
          <button onClick={() => navigate(-1)} aria-label="Go back">
            <Icons.back className="w-5 h-5" />
          </button>
          <h1 className="font-medium">People</h1>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-neutral-400 text-sm">{loadError}</p>
          <button
            onClick={() => navigate(`/chat/group/${groupId}`)}
            className="px-4 py-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-sm"
          >
            Back to the group
          </button>
        </div>
      </div>
    );
  }

  const menuMember = menuFor?.member;
  const caps = menuMember
    ? memberCapabilities(menuMember, permissions, menuMember.user?._id === currentUserId)
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-black text-white">
      <header className="shrink-0 flex items-center gap-3 px-3 py-3 sm:px-4 border-b border-neutral-800">
        <button
          onClick={() => navigate(`/chat/group/${groupId}/info`)}
          aria-label="Go back"
          className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Icons.back className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-medium text-base truncate">People</h1>
          <p className="text-xs text-neutral-400">
            {total} {total === 1 ? "member" : "members"}
          </p>
        </div>
        {/* Only where the server would accept the add. */}
        {permissions?.addMembers && (
          <button
            onClick={() => navigate(`/chat/group/${groupId}/people/add`)}
            aria-label="Add people"
            className="w-10 h-10 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-white/10 active:scale-90 transition-all"
          >
            <UserPlus className="w-5 h-5" strokeWidth={2.1} />
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto pb-6">
        {sections.map((section) => (
          <section key={section.key}>
            <h2 className="px-4 pt-4 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
              {section.label}
            </h2>
            {section.members.map((member) => {
              const { user, role, mutedUntil } = member;
              const isSelf = user?._id === currentUserId;
              const muted = isCurrentlyMuted(mutedUntil);

              return (
                <div key={user._id} className="flex items-center gap-3 px-4 py-2.5">
                  {/* The whole identity is the tap target to their profile — the one
                      thing everybody tries on a member list. */}
                  <button
                    type="button"
                    onClick={() => navigate(`/${user.username}`)}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  >
                    <img
                      src={user.profilePic || "/default-avatar.png"}
                      alt=""
                      className="w-11 h-11 rounded-full object-cover border border-neutral-800 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">
                          {user.username}
                        </span>
                        {user.isVerified && <Icons.verified className="w-3.5 h-3.5 shrink-0" />}
                        <GroupRoleBadge role={role} />
                      </div>
                      <p className="text-xs text-neutral-500 truncate">
                        {user.name}
                        {muted && " · Muted"}
                      </p>
                    </div>
                  </button>

                  {/* No menu on your own row: every action in it is about someone else. */}
                  {!isSelf && (
                    <button
                      type="button"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenuFor({
                          member,
                          x: Math.max(12, rect.right - 220),
                          y: rect.bottom + 6,
                        });
                      }}
                      aria-label={`Options for ${user.username}`}
                      className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <Icons.more className="w-5 h-5" />
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}

        {nextSkip != null && (
          <div className="px-4 pt-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-sm disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {menuMember && (
        <ResponsiveMenu
          open
          onClose={() => setMenuFor(null)}
          title={menuMember.user.username}
          className="fixed z-[80] w-[220px] rounded-2xl border border-neutral-700 bg-[#181818] shadow-xl py-1"
          style={{ left: `${menuFor.x}px`, top: `${menuFor.y}px` }}
        >
          <MenuItem onClick={() => handleAction(menuMember, "profile")}>
            View profile
          </MenuItem>

          {caps.canManageAdmins &&
            (caps.isAdmin ? (
              <MenuItem onClick={() => handleAction(menuMember, "remove_admin")} disabled={busy}>
                Remove as admin
              </MenuItem>
            ) : (
              <MenuItem onClick={() => handleAction(menuMember, "make_admin")} disabled={busy}>
                Promote to admin
              </MenuItem>
            ))}

          {caps.canModerate &&
            (menuMember.role === "restricted" ? (
              <MenuItem
                onClick={() => handleAction(menuMember, "unrestrict_in_group")}
                disabled={busy}
              >
                Allow to send messages
              </MenuItem>
            ) : (
              <MenuItem
                onClick={() => handleAction(menuMember, "restrict_in_group")}
                disabled={busy}
              >
                Mute in this group
              </MenuItem>
            ))}

          {caps.canModerate && (
            <MenuItem danger onClick={() => handleAction(menuMember, "remove")}>
              Remove from group
            </MenuItem>
          )}

          <div className="h-px bg-neutral-700 my-1" />

          <MenuItem onClick={() => handleAction(menuMember, "restrict")}>Restrict</MenuItem>
          <MenuItem danger onClick={() => handleAction(menuMember, "block")}>
            {isBlocked(menuMember.user) ? "Unblock" : "Block"}
          </MenuItem>
          <MenuItem danger onClick={() => handleAction(menuMember, "report")}>
            Report
          </MenuItem>
        </ResponsiveMenu>
      )}

      {removeTarget && (
        <ConfirmDialog
          title={`Remove @${removeTarget.user.username}?`}
          confirmLabel="Remove"
          busy={busy}
          onConfirm={confirmRemove}
          onCancel={() => setRemoveTarget(null)}
        >
          They'll lose access to this group's messages. You can add them back later.
        </ConfirmDialog>
      )}
    </div>
  );
};

/** One row of the member menu, so the eight of them can't drift apart. */
const MenuItem = ({ children, onClick, danger, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`w-full text-left px-4 py-2.5 text-[15px] hover:bg-neutral-800 disabled:opacity-50 ${
      danger ? "text-rose-400" : "text-white"
    }`}
  >
    {children}
  </button>
);

export default GroupPeoplePage;
