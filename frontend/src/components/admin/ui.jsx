import { Loader2, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Sparkline } from "./charts";

/** Shared building blocks for the admin pages. Dark, dense, table-first. */

export const Panel = ({ title, subtitle, action, children, className = "" }) => (
  <section
    className={`bg-[#111111] border border-neutral-800 rounded-2xl overflow-hidden ${className}`}
  >
    {(title || action) && (
      <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-neutral-800">
        <div className="min-w-0">
          {title && <h2 className="text-[15px] font-semibold text-white truncate">{title}</h2>}
          {subtitle && <p className="text-[12px] text-neutral-500 mt-0.5">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
    )}
    <div className="p-5">{children}</div>
  </section>
);

export const StatCard = ({ label, value, trend, hint, spark, color = "#6366f1" }) => {
  const up = typeof trend === "number" && trend > 0;
  const down = typeof trend === "number" && trend < 0;

  return (
    <div className="bg-[#111111] border border-neutral-800 rounded-2xl p-4 min-w-0">
      <p className="text-[12px] text-neutral-500 truncate">{label}</p>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <span className="text-[26px] leading-none font-bold text-white truncate">{value}</span>
        {spark?.length > 1 && <Sparkline points={spark} color={color} width={72} height={26} />}
      </div>
      <div className="mt-2 flex items-center gap-2 min-w-0">
        {typeof trend === "number" && (
          <span
            className={`text-[12px] font-semibold shrink-0 ${
              up ? "text-green-400" : down ? "text-red-400" : "text-neutral-500"
            }`}
          >
            {up ? "▲" : down ? "▼" : "•"} {Math.abs(trend)}%
          </span>
        )}
        {hint && <span className="text-[12px] text-neutral-600 truncate">{hint}</span>}
      </div>
    </div>
  );
};

const TONES = {
  neutral: "bg-neutral-800 text-neutral-300",
  green: "bg-green-500/15 text-green-400",
  red: "bg-red-500/15 text-red-400",
  amber: "bg-amber-500/15 text-amber-400",
  blue: "bg-blue-500/15 text-blue-400",
  purple: "bg-purple-500/15 text-purple-300",
};

export const Badge = ({ tone = "neutral", children }) => (
  <span
    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${
      TONES[tone] || TONES.neutral
    }`}
  >
    {children}
  </span>
);

export const STATUS_TONE = {
  active: "green",
  suspended: "red",
  deactivated: "neutral",
  deleted: "neutral",
  locked: "amber",
  pending: "amber",
  reviewing: "blue",
  actioned: "green",
  dismissed: "neutral",
  reviewed: "blue",
  resolved: "green",
};

export const ROLE_TONE = { user: "neutral", admin: "blue", super_admin: "purple" };

export const Button = ({ variant = "secondary", size = "md", className = "", ...props }) => {
  const base =
    "inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default whitespace-nowrap";
  const sizes = { sm: "px-3 py-1.5 text-[13px]", md: "px-4 py-2 text-sm" };
  const variants = {
    primary: "bg-white text-black hover:bg-neutral-200",
    secondary: "border border-neutral-700 text-white hover:bg-neutral-800",
    danger: "bg-red-500/15 text-red-400 hover:bg-red-500/25",
    ghost: "text-neutral-400 hover:text-white hover:bg-neutral-800",
  };
  return (
    <button
      type="button"
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
};

export const SearchInput = ({ value, onChange, placeholder = "Search…" }) => (
  <div className="relative flex-1 min-w-[180px]">
    <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-neutral-600"
    />
  </div>
);

export const Select = ({ value, onChange, options, label }) => (
  <label className="flex items-center gap-2 shrink-0">
    {label && <span className="text-[12px] text-neutral-500">{label}</span>}
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-neutral-600 cursor-pointer"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </label>
);

export const Toggle = ({ checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={!!checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40 disabled:cursor-default cursor-pointer ${
      checked ? "bg-green-500" : "bg-neutral-700"
    }`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
        checked ? "translate-x-5" : ""
      }`}
    />
  </button>
);

export const Spinner = ({ className = "" }) => (
  <div className={`flex items-center justify-center py-12 ${className}`}>
    <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
  </div>
);

export const EmptyState = ({ title, hint }) => (
  <div className="py-14 text-center">
    <p className="text-neutral-300 font-semibold text-[15px]">{title}</p>
    {hint && <p className="text-neutral-600 text-[13px] mt-1">{hint}</p>}
  </div>
);

export const ErrorState = ({ message, onRetry }) => (
  <div className="py-14 text-center">
    <p className="text-red-400 font-semibold text-[15px]">{message}</p>
    {onRetry && (
      <Button size="sm" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    )}
  </div>
);

export const Pagination = ({ pageInfo, onPage }) => {
  if (!pageInfo || pageInfo.pages <= 1) return null;
  const { page, pages, total } = pageInfo;

  return (
    <div className="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-neutral-800">
      <span className="text-[12px] text-neutral-500">
        Page {page} of {pages} · {total.toLocaleString()} total
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="w-4 h-4" />
          Prev
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};

/** Horizontally scrollable so a wide table never breaks the page layout. */
export const TableWrap = ({ children }) => (
  <div className="overflow-x-auto custom-scrollbar -mx-5 px-5">
    <table className="w-full min-w-[720px] border-collapse">{children}</table>
  </div>
);

export const Th = ({ children, className = "" }) => (
  <th
    className={`text-left text-[11px] uppercase tracking-wide font-semibold text-neutral-500 pb-3 px-2 whitespace-nowrap ${className}`}
  >
    {children}
  </th>
);

export const Td = ({ children, className = "" }) => (
  <td className={`py-3 px-2 text-sm text-neutral-300 align-middle ${className}`}>{children}</td>
);

/**
 * The verification tick.
 *
 * Inline SVG rather than the app's `Icons.verified2`, which is sized and
 * coloured for the feed and can't be scaled down to fit a table row.
 */
export const VerifiedTick = ({ className = "w-4 h-4" }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={`text-blue-500 ${className}`} aria-hidden="true">
    <title>Verified</title>
    <path d="M12 1.5l2.35 1.72 2.9-.13 1.06 2.7 2.53 1.43-.6 2.84 1.76 2.31-1.99 2.1.16 2.9-2.82.82-1.57 2.45-2.78-.83-2.78.83-1.57-2.45-2.82-.82.16-2.9-1.99-2.1 1.76-2.31-.6-2.84 2.53-1.43 1.06-2.7 2.9.13L12 1.5zm-1.2 13.3l5.1-5.1-1.42-1.41-3.68 3.68-1.88-1.88-1.42 1.42 3.3 3.29z" />
  </svg>
);

export const UserCell = ({ user }) => {
  if (!user) return <span className="text-neutral-600">deleted account</span>;
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <img
        src={user.profilePic || "/default-avatar.png"}
        alt=""
        className="w-8 h-8 rounded-full object-cover shrink-0 bg-neutral-800"
      />
      <div className="min-w-0">
        {/* The name truncates; the tick never does. */}
        <div className="flex items-center gap-1 min-w-0">
          <p className="text-white text-[13px] font-medium truncate">
            {user.name || user.username}
          </p>
          {user.isVerified && <VerifiedTick className="w-3.5 h-3.5 shrink-0" />}
        </div>
        <p className="text-neutral-500 text-[12px] truncate">@{user.username}</p>
      </div>
    </div>
  );
};

export const relativeTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
};
