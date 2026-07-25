import { useCallback, useEffect, useState } from "react";
import { adminAPI } from "../../services/api";
import {
  Panel,
  Spinner,
  ErrorState,
  EmptyState,
  Badge,
  SearchInput,
  Select,
  Pagination,
  TableWrap,
  Th,
  Td,
  UserCell,
  relativeTime,
} from "../../components/admin/ui";

const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "user.suspend", label: "Suspensions" },
  { value: "user.unsuspend", label: "Reinstatements" },
  { value: "user.verify", label: "Verifications" },
  { value: "user.unverify", label: "Verification removed" },
  { value: "user.role_change", label: "Role changes" },
  { value: "user.force_logout", label: "Forced sign-outs" },
  { value: "post.delete", label: "Posts removed" },
  { value: "comment.delete", label: "Comments removed" },
  { value: "report.status_change", label: "Report decisions" },
  { value: "settings.update", label: "Settings changes" },
];

const ACTION_TONE = {
  "user.suspend": "red",
  "user.unsuspend": "green",
  "user.verify": "blue",
  "user.unverify": "neutral",
  "user.role_change": "purple",
  "user.force_logout": "amber",
  "post.delete": "red",
  "comment.delete": "red",
  "report.status_change": "blue",
  "settings.update": "amber",
};

/** Turn the stored `details` blob into one readable line per action type. */
const describe = (entry) => {
  const d = entry.details || {};
  switch (entry.action) {
    case "user.suspend":
      return `${d.durationDays ? `${d.durationDays} days` : "Indefinite"} — ${d.reason || "no reason"}`;
    case "user.role_change":
      return `${d.from} → ${d.to}`;
    case "user.verify":
    case "user.unverify":
      return `${d.from || "none"} → ${d.to || "none"}`;
    case "user.force_logout":
      return `${d.sessionsRevoked ?? 0} session(s) revoked`;
    case "report.status_change":
      return [
        d.from ? `${d.from} → ${d.to}` : `set ${d.to}`,
        d.alsoUpdated ? `+${d.alsoUpdated} related` : null,
        d.note,
      ]
        .filter(Boolean)
        .join(" · ");
    case "settings.update":
      return (d.changed || [])
        .map((c) => `${c.key}: ${String(c.from)} → ${String(c.to)}`)
        .join(", ");
    case "post.delete":
    case "comment.delete":
      return d.reason || "no reason given";
    default:
      return "";
  }
};

const AdminAuditLog = () => {
  const [action, setAction] = useState("all");
  const [actor, setActor] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminAPI.auditLog({ action, actor, page, limit: 50 }));
    } catch {
      setError("Couldn't load the audit log.");
    } finally {
      setLoading(false);
    }
  }, [action, actor, page]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold">Audit log</h1>
        <p className="text-[13px] text-neutral-500 mt-1">
          Every staff action, oldest entries never modified.
        </p>
      </header>

      <Panel>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <SearchInput
            value={actor}
            onChange={(v) => {
              setActor(v);
              setPage(1);
            }}
            placeholder="Filter by staff username…"
          />
          <Select
            value={action}
            onChange={(v) => {
              setAction(v);
              setPage(1);
            }}
            options={ACTION_OPTIONS}
          />
        </div>

        {loading && !data ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data?.entries.length ? (
          <EmptyState
            title="Nothing logged yet"
            hint="Staff actions will be recorded here as they happen."
          />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr className="border-b border-neutral-800">
                  <Th>Action</Th>
                  <Th>Staff</Th>
                  <Th>Target</Th>
                  <Th>Details</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e._id} className="border-b border-neutral-900 hover:bg-neutral-900/50">
                    <Td>
                      <Badge tone={ACTION_TONE[e.action] || "neutral"}>
                        {e.action.replace(/[._]/g, " ")}
                      </Badge>
                    </Td>
                    <Td>
                      {e.actor ? (
                        <UserCell user={e.actor} />
                      ) : (
                        <span className="text-neutral-400 text-[13px]">@{e.actorUsername}</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-neutral-300 text-[13px] truncate block max-w-[200px]">
                        {e.targetLabel || e.targetType}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-neutral-500 text-[12px] truncate block max-w-[280px]">
                        {describe(e)}
                      </span>
                    </Td>
                    <Td className="text-neutral-500 text-[12px] whitespace-nowrap">
                      {relativeTime(e.createdAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination pageInfo={data.pageInfo} onPage={setPage} />
          </>
        )}
      </Panel>
    </div>
  );
};

export default AdminAuditLog;
