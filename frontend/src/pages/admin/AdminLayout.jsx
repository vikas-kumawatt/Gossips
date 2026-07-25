import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Flag,
  FileText,
  TrendingUp,
  Settings,
  ScrollText,
  ArrowLeft,
  Loader2,
  ShieldAlert,
  Menu,
  X,
} from "lucide-react";
import { adminAPI } from "../../services/api";
import { Badge } from "../../components/admin/ui";

/**
 * The panel's access check is a server call, not a localStorage read. A
 * tampered `role` in the client store gets a 404 from /admin/session and
 * lands here on the denied screen; every data endpoint is gated independently
 * anyway, so nothing leaks even if this screen were bypassed.
 */
const NAV = [
  { to: "/admin", end: true, label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/reports", label: "Reports", icon: Flag, badge: "pendingReports" },
  { to: "/admin/content", label: "Content", icon: FileText },
  { to: "/admin/analytics", label: "Analytics", icon: TrendingUp },
  { to: "/admin/audit", label: "Audit log", icon: ScrollText },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];

const AdminLayout = () => {
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [state, setState] = useState("loading"); // loading | ready | denied
  const [navOpen, setNavOpen] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const data = await adminAPI.session();
      setSession(data);
      setState("ready");
    } catch {
      setState("denied");
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  if (state === "loading") {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-neutral-600" />
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="mx-auto w-12 h-12 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center">
            <ShieldAlert className="w-6 h-6 text-neutral-500" />
          </div>
          <h1 className="mt-4 text-lg font-bold text-white">Nothing here</h1>
          <p className="mt-2 text-[13px] text-neutral-500 leading-relaxed">
            This page doesn't exist, or you don't have access to it.
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="mt-5 px-5 py-2 rounded-xl bg-white text-black text-sm font-semibold hover:bg-neutral-200 cursor-pointer"
          >
            Back to Gossips
          </button>
        </div>
      </div>
    );
  }

  const sidebar = (
    <>
      <div className="px-4 py-5 border-b border-neutral-800">
        <p className="text-[11px] uppercase tracking-widest text-neutral-600 font-semibold">
          Gossips
        </p>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-[17px] font-bold text-white">Admin</h1>
          <Badge tone={session.isSuperAdmin ? "purple" : "blue"}>
            {session.isSuperAdmin ? "Super admin" : "Admin"}
          </Badge>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto custom-scrollbar p-3 flex flex-col gap-1">
        {/* `item.icon` rather than a destructured `Icon`: this eslint config
            has no react plugin, so JSX usage wouldn't count as a reference. */}
        {NAV.map((item) => {
          const { to, end, label, badge } = item;
          const count = badge ? session.badges?.[badge] : 0;
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setNavOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-[14px] font-medium transition-colors ${
                  isActive
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-400 hover:text-white hover:bg-neutral-900"
                }`
              }
            >
              <item.icon className="w-[18px] h-[18px] shrink-0" />
              <span className="flex-1 truncate">{label}</span>
              {count > 0 && (
                <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="p-3 border-t border-neutral-800">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[14px] font-medium text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-[18px] h-[18px] shrink-0" />
          Back to app
        </button>
        <div className="flex items-center gap-2.5 px-3 py-2.5 mt-1 min-w-0">
          <img
            src={session.profilePic || "https://via.placeholder.com/40"}
            alt=""
            className="w-7 h-7 rounded-full object-cover bg-neutral-800 shrink-0"
          />
          <span className="text-[13px] text-neutral-400 truncate">@{session.username}</span>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-14 bg-[#0a0a0a] border-b border-neutral-800">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          className="p-2 -ml-2 rounded-lg hover:bg-neutral-800 cursor-pointer"
          aria-label="Open admin menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <span className="font-bold">Admin</span>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="ml-auto text-[13px] text-neutral-400 hover:text-white cursor-pointer"
        >
          Back to app
        </button>
      </div>

      {navOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/70" onClick={() => setNavOpen(false)} />
          <aside className="relative w-[260px] bg-[#0d0d0d] border-r border-neutral-800 flex flex-col">
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              className="absolute top-4 right-3 p-1.5 rounded-lg hover:bg-neutral-800 cursor-pointer"
              aria-label="Close admin menu"
            >
              <X className="w-4 h-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex">
        <aside className="hidden lg:flex w-[240px] shrink-0 flex-col h-screen sticky top-0 bg-[#0d0d0d] border-r border-neutral-800">
          {sidebar}
        </aside>

        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8">
          <Outlet context={{ session, refreshSession: loadSession }} />
        </main>
      </div>
    </div>
  );
};

export default AdminLayout;
