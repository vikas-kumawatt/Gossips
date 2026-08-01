import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Icons } from "../icons";
import useWindow from "../../hooks/UseWindow";
import { lockBodyScroll, unlockBodyScroll } from "../../lib/scrollLock";

const CLOSE_MS = 200;

/**
 * ResponsivePanel — a full-screen page on mobile, a centered modal on desktop.
 *
 * Sibling to ResponsiveSheet: same portal, escape and scroll-lock behaviour,
 * but for content that deserves the whole screen on a phone rather than a
 * bottom sheet. Used by the post activity views, which replaced react-modal —
 * that library needs every modal registered and mis-handles the nested case
 * these screens rely on (activity → likes → …).
 *
 * Mount to show, unmount to hide. `onClose` fires after the exit animation.
 */
const ResponsivePanel = ({
  onClose,
  title,
  onBack,
  headerRight,
  // Set false when the content pins its own header/footer and scrolls one
  // region itself; the child then needs to be a flex item, not `h-full`.
  scrollBody = true,
  children,
}) => {
  const { windowSize } = useWindow();
  const isMobile = (windowSize.width ?? window.innerWidth) < 768;

  const [visible, setVisible] = useState(false);
  const closeTimer = useRef(null);

  const requestClose = useCallback(() => {
    if (closeTimer.current) return;
    setVisible(false);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      onClose();
    }, CLOSE_MS);
  }, [onClose]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => {
      cancelAnimationFrame(id);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", handleKey);
    lockBodyScroll();
    return () => {
      document.removeEventListener("keydown", handleKey);
      unlockBodyScroll();
    };
  }, [requestClose]);

  const panelStyle = isMobile
    ? {
        // Slides up as a page rather than scaling like a dialog.
        transform: visible ? "translateY(0)" : "translateY(2%)",
        opacity: visible ? 1 : 0,
        transition: `transform ${CLOSE_MS}ms ease, opacity ${CLOSE_MS}ms ease`,
      }
    : {
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.96)",
        transition: `opacity ${CLOSE_MS}ms ease, transform ${CLOSE_MS}ms ease`,
      };

  return createPortal(
    <div
      className={`fixed inset-0 z-[2000] flex justify-center ${
        isMobile ? "" : "items-center px-4 bg-black/80"
      }`}
      style={{ opacity: visible ? 1 : 0, transition: `opacity ${CLOSE_MS}ms ease` }}
      onClick={isMobile ? undefined : requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={panelStyle}
        className={`bg-neutral-950 text-white flex flex-col ${
          isMobile
            ? "w-full h-full"
            : `w-full max-w-lg rounded-2xl border border-neutral-800 overflow-hidden ${
                scrollBody ? "max-h-[80vh]" : "h-[80vh]"
              }`
        }`}
      >
        <header className="shrink-0 relative flex items-center justify-between gap-2 px-4 h-14 border-b border-neutral-800">
          <button
            type="button"
            onClick={onBack || requestClose}
            className="p-1.5 -ml-1.5 rounded-full text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
            aria-label={onBack ? "Back" : "Close"}
          >
            {/* A phone gets a back arrow because the panel is a page; a modal
                gets a close cross because it's an overlay. */}
            {onBack || isMobile ? (
              <Icons.back className="w-5 h-5" />
            ) : (
              <X className="w-[18px] h-[18px]" />
            )}
          </button>

          <h2 className="absolute left-1/2 -translate-x-1/2 font-semibold text-[16px] text-white truncate max-w-[55%]">
            {title}
          </h2>

          <div className="shrink-0">{headerRight}</div>
        </header>

        <div
          className={
            scrollBody
              ? "flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar"
              : "flex-1 min-h-0 flex flex-col overflow-hidden"
          }
        >
          {typeof children === "function" ? children(requestClose) : children}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ResponsivePanel;
