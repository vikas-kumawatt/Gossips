import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { toast } from "react-hot-toast";
import { adminAPI } from "../../services/api";
import ResponsiveSheet from "../../components/ui/responsive-sheet";
import {
  Panel,
  Spinner,
  ErrorState,
  EmptyState,
  Badge,
  Button,
  SearchInput,
  Select,
  Pagination,
  TableWrap,
  Th,
  Td,
  UserCell,
  Toggle,
  VerifiedTick,
  STATUS_TONE,
  ROLE_TONE,
  relativeTime,
} from "../../components/admin/ui";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "deactivated", label: "Deactivated" },
  { value: "locked", label: "Locked" },
];

const ROLE_OPTIONS = [
  { value: "all", label: "All roles" },
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
  { value: "super_admin", label: "Super admin" },
];

/**
 * Accounts created before the `role` field existed come back without one, and
 * `undefined !== "user"` would otherwise read as "this is a staff account".
 * The server backfills and normalises too; this keeps the UI safe regardless.
 */
const roleOf = (user) => user?.role || "user";
const roleLabel = (user) => roleOf(user).replace("_", " ");

const SORT_OPTIONS = [
  { value: "recent", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "followers", label: "Most followers" },
  { value: "posts", label: "Most posts" },
  { value: "active", label: "Recently active" },
];

