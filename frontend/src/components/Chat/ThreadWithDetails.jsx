import { useOutlet } from "react-router-dom";

/**
 * A conversation, with its details as a third column on a wide screen.
 *
 * Details used to *replace* the thread. `/chat/ana/details` and
 * `/chat/group/x/info` were siblings of the conversation route, so opening either
 * unmounted the thread — on a 1440px display you lost the messages you were reading to
 * look at a shared-media grid, and closing the panel remounted the thread, refetched it
 * and threw away your scroll position.
 *
 * Nesting them under the conversation route is what fixes that: React Router keeps a
 * parent mounted while a child renders, so the thread here is the same instance before,
 * during and after. This component is the route element for the parent, and the panel is
 * whatever the child route resolves to.
 *
 * `useOutlet()` rather than `<Outlet />` because the difference between "a details route
 * is active" and "it isn't" has to be known *before* rendering — with `<Outlet />` there
 * is no way to ask, and the two-column and three-column layouts are different trees.
 *
 * ── Why the breakpoint is `xl` ──────────────────────────────────────────────
 *
 * The list is 380px and the panel is 380px. At `lg` (1024px) that leaves 264px for the
 * messages, which is narrower than the composer needs and puts every bubble on three
 * lines. At `xl` (1280px) the thread keeps 520px, which is about what a phone-width
 * conversation gets. Below `xl` the panel takes the thread's place, which is the
 * behaviour that already existed and is still the right one on a small window.
 */
const ThreadWithDetails = ({ children }) => {
  const details = useOutlet();

  // No details route active: the thread is the whole pane, exactly as before.
  if (!details) return children;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/*
        Hidden rather than unmounted below `xl`.
        `display: none` keeps the component mounted, so its messages, its scroll
        position and any playing voice note survive a trip into the details panel and
        back — which is the whole point of nesting the routes.
      */}
      <div className="hidden xl:flex flex-1 flex-col min-w-0 overflow-hidden">
        {children}
      </div>

      {/*
        `flex-1` under `xl` so it fills the pane on its own, a fixed column at `xl` and
        above. `min-w-0` on both children because a flex item defaults to `min-width:
        auto`, and one long unbroken word in a message would otherwise push the panel
        off the edge instead of wrapping.
      */}
      <aside
        aria-label="Conversation details"
        className="flex flex-1 xl:flex-none xl:w-[380px] flex-col min-w-0 overflow-hidden xl:border-l xl:border-neutral-800"
      >
        {details}
      </aside>
    </div>
  );
};

export default ThreadWithDetails;
