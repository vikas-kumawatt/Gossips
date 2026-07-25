import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { toast } from "react-hot-toast";
import { adminAPI } from "../../services/api";
import ResponsiveSheet from "../../components/ui/responsive-sheet";
import { REPORT_CATEGORIES } from "../../lib/reportCategories";
import {
  Panel,
  Spinner,
  ErrorState,
  EmptyState,
  Badge,
  Button,
  Select,
  Pagination,
  TableWrap,
  Th,
  Td,
  UserCell,
  STATUS_TONE,
  relativeTime,
} from "../../components/admin/ui";

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "reviewing", label: "Reviewing" },
  { value: "actioned", label: "Actioned" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

const TARGET_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "post", label: "Posts" },
  { value: "comment", label: "Comments" },
  { value: "message", label: "Messages" },
  { value: "conversation", label: "Chats" },
  { value: "user", label: "Accounts" },
];

const CATEGORY_OPTIONS = [
  { value: "all", label: "All reasons" },
  ...REPORT_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
];

const AdminReports = () => {
  const { refreshSession } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState("pending");
  const [targetType, setTargetType] = useState("all");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [focusId, setFocusId] = useState(searchParams.get("focus"));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminAPI.listReports({
        status,
        targetType,
        category,
        sort,
        page,
        limit: 25,
      });
      setData(res);
    } catch {
      setError("Couldn't load reports.");
    } finally {
      setLoading(false);
    }
  }, [status, targetType, category, sort, page]);

  useEffect(() => {
    load();
  }, [load]);

  const closeDetail = () => {
    setFocusId(null);
    // Drop ?focus= so a refresh doesn't reopen a report that's been handled.
    if (searchParams.get("focus")) setSearchParams({}, { replace: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-[13px] text-neutral-500 mt-1">
          {data ? `${data.pageInfo.total.toLocaleString()} matching reports` : "Loading…"}
        </p>
      </header>

      <Panel>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTIONS} />
          <Select value={targetType} onChange={(v) => { setTargetType(v); setPage(1); }} options={TARGET_OPTIONS} />
          <Select value={category} onChange={(v) => { setCategory(v); setPage(1); }} options={CATEGORY_OPTIONS} />
          <Select
            value={sort}
            onChange={setSort}
            options={[
              { value: "recent", label: "Newest" },
              { value: "oldest", label: "Oldest first" },
            ]}
          />
        </div>

        {loading && !data ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data?.reports.length ? (
          <EmptyState
            title="Nothing in this queue"
            hint="Reports matching these filters will appear here."
          />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr className="border-b border-neutral-800">
                  <Th>Reason</Th>
                  <Th>Type</Th>
                  <Th>Against</Th>
                  <Th>Reporter</Th>
                  <Th>Status</Th>
                  <Th>Filed</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.reports.map((r) => (
                  <tr key={r._id} className="border-b border-neutral-900 hover:bg-neutral-900/50">
                    <Td>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate max-w-[240px]">{r.reasonLabel}</span>
                        {r.urgent && <Badge tone="red">{r.targetReports}×</Badge>}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone="neutral">{r.targetType}</Badge>
                    </Td>
                    <Td>
                      {r.targetOwner ? (
                        <UserCell user={r.targetOwner} />
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-neutral-400 text-[13px]">
                        {r.reporter ? `@${r.reporter.username}` : "deleted"}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                    </Td>
                    <Td className="text-neutral-500 text-[12px]">{relativeTime(r.createdAt)}</Td>
                    <Td>
                      <Button size="sm" variant="ghost" onClick={() => setFocusId(r._id)}>
                        Review
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

      <PlatformReports />

      {focusId && (
        <ReportDetailSheet
          reportId={focusId}
          onClose={closeDetail}
          onResolved={async () => {
            closeDetail();
            // Refresh the sidebar's pending-report badge alongside the table.
            await Promise.all([load(), refreshSession()]);
          }}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const ReportDetailSheet = ({ reportId, onClose, onResolved }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [applyToAll, setApplyToAll] = useState(true);

  useEffect(() => {
    let active = true;
    adminAPI
      .getReport(reportId)
      .then((res) => active && setData(res))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [reportId]);

  const setStatus = async (status) => {
    setBusy(true);
    try {
      const res = await adminAPI.setReportStatus(reportId, { status, note, applyToAll });
      toast.success(res.message);
      await onResolved();
    } catch (e) {
      toast.error(e.response?.data?.error || "Couldn't update the report");
      setBusy(false);
    }
  };

  const removeTarget = async () => {
    if (!window.confirm("Remove this content? The author will no longer see it published."))
      return;
    setBusy(true);
    try {
      await adminAPI.removeContent(data.report.targetType, data.report.targetId, note);
      toast.success("Content removed");
      await adminAPI.setReportStatus(reportId, { status: "actioned", note, applyToAll: true });
      await onResolved();
    } catch (e) {
      toast.error(e.response?.data?.error || "Couldn't remove the content");
      setBusy(false);
    }
  };

  return (
    <ResponsiveSheet onClose={onClose} title="Review report">
      {error ? (
        <ErrorState message="Couldn't load that report." />
      ) : !data ? (
        <Spinner />
      ) : (
        <div className="p-4 flex flex-col gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
              Reason
            </p>
            <p className="text-[15px] font-semibold mt-0.5">{data.report.reasonLabel}</p>
            {data.report.details && (
              <p className="text-[13px] text-neutral-400 mt-1.5 whitespace-pre-line break-words">
                {data.report.details}
              </p>
            )}
            <p className="text-[12px] text-neutral-500 mt-2">
              Filed by @{data.report.reporter?.username || "deleted"} ·{" "}
              {relativeTime(data.report.createdAt)} ·{" "}
              <Badge tone={STATUS_TONE[data.report.status]}>{data.report.status}</Badge>
            </p>
          </div>

          {data.target ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3">
              <p className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold mb-1.5">
                Reported {data.report.targetType}
              </p>
              {data.target.isDeleted && (
                <Badge tone="neutral">already removed</Badge>
              )}
              <p className="text-[14px] whitespace-pre-line break-words mt-1">
                {data.target.content || <span className="text-neutral-600">No text</span>}
              </p>
              {data.target.media?.length > 0 && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {data.target.media.map((m) => (
                    <img
                      key={m}
                      src={m}
                      alt=""
                      className="w-20 h-20 rounded-lg object-cover bg-neutral-800"
                    />
                  ))}
                </div>
              )}
              <p className="text-[12px] text-neutral-500 mt-2">
                {relativeTime(data.target.createdAt)}
                {data.target.isEdited && " · edited"}
              </p>
            </div>
          ) : (
            <p className="text-[13px] text-neutral-500 rounded-xl border border-neutral-800 p-3">
              {data.report.targetType === "user"
                ? "This report is about an account rather than a single piece of content."
                : "The reported content is no longer available."}
            </p>
          )}

          {data.report.targetOwner && (
            <div className="rounded-xl border border-neutral-800 p-3">
              <p className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold mb-2">
                Account reported
              </p>
              <UserCell user={data.report.targetOwner} />
              <p className="text-[12px] text-neutral-500 mt-2">
                Joined {relativeTime(data.report.targetOwner.createdAt)} ·{" "}
                {data.report.targetOwner.counts?.followers ?? 0} followers ·{" "}
                <Badge tone={STATUS_TONE[data.report.targetOwner.accountStatus]}>
                  {data.report.targetOwner.accountStatus}
                </Badge>
              </p>
            </div>
          )}

          {data.siblings.length > 0 && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
              <p className="text-[13px] font-semibold text-amber-300">
                {data.siblings.length} other report{data.siblings.length === 1 ? "" : "s"} on this
                target
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {data.siblings.slice(0, 5).map((s) => (
                  <li key={s._id} className="text-[12px] text-neutral-400">
                    {s.reasonLabel} · @{s.reporter?.username || "deleted"}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Moderator note (recorded in the audit log)"
            className="w-full h-20 bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-[13px] outline-none resize-none focus:border-neutral-600"
          />

          <label className="flex items-center gap-2 text-[13px] text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
              className="accent-white"
            />
            Apply to all open reports on this target
          </label>

          <div className="flex flex-wrap gap-2">
            {data.report.status !== "reviewing" && (
              <Button disabled={busy} onClick={() => setStatus("reviewing")}>
                Mark reviewing
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => setStatus("dismissed")}>
              Dismiss
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => setStatus("actioned")}>
              Mark actioned
            </Button>
            {data.target && !data.target.isDeleted && (
              <Button variant="danger" disabled={busy} onClick={removeTarget}>
                Remove content
              </Button>
            )}
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const PlatformReports = () => {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminAPI.listPlatformReports({ status, page, limit: 10 }));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [status, page]);

  useEffect(() => {
    load();
  }, [load]);

  const update = async (id, next) => {
    try {
      await adminAPI.setPlatformReportStatus(id, next);
      toast.success(`Marked ${next}`);
      await load();
    } catch {
      toast.error("Couldn't update");
    }
  };

  return (
    <Panel
      title="Bug reports"
      subtitle="Problems people reported about the app itself"
      action={
        <Select
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={[
            { value: "pending", label: "Pending" },
            { value: "reviewed", label: "Reviewed" },
            { value: "resolved", label: "Resolved" },
            { value: "all", label: "All" },
          ]}
        />
      }
    >
      {loading && !data ? (
        <Spinner />
      ) : !data?.reports.length ? (
        <EmptyState title="No bug reports" hint="Reports submitted from the app appear here." />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-neutral-800 -my-2">
            {data.reports.map((r) => (
              <li key={r._id} className="py-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-neutral-200 whitespace-pre-line break-words">
                    {r.message}
                  </p>
                  <p className="text-[12px] text-neutral-500 mt-1">
                    {r.user ? `@${r.user.username}` : "anonymous"} · {relativeTime(r.createdAt)}
                    {r.metadata?.url ? ` · ${r.metadata.url}` : ""}
                  </p>
                  {r.screenshot && (
                    <a
                      href={r.screenshot}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[12px] text-blue-400 hover:underline"
                    >
                      View screenshot
                    </a>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  {r.status !== "resolved" && (
                    <Button size="sm" variant="ghost" onClick={() => update(r._id, "resolved")}>
                      Resolve
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pagination pageInfo={data.pageInfo} onPage={setPage} />
        </>
      )}
    </Panel>
  );
};

export default AdminReports;
