import ResponsiveSheet from "./responsive-sheet";
import useWindow from "../../hooks/UseWindow";

/**
 * The hand-rolled counterpart to the Radix wrapper: keeps an existing
 * absolutely-positioned dropdown exactly as it is on desktop, and renders the
 * same children as a bottom sheet on a phone.
 *
 * Deliberately dumb. The call sites already own their open state, their
 * outside-click handling and their item markup; rewriting all of that would be
 * a much bigger change than the one actually being asked for. This only swaps
 * the container.
 *
 * @param {boolean}  open       caller keeps the state
 * @param {function} onClose    called when the sheet is dismissed
 * @param {string}   title      sheet heading (mobile only)
 * @param {string}   className  the desktop positioning classes, ignored on mobile
 * @param {object}   style      desktop inline positioning (left/top from a
 *                              click point); ignored on mobile, where the
 *                              sheet positions itself
 */
const ResponsiveMenu = ({ open, onClose, title = "Options", className, style, children }) => {
  const { windowSize } = useWindow();
  const isMobile = (windowSize.width ?? window.innerWidth) < 768;

  if (!open) return null;

  if (isMobile) {
    return (
      <ResponsiveSheet title={title} onClose={onClose}>
        {/*
          These rows were written for a ~250px anchored popover: `w-full`
          together with `mx-2`, which in a full-width sheet overflows to the
          right by exactly the margin — the label keeps its inset while the
          trailing icon sits flush against the edge. Rather than editing
          twenty-odd call sites, the sheet restates the box model for its own
          width. `!` because the originals are equally specific.
        */}
        <div className="[&_button]:!mx-0 [&_button]:!w-full [&_button]:!rounded-none [&_button]:!px-5 [&_button]:!py-3.5">
          {children}
        </div>
      </ResponsiveSheet>
    );
  }

  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
};

export default ResponsiveMenu;
