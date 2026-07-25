import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminAPI } from "../../services/api";
import { AreaChart, BarList, DonutChart, ProgressRing, formatNumber } from "../../components/admin/charts";
import {
  Panel,
  StatCard,
  Spinner,
  ErrorState,
  Badge,
  Select,
  UserCell,
  relativeTime,
  EmptyState,
} from "../../components/admin/ui";

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

const AdminDashboard = () => {
  const [days, setDays] = useState("30");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overview, growth, moderation, reports] = await Promise.all([
        adminAPI.overview(days),
        adminAPI.growth(days),
        adminAPI.moderationMetrics(days),
        adminAPI.listReports({ status: "pending", limit: 6 }),
      ]);
      setData({ overview, growth, moderation, reports: reports.reports });
    } catch {
      setError("Couldn't load the dashboard.");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const { overview, growth, moderation, reports } = data;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-[13px] text-neutral-500 mt-1">
            Everything happening across Gossips right now.
          </p>
        </div>
        <Select value={days} onChange={setDays} options={RANGES} />
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total users"
          value={formatNumber(overview.totals.users)}
          trend={overview.trends.users}
          hint={`+${overview.period.newUsers} this period`}
          spark={growth.signups}
        />
        <StatCard
          label="Posts"
          value={formatNumber(overview.totals.posts)}
          trend={overview.trends.posts}
          hint={`+${overview.period.newPosts} this period`}
          spark={growth.posts}
          color="#22c55e"
        />
        <StatCard
          label="Daily actives"
          value={formatNumber(overview.activity.dau)}
          hint={`${overview.activity.stickiness}% of monthly`}
          color="#06b6d4"
        />
        <StatCard
          label="Open reports"
          value={formatNumber(overview.moderation.queueDepth)}
          hint={`${overview.moderation.pendingReports} awaiting review`}
          spark={moderation.perDay}
          color="#ef4444"
        />
      </div>

      <Panel
        title="Growth"
        subtitle="New accounts, posts and comments per day"
      >
        <AreaChart
          series={[
            { name: "Signups", color: "#6366f1", points: growth.signups },
            { name: "Posts", color: "#22c55e", points: growth.posts },
            { name: "Comments", color: "#f59e0b", points: growth.comments },
          ]}
        />
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Panel title="Audience" subtitle="Active accounts by window" className="xl:col-span-1">
          <div className="flex items-center justify-around gap-2 py-2">
            <ProgressRing
              value={overview.activity.stickiness}
              label="DAU / MAU"
              color="#06b6d4"
            />
            <div className="flex flex-col gap-3 text-sm">
              {[
                ["Daily", overview.activity.dau, "#06b6d4"],
                ["Weekly", overview.activity.wau, "#6366f1"],
                ["Monthly", overview.activity.mau, "#a855f7"],
              ].map(([label, value, color]) => (
                <div key={label} className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-neutral-400 w-16">{label}</span>
                  <span className="text-white font-semibold">{formatNumber(value)}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel
          title="Moderation queue"
          subtitle="Reports by status"
          className="xl:col-span-2"
          action={
            <Link
              to="/admin/reports"
              className="text-[13px] text-neutral-400 hover:text-white"
            >
              Open queue →
            </Link>
          }
        >
          <DonutChart
            data={moderation.byStatus.map((s, i) => ({
              label: s.status,
              count: s.count,
              color: ["#f59e0b", "#3b82f6", "#22c55e", "#6b7280"][i],
            }))}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel title="Why people report" subtitle={`Top categories, last ${days} days`}>
          <BarList
            data={moderation.byCategory.slice(0, 7).map((c) => ({
              label: c.label,
              count: c.count,
            }))}
            color="#ef4444"
          />
        </Panel>

        <Panel
          title="Needs attention"
          subtitle="Oldest unresolved reports"
          action={
            <Link to="/admin/reports" className="text-[13px] text-neutral-400 hover:text-white">
              See all →
            </Link>
          }
        >
          {reports.length === 0 ? (
            <EmptyState title="Queue is clear" hint="No reports waiting for review." />
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-800 -my-2">
              {reports.map((r) => (
                <li key={r._id} className="py-3 flex items-center gap-3 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] text-white font-medium truncate">
                        {r.reasonLabel}
                      </span>
                      <Badge tone="neutral">{r.targetType}</Badge>
                      {r.urgent && <Badge tone="red">{r.targetReports} reports</Badge>}
                    </div>
                    <p className="text-[12px] text-neutral-500 mt-0.5 truncate">
                      {r.targetOwner ? `against @${r.targetOwner.username}` : "target removed"} ·{" "}
                      {relativeTime(r.createdAt)}
                    </p>
                  </div>
                  <Link
                    to={`/admin/reports?focus=${r._id}`}
                    className="text-[13px] text-neutral-400 hover:text-white shrink-0"
                  >
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Most reported accounts" subtitle={`Last ${days} days`}>
        {moderation.repeatOffenders.length === 0 ? (
          <EmptyState title="Nothing to show" hint="No accounts have been reported yet." />
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-800 -my-2">
            {moderation.repeatOffenders.map((o) => (
              <li key={o._id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <UserCell user={o.user} />
                </div>
                {o.user?.accountStatus && o.user.accountStatus !== "active" && (
                  <Badge tone="red">{o.user.accountStatus}</Badge>
                )}
                <Badge tone="amber">{o.reports} reports</Badge>
                {o.user && (
                  <Link
                    to={`/admin/users?search=${o.user.username}`}
                    className="text-[13px] text-neutral-400 hover:text-white shrink-0"
                  >
                    View
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
};

export default AdminDashboard;