const AdminUsers = () => {
  const { session, refreshSession } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [status, setStatus] = useState("all");
  const [role, setRole] = useState("all");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminAPI.listUsers({ search, status, role, sort, page, limit: 25 });
      setData(res);
    } catch {
      setError("Couldn't load users.");
    } finally {
      setLoading(false);
    }
  }, [search, status, role, sort, page]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  // Keep the URL in step so a filtered view can be linked to (the dashboard does).
  useEffect(() => {
    const next = {};
    if (search) next.search = search;
    setSearchParams(next, { replace: true });
  }, [search, setSearchParams]);

  const openDetail = async (username) => {
    setDetail({ loading: true, username });
    try {
      const res = await adminAPI.getUser(username);
      setDetail({ loading: false, username, ...res });
    } catch {
      toast.error("Couldn't load that account");
      setDetail(null);
    }
  };

  const afterAction = async (message) => {
    toast.success(message);
    await load();
    // Re-checks our own role too: demoting yourself is blocked, but a peer
    // super_admin could have changed it while this page was open.
    await refreshSession();
    if (detail?.username) await openDetail(detail.username);
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-[13px] text-neutral-500 mt-1">
          {data ? `${data.pageInfo.total.toLocaleString()} accounts` : "Loading…"}
        </p>
      </header>

      <Panel>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search name, username or email…"
          />
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTIONS} />
          <Select value={role} onChange={(v) => { setRole(v); setPage(1); }} options={ROLE_OPTIONS} />
          <Select value={sort} onChange={setSort} options={SORT_OPTIONS} />
        </div>

        {loading && !data ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data?.users.length ? (
          <EmptyState title="No accounts match" hint="Try clearing the filters." />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr className="border-b border-neutral-800">
                  <Th>Account</Th>
                  <Th>Status</Th>
                  <Th>Role</Th>
                  <Th className="text-right">Followers</Th>
                  <Th className="text-right">Posts</Th>
                  <Th>Joined</Th>
                  <Th>Last active</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u._id} className="border-b border-neutral-900 hover:bg-neutral-900/50">
                    <Td>
                      <UserCell user={u} />
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[u.accountStatus]}>{u.accountStatus}</Badge>
                    </Td>
                    <Td>
                      {roleOf(u) === "user" ? (
                        <span className="text-neutral-600 text-[13px]">—</span>
                      ) : (
                        <Badge tone={ROLE_TONE[roleOf(u)]}>{roleLabel(u)}</Badge>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{u.counts?.followers ?? 0}</Td>
                    <Td className="text-right tabular-nums">{u.counts?.posts ?? 0}</Td>
                    <Td className="text-neutral-500 text-[12px]">{relativeTime(u.createdAt)}</Td>
                    <Td className="text-neutral-500 text-[12px]">{relativeTime(u.lastActiveAt)}</Td>
                    <Td>
                      <Button size="sm" variant="ghost" onClick={() => openDetail(u.username)}>
                        Manage
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination pageInfo={data.pageInfo} onPage={setPage} />
          </>
        )}
      </Panel>

      {detail && (
        <UserDetailSheet
          detail={detail}
          session={session}
          onClose={() => setDetail(null)}
          onActed={afterAction}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const UserDetailSheet = ({ detail, session, onClose, onActed }) => {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("7");

  const user = detail.user;
  const isStaffTarget = user && roleOf(user) !== "user";
  // An ordinary admin can't touch another staff account.
  const canAct = user && (!isStaffTarget || session?.isSuperAdmin);

  const run = async (fn, successMessage) => {
    setBusy(true);
    try {
      await fn();
      await onActed(successMessage);
    } catch (error) {
      toast.error(error.response?.data?.error || "That didn't work");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveSheet onClose={onClose} title={user ? `@${user.username}` : "Account"}>
      {detail.loading || !user ? (
        <Spinner />
      ) : (
        <div className="p-4 flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <img
              src={user.profilePic || "/default-avatar.png"}
              alt=""
              className="w-14 h-14 rounded-full object-cover bg-neutral-800"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1 min-w-0">
                <p className="font-semibold truncate">{user.name || user.username}</p>
                {user.isVerified && <VerifiedTick className="w-4 h-4 shrink-0" />}
              </div>
              <p className="text-[13px] text-neutral-500 truncate">{user.email}</p>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <Badge tone={STATUS_TONE[user.accountStatus]}>{user.accountStatus}</Badge>
                {roleOf(user) !== "user" && (
                  <Badge tone={ROLE_TONE[roleOf(user)]}>{roleLabel(user)}</Badge>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              ["Posts", detail.stats.posts],
              ["Comments", detail.stats.comments],
              ["Reported", detail.stats.reportsAgainst],
              ["Filed", detail.stats.reportsFiled],
            ].map(([label, value]) => (
              <div key={label} className="bg-neutral-900 rounded-xl py-2.5">
                <p className="text-[17px] font-bold">{value}</p>
                <p className="text-[11px] text-neutral-500">{label}</p>
              </div>
            ))}
          </div>

          {user.accountStatus === "suspended" && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
              <p className="text-[13px] text-red-300 font-semibold">Suspended</p>
              <p className="text-[12px] text-neutral-400 mt-1">
                {user.suspensionReason || "No reason recorded"}
              </p>
              <p className="text-[12px] text-neutral-500 mt-0.5">
                {user.suspensionEndsAt
                  ? `Until ${new Date(user.suspensionEndsAt).toLocaleDateString()}`
                  : "Indefinite"}
              </p>
            </div>
          )}

          {!canAct && (
            <p className="text-[13px] text-amber-400 bg-amber-500/10 border border-amber-500/25 rounded-xl p-3">
              This is a staff account. Only a super admin can act on it.
            </p>
          )}

          {canAct && (
            <>
              {user.accountStatus === "suspended" ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => run(() => adminAPI.unsuspendUser(user.username), "Account reinstated")}
                >
                  Lift suspension
                </Button>
              ) : (
                <div className="rounded-xl border border-neutral-800 p-3 flex flex-col gap-2.5">
                  <p className="text-[13px] font-semibold">Suspend account</p>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (shown to the user)"
                    className="w-full h-20 bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-[13px] outline-none resize-none focus:border-neutral-600"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <Select
                      label="For"
                      value={days}
                      onChange={setDays}
                      options={[
                        { value: "1", label: "1 day" },
                        { value: "7", label: "7 days" },
                        { value: "30", label: "30 days" },
                        { value: "0", label: "Indefinitely" },
                      ]}
                    />
                    <Button
                      variant="danger"
                      className="ml-auto"
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        run(
                          () =>
                            adminAPI.suspendUser(user.username, {
                              reason,
                              days: Number(days),
                            }),
                          "Account suspended"
                        )
                      }
                    >
                      Suspend
                    </Button>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-neutral-800 p-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold">Verified</p>
                    <p className="text-[12px] text-neutral-500 mt-0.5">
                      {user.isVerified && user.verifiedAt
                        ? `Since ${new Date(user.verifiedAt).toLocaleDateString(undefined, {
                            month: "long",
                            year: "numeric",
                          })}`
                        : "Shows the blue tick beside their name everywhere."}
                    </p>
                  </div>
                  <Toggle
                    checked={Boolean(user.isVerified)}
                    disabled={busy}
                    onChange={(next) =>
                      run(
                        () => adminAPI.setVerification(user.username, next),
                        next ? "Account verified" : "Verification removed"
                      )
                    }
                  />
                </div>
              </div>

              <Button
                disabled={busy}
                onClick={() =>
                  run(() => adminAPI.forceLogout(user.username), "Signed out everywhere")
                }
              >
                Sign out of all devices
              </Button>

              {session?.isSuperAdmin && (
                <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-3 flex flex-col gap-2.5">
                  <p className="text-[13px] font-semibold text-purple-300">Staff role</p>
                  <p className="text-[12px] text-neutral-400">
                    Granting admin gives full access to this panel.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {["user", "admin", "super_admin"].map((r) => (
                      <Button
                        key={r}
                        size="sm"
                        variant={roleOf(user) === r ? "primary" : "secondary"}
                        disabled={busy || roleOf(user) === r}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Change @${user.username} to ${r.replace("_", " ")}?`
                            )
                          )
                            return;
                          run(() => adminAPI.setRole(user.username, r), "Role updated");
                        }}
                      >
                        {r.replace("_", " ")}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {detail.actions?.length > 0 && (
            <div>
              <p className="text-[13px] font-semibold mb-2">Recent staff actions</p>
              <ul className="flex flex-col gap-1.5">
                {detail.actions.map((a) => (
                  <li key={a._id} className="text-[12px] text-neutral-500">
                    <span className="text-neutral-300">{a.action.replace(/[._]/g, " ")}</span> by @
                    {a.actorUsername} · {relativeTime(a.createdAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default AdminUsers;
