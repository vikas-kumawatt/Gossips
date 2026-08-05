import { useCallback, useContext, useState } from "react";
import { Link, Outlet, useLocation, useMatch } from "react-router-dom";
import { MessageCircle } from "lucide-react";
import ChatPage from "./ChatPage";
import SiteHeader from "../components/layouts/site-header";
import MobileNavbar from "../components/layouts/mobile-navbar";
import NavigationMenu from "../menus/NavigationMenu";
import { Icons } from "../components/icons";
import { UserContext } from "../contexts/UserContext";
import { useVisualViewportHeight } from "../hooks/useVisualViewportHeight";

const ChatLayout = () => {
  /*
   * Publishes `--app-height` for `.h-dynamic-screen` below.
   *
   * The viewport meta's `interactive-widget=resizes-content` makes `100dvh` correct
   * when the keyboard opens on Chrome/Android; iOS Safari ignores it and pans the page
   * instead, which slid the whole shell — header included — off the top. This is the
   * iOS half of that fix, and it lives here because it takes over the document scroll
   * position, which is only appropriate for a screen that owns the whole viewport.
   */
  useVisualViewportHeight();

  /*
   * Every hook must run every render — do not use || between useMatch calls,
   * because short-circuiting skips one and breaks the Rules of Hooks.
   *
   * `end: false`, so a conversation counts as active while one of its own sub-routes is
   * open. Details, group info, People and Add people are children of the thread now, and
   * with `end: true` each needed its own pattern listed here — a list that was already
   * missing both People routes, which is why opening People on a desktop rendered the
   * "Select a conversation" placeholder instead of the page. Two prefixes cover every
   * descendant, including any added later.
   */
  const matchConversation = useMatch({ path: "/chat/:username", end: false });
  const matchGroup = useMatch({ path: "/chat/group/:groupId", end: false });
  const hasActiveChat = !!(
    matchGroup ||
    // Checked last, and excluded by name: "/chat/group" also matches `:username`.
    (matchConversation && matchConversation.params.username !== "group")
  );
  const { pathname } = useLocation();
  const { userAuth, unreadNotificationCount } = useContext(UserContext);

  // Only the setters are consumed — the flag itself is never read here.
  const [, setIsCreateModalOpen] = useState(false);
  const openCreateModal = useCallback(() => setIsCreateModalOpen(true), []);
  const closeCreateModal = useCallback(() => setIsCreateModalOpen(false), []);
  const layoutContext = { openCreateModal, closeCreateModal };

  /*
   * `100dvh`, not `h-screen`.
   *
   * `100vh` is the *large* viewport height on mobile: it doesn't shrink when the
   * on-screen keyboard opens, so the composer at the bottom of the conversation was
   * pushed below the visible area and you couldn't see what you were typing. `dvh`
   * tracks the dynamic viewport, which is exactly this case.
   *
   * A named class in index.css rather than `h-screen h-[100dvh]` side by side. Which
   * of two competing height utilities wins depends on the order Tailwind emits them,
   * not the order they appear in the attribute, so that version relied on something
   * the class list can't express. `.h-dynamic-screen` declares `100vh` then `100dvh`
   * in one rule, which the browser resolves: anything that doesn't understand `dvh`
   * discards the second line and keeps the first.
   */
  return (
    <div className="flex h-dynamic-screen overflow-hidden bg-neutral-950">
      {/* Left panel: chat list */}
      <div
        className={`${
          hasActiveChat ? "hidden md:flex" : "flex"
        } flex-col w-full md:w-[380px] flex-shrink-0 md:border-r md:border-neutral-800 overflow-hidden`}
      >
        {/* Desktop compact nav header */}
        <div className="hidden md:flex items-center justify-between px-4 py-3 border-b border-neutral-800 shrink-0">
          <Link to="/" onClick={() => window.scrollTo(0, 0)}>
            <Icons.logo className="h-8 w-8" />
          </Link>

          <div className="flex items-center gap-0.5">
            <Link to="/" className="p-2 rounded-lg hover:bg-neutral-800 transition-colors" title="Home">
              <Icons.home className="h-5 w-5" strokeColor={pathname === "/" ? "white" : "#6b6b6b"} fill={pathname === "/" ? "white" : "transparent"} />
            </Link>
            <Link to="/search" className="p-2 rounded-lg hover:bg-neutral-800 transition-colors" title="Search">
              <Icons.search className="h-5 w-5" strokeColor={pathname === "/search" ? "white" : "#6b6b6b"} />
            </Link>
            <button onClick={openCreateModal} className="p-2 rounded-lg hover:bg-neutral-800 transition-colors cursor-pointer" title="Create post">
              <Icons.create className="h-5 w-5" strokeColor="#6b6b6b" />
            </button>
            <Link to="/activity" className="p-2 rounded-lg hover:bg-neutral-800 transition-colors relative" title="Activity">
              {unreadNotificationCount > 0 ? (
                <Icons.unread className="h-5 w-5" strokeColor={pathname === "/activity" ? "white" : "#6b6b6b"} fill={pathname === "/activity" ? "white" : "transparent"} />
              ) : (
                <Icons.activity className="h-5 w-5" strokeColor={pathname === "/activity" ? "white" : "#6b6b6b"} fill={pathname === "/activity" ? "white" : "transparent"} />
              )}
            </Link>
            <Link to={`/${userAuth?.username || "profile"}`} className="p-2 rounded-lg hover:bg-neutral-800 transition-colors" title="Profile">
              <Icons.profile className="h-5 w-5" strokeColor={pathname === `/${userAuth?.username}` ? "white" : "#6b6b6b"} fill={pathname === `/${userAuth?.username}` ? "white" : "transparent"} />
            </Link>
          </div>

          <NavigationMenu />
        </div>

        {/* Mobile full site header */}
        <div className="md:hidden">
          <SiteHeader layoutContext={layoutContext} />
        </div>

        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          <ChatPage embedded />
        </div>

        {/* MobileNavbar is `fixed sm:hidden` so it self-manages */}
        <MobileNavbar layoutContext={layoutContext} />
      </div>

      {/* Right panel: conversation or empty state */}
      <div
        className={`${
          hasActiveChat ? "flex" : "hidden md:flex"
        } flex-1 flex-col overflow-hidden`}
      >
        {hasActiveChat ? (
          <Outlet />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-600 bg-neutral-950">
            <MessageCircle className="w-16 h-16 opacity-20" />
            <p className="text-sm">Select a conversation to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatLayout;
