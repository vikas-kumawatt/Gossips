import { useCallback, useEffect, useState } from "react";
import { adminAPI } from "../../services/api";
import {
  AreaChart,
  BarChart,
  BarList,
  DonutChart,
  CHART_COLORS,
  formatNumber,
} from "../../components/admin/charts";
import {
  Panel,
  Spinner,
  ErrorState,
  EmptyState,
  Select,
  StatCard,
  UserCell,
  Badge,
} from "../../components/admin/ui";

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

const AdminAnalytics = () => {
  const [days, setDays] = useState("30");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [growth, engagement, moderation, retention] = await Promise.all([
        adminAPI.growth(days),
        adminAPI.engagement(days),
        adminAPI.moderationMetrics(days),
        adminAPI.retention(8),
      ]);
      setData({ growth, engagement, moderation, retention });
    } catch {
      setError("Couldn't load analytics.");
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

  const { growth, engagement, moderation, retention } = data;

  const totalLikes = engagement.likes.reduce((s, d) => s + d.count, 0);
  const totalFollows = engagement.follows.reduce((s, d) => s + d.count, 0);
  const totalPosts = growth.posts.reduce((s, d) => s + d.count, 0);
  const totalMessages = growth.messages.reduce((s, d) => s + d.count, 0);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-[13px] text-neutral-500 mt-1">
            Growth, engagement and moderation throughput.
          </p>
        </div>
        <Select value={days} onChange={setDays} options={RANGES} />
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Likes given" value={formatNumber(totalLikes)} spark={engagement.likes} color="#ec4899" />
        <StatCard label="New follows" value={formatNumber(totalFollows)} spark={engagement.follows} color="#06b6d4" />
        <StatCard label="Posts created" value={formatNumber(totalPosts)} spark={growth.posts} color="#22c55e" />
        <StatCard label="Messages sent" value={formatNumber(totalMessages)} spark={growth.messages} color="#a855f7" />
      </div>

      <Panel title="Total accounts" subtitle="Cumulative registered users">
        <AreaChart
          series={[{ name: "Accounts", color: "#6366f1", points: growth.cumulativeUsers }]}
          showLegend={false}
        />
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel title="Engagement" subtitle="Likes and follows per day">
          <AreaChart
            series={[
              { name: "Likes", color: "#ec4899", points: engagement.likes },
              { name: "Follows", color: "#06b6d4", points: engagement.follows },
            ]}
            height={200}
          />
        </Panel>

        <Panel title="When people post" subtitle="Posts by hour of day (UTC)">
          <BarChart
            data={engagement.byHour.map((h) => ({
              label: `${String(h.hour).padStart(2, "0")}`,
              count: h.count,
            }))}
            color="#22c55e"
            height={200}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel title="Weekly cohorts" subtitle="Share of each signup week active in the last 7 days">
          {retention.cohorts.every((c) => c.size === 0) ? (
            <EmptyState title="Not enough history" hint="Cohorts appear once accounts age." />
          ) : (
            <div className="flex flex-col gap-2.5">
              {retention.cohorts.map((c) => (
                <div key={c.weekStart} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="text-[13px] text-neutral-300">
                      Week of {new Date(c.weekStart).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                    </span>
                    <span className="text-[12px] text-neutral-500">
                      {c.stillActive}/{c.size} ·{" "}
                      <span className="text-white font-semibold">{c.retention}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-indigo-500"
                      style={{ width: `${Math.min(c.retention, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Content mix" subtitle="Posts with media vs text only">
          <DonutChart
            data={[
              { label: "With media", count: engagement.mediaSplit.media, color: "#6366f1" },
              { label: "Text only", count: engagement.mediaSplit.text, color: "#374151" },
            ]}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel title="Top posts" subtitle={`Most liked, last ${days} days`}>
          {engagement.topPosts.length === 0 ? (
            <EmptyState title="No posts yet" />
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-800 -my-2">
              {engagement.topPosts.map((p) => (
                <li key={p._id} className="py-3 min-w-0">
                  <p className="text-[13px] text-neutral-200 truncate">
                    {p.content || <span className="text-neutral-600">Media post</span>}
                  </p>
                  <p className="text-[12px] text-neutral-500 mt-0.5 truncate">
                    @{p.author?.username || "deleted"} · {p.counts?.likes ?? 0} likes ·{" "}
                    {p.counts?.replies ?? 0} replies
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Most active authors" subtitle={`By posts, last ${days} days`}>
          {engagement.topAuthors.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-800 -my-2">
              {engagement.topAuthors.map((a) => (
                <li key={a._id} className="py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <UserCell user={a.author} />
                  </div>
                  <Badge tone="neutral">{a.posts} posts</Badge>
                  <span className="text-[12px] text-neutral-500 shrink-0 w-20 text-right">
                    {a.likes} likes
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Panel title="Moderator throughput" className="xl:col-span-1">
          <div className="flex flex-col gap-4 py-2">
            <div>
              <p className="text-[26px] font-bold">{moderation.avgResolutionHours}h</p>
              <p className="text-[12px] text-neutral-500">Average time to resolve</p>
            </div>
            <div>
              <p className="text-[26px] font-bold">{moderation.resolvedInPeriod}</p>
              <p className="text-[12px] text-neutral-500">Resolved this period</p>
            </div>
          </div>
        </Panel>

        <Panel title="Reports by target" className="xl:col-span-1">
          <BarList
            data={moderation.byTargetType.map((t, i) => ({
              label: t.id,
              count: t.count,
              color: CHART_COLORS[i % CHART_COLORS.length],
            }))}
          />
        </Panel>

        <Panel title="Reports filed" subtitle="Per day" className="xl:col-span-1">
          <AreaChart
            series={[{ name: "Reports", color: "#ef4444", points: moderation.perDay }]}
            height={180}
            showLegend={false}
          />
        </Panel>
      </div>
    </div>
  );
};

export default AdminAnalytics;
