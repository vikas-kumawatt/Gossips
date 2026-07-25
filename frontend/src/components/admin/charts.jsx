import { useId, useMemo, useState } from "react";

/**
 * Hand-rolled SVG charts. No dependency, and they inherit the app's dark
 * palette directly instead of fighting a library's defaults.
 *
 * All charts draw into a fixed viewBox and scale via `width: 100%`, so they're
 * responsive without measuring the DOM.
 */

export const CHART_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#a855f7",
  "#ef4444",
  "#84cc16",
];

const formatNumber = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n * 10) / 10}`;
};

const formatDay = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** "Nice" axis ceiling so gridlines land on round numbers. */
const niceMax = (max) => {
  if (max <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  const scaled = max / pow;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * pow;
};

// ─────────────────────────────────────────────────────────────────────────────
// Area / line chart
// ─────────────────────────────────────────────────────────────────────────────

const W = 720;
const H = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

/**
 * @param series [{ name, color, points: [{date, count}] }]
 */
export const AreaChart = ({ series = [], height = H, showLegend = true }) => {
  const gradientId = useId();
  const [hover, setHover] = useState(null);

  const active = series.filter((s) => s.points?.length);
  const length = active[0]?.points?.length || 0;

  const max = useMemo(() => {
    const highest = Math.max(
      1,
      ...active.flatMap((s) => s.points.map((p) => p.count || 0))
    );
    return niceMax(highest);
  }, [active]);

  if (!length) {
    return <EmptyChart height={height} />;
  }

  const plotW = W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (length === 1 ? plotW / 2 : (i / (length - 1)) * plotW);
  const y = (v) => PAD.top + plotH - (Math.max(0, v) / max) * plotH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full"
        style={{ height: "auto" }}
        role="img"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {active.map((s, i) => (
            <linearGradient
              key={s.name}
              id={`${gradientId}-${i}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {gridLines.map((g) => {
          const gy = PAD.top + plotH * g;
          return (
            <g key={g}>
              <line
                x1={PAD.left}
                y1={gy}
                x2={W - PAD.right}
                y2={gy}
                stroke="#262626"
                strokeWidth="1"
              />
              <text x={PAD.left - 8} y={gy + 4} textAnchor="end" fontSize="11" fill="#6b7280">
                {formatNumber(max * (1 - g))}
              </text>
            </g>
          );
        })}

        {active.map((s, si) => {
          const line = s.points
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.count)}`)
            .join(" ");
          const area = `${line} L${x(s.points.length - 1)},${PAD.top + plotH} L${x(0)},${
            PAD.top + plotH
          } Z`;
          return (
            <g key={s.name}>
              <path d={area} fill={`url(#${gradientId}-${si})`} />
              <path
                d={line}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {hover !== null && (
          <line
            x1={x(hover)}
            y1={PAD.top}
            x2={x(hover)}
            y2={PAD.top + plotH}
            stroke="#525252"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}
        {hover !== null &&
          active.map((s) => (
            <circle
              key={s.name}
              cx={x(hover)}
              cy={y(s.points[hover]?.count || 0)}
              r="4"
              fill={s.color}
              stroke="#0a0a0a"
              strokeWidth="2"
            />
          ))}

        {/* Invisible hit strips — one per data point, for the hover readout */}
        {Array.from({ length }, (_, i) => (
          <rect
            key={i}
            x={PAD.left + (i / length) * plotW}
            y={PAD.top}
            width={plotW / length}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}

        {[0, Math.floor(length / 2), length - 1]
          .filter((i, idx, arr) => i >= 0 && arr.indexOf(i) === idx)
          .map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === length - 1 ? "end" : "middle"}
              fontSize="11"
              fill="#6b7280"
            >
              {formatDay(active[0].points[i]?.date)}
            </text>
          ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        {showLegend &&
          active.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5 text-[12px] text-neutral-400">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
              />
              {s.name}
              {hover !== null && (
                <span className="text-white font-semibold">
                  {formatNumber(s.points[hover]?.count || 0)}
                </span>
              )}
            </span>
          ))}
        {hover !== null && (
          <span className="text-[12px] text-neutral-500 ml-auto">
            {formatDay(active[0].points[hover]?.date)}
          </span>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Bar chart
// ─────────────────────────────────────────────────────────────────────────────

export const BarChart = ({ data = [], color = "#6366f1", height = 200, labelKey = "label" }) => {
  const [hover, setHover] = useState(null);

  if (!data.length) return <EmptyChart height={height} />;

  const max = niceMax(Math.max(1, ...data.map((d) => d.count || 0)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const slot = plotW / data.length;
  const barW = Math.max(2, Math.min(slot * 0.65, 42));

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
        {[0, 0.5, 1].map((g) => {
          const gy = PAD.top + plotH * g;
          return (
            <g key={g}>
              <line x1={PAD.left} y1={gy} x2={W - PAD.right} y2={gy} stroke="#262626" />
              <text x={PAD.left - 8} y={gy + 4} textAnchor="end" fontSize="11" fill="#6b7280">
                {formatNumber(max * (1 - g))}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const barH = ((d.count || 0) / max) * plotH;
          const bx = PAD.left + i * slot + (slot - barW) / 2;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={plotH}
                fill="transparent"
              />
              <rect
                x={bx}
                y={PAD.top + plotH - barH}
                width={barW}
                height={Math.max(barH, d.count ? 2 : 0)}
                rx="3"
                fill={color}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
              {hover === i && (
                <text
                  x={bx + barW / 2}
                  y={PAD.top + plotH - barH - 6}
                  textAnchor="middle"
                  fontSize="11"
                  fill="#fff"
                  fontWeight="600"
                >
                  {d.count}
                </text>
              )}
            </g>
          );
        })}

        {data.map((d, i) =>
          data.length <= 24 || i % Math.ceil(data.length / 12) === 0 ? (
            <text
              key={`l${i}`}
              x={PAD.left + i * slot + slot / 2}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#6b7280"
            >
              {d[labelKey]}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Donut
// ─────────────────────────────────────────────────────────────────────────────

export const DonutChart = ({ data = [], size = 180, thickness = 26 }) => {
  const total = data.reduce((sum, d) => sum + (d.count || 0), 0);
  const [hover, setHover] = useState(null);

  if (!total) return <EmptyChart height={size} />;

  const r = size / 2 - thickness / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        <g transform={`rotate(-90 ${c} ${c})`}>
          {data.map((d, i) => {
            const fraction = (d.count || 0) / total;
            const dash = fraction * circumference;
            const el = (
              <circle
                key={i}
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={d.color || CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth={hover === i ? thickness + 4 : thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width 120ms" }}
              />
            );
            offset += dash;
            return el;
          })}
        </g>
        <text x={c} y={c - 2} textAnchor="middle" fontSize="24" fontWeight="700" fill="#fff">
          {formatNumber(hover === null ? total : data[hover].count)}
        </text>
        <text x={c} y={c + 18} textAnchor="middle" fontSize="11" fill="#6b7280">
          {hover === null ? "total" : data[hover].label}
        </text>
      </svg>

      <div className="flex flex-col gap-2 min-w-0 flex-1">
        {data.map((d, i) => (
          <div
            key={i}
            className="flex items-center gap-2 text-[13px] min-w-0"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: d.color || CHART_COLORS[i % CHART_COLORS.length] }}
            />
            <span className="text-neutral-300 truncate min-w-0 flex-1">{d.label}</span>
            <span className="text-white font-semibold shrink-0">{d.count}</span>
            <span className="text-neutral-500 text-[12px] shrink-0 w-11 text-right">
              {Math.round((d.count / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline + progress ring + bar list
// ─────────────────────────────────────────────────────────────────────────────

export const Sparkline = ({ points = [], color = "#6366f1", width = 120, height = 32 }) => {
  if (points.length < 2) return <div style={{ width, height }} />;

  const values = points.map((p) => p.count || 0);
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const span = max - min || 1;

  const path = values
    .map((v, i) => {
      const px = (i / (values.length - 1)) * width;
      const py = height - ((v - min) / span) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${px},${py}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={path} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
};

export const ProgressRing = ({ value = 0, size = 96, thickness = 9, color = "#6366f1", label }) => {
  const r = size / 2 - thickness / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(value, 100));

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        <circle cx={c} cy={c} r={r} fill="none" stroke="#262626" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${c} ${c})`}>
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
          />
        </g>
        <text x={c} y={c + 6} textAnchor="middle" fontSize="18" fontWeight="700" fill="#fff">
          {Math.round(pct)}%
        </text>
      </svg>
      {label && <span className="text-[12px] text-neutral-500">{label}</span>}
    </div>
  );
};

/** Horizontal ranked bars — better than a donut once there are many categories. */
export const BarList = ({ data = [], color = "#6366f1" }) => {
  if (!data.length) return <p className="text-neutral-500 text-sm py-6 text-center">No data yet</p>;
  const max = Math.max(1, ...data.map((d) => d.count || 0));

  return (
    <div className="flex flex-col gap-2.5">
      {data.map((d, i) => (
        <div key={i} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <span className="text-[13px] text-neutral-300 truncate min-w-0">{d.label}</span>
            <span className="text-[13px] text-white font-semibold shrink-0">{d.count}</span>
          </div>
          <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${((d.count || 0) / max) * 100}%`,
                backgroundColor: d.color || color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

const EmptyChart = ({ height }) => (
  <div
    className="w-full flex items-center justify-center text-neutral-600 text-sm"
    style={{ height }}
  >
    Not enough data yet
  </div>
);

export { formatNumber };
