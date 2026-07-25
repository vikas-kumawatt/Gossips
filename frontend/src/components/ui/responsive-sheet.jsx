import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, X } from "lucide-react";
import useWindow from "../../hooks/UseWindow";

const CLOSE_MS = 200;
const DRAG_DISMISS_PX = 90;

/**
 * ResponsiveSheet — a bottom sheet on mobile, a centered modal on desktop.
 *
 * Mount it to show it and unmount it to hide it; there is no `open` prop.
 * Rendered in a portal because callers sit inside cards that clip or transform
 * their children. Closing is animated, so `onClose` fires after the exit
 * transition rather than on the click itself — `children` may be a function so
 * that content can close the sheet the same animated way.
 */
const ResponsiveSheet = ({
  onClose,
  title,
  onBack,
  canClose,
  // The sheet scrolls its whole body by default. Pass false when the content
  // needs to pin its own header/footer and scroll just one region — the child
  // then owns the overflow and should fill the height with `h-full`.
  scrollBody = true,
  children,
}) => {
  const { windowSize } = useWindow();
  const isMobile = (windowSize.width ?? window.innerWidth) < 768;

  const [visible, setVisible] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef(null);
  const closeTimer = useRef(null);

  const requestClose = useCallback(() => {
    if (closeTimer.current) return; // already closing
    // Veto hook (e.g. "discard your changes?"). Must run before the exit
    // animation starts, or a cancelled close leaves the sheet invisible.
    if (canClose && !canClose()) return;
    setVisible(false);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      onClose();
    }, CLOSE_MS);
  }, [onClose, canClose]);

  // Play the enter transition on the frame after mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => {
      cancelAnimationFrame(id);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  // Escape to close, and stop the page behind from scrolling.
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [requestClose]);

  const handleTouchStart = (e) => {
    if (!isMobile) return;
    dragStartY.current = e.touches[0].clientY;
    setDragging(true);
  };

  const handleTouchMove = (e) => {
    if (dragStartY.current === null) return;
    const delta = e.touches[0].clientY - dragStartY.current;
    setDragY(delta > 0 ? delta : 0);
  };

  const handleTouchEnd = () => {
    if (dragStartY.current === null) return;
    dragStartY.current = null;
    setDragging(false);
    if (dragY > DRAG_DISMISS_PX) requestClose();
    else setDragY(0);
  };

  const panelStyle = isMobile
    ? {
        transform: visible ? `translateY(${dragY}px)` : "translateY(100%)",
        transition: dragging
          ? "none"
          : `transform ${CLOSE_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
      }
    : {
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.96)",
        transition: `opacity ${CLOSE_MS}ms ease, transform ${CLOSE_MS}ms ease`,
      };

  return createPortal(
    <div
      className={`fixed inset-0 z-[2000] flex justify-center bg-black/70 ${
        isMobile ? "items-end" : "items-center px-4"
      }`}
      style={{
        opacity: visible ? 1 : 0,
        transition: `opacity ${CLOSE_MS}ms ease`,
      }}
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={panelStyle}
        /*
         * A pinned-footer layout needs a *definite* height to divide up —
         * `max-height` alone leaves the flex children sized to their content,
         * so `flex-1` has no free space to claim and anything past the cap
         * gets clipped by overflow-hidden instead of scrolling.
         */
        className={`w-full bg-[#181818] text-white border-neutral-700 flex flex-col overflow-hidden ${
          isMobile
            ? `rounded-t-3xl border-t pb-[env(safe-area-inset-bottom)] ${
                scrollBody ? "max-h-[85vh]" : "h-[85vh]"
              }`
            : `max-w-[460px] rounded-2xl border ${
                scrollBody ? "max-h-[80vh]" : "h-[80vh]"
              }`
        }`}
      >
        {isMobile && (
          <div
            className="pt-3 pb-1 shrink-0 cursor-grab active:cursor-grabbing"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="mx-auto h-1 w-10 rounded-full bg-neutral-600" />
          </div>
        )}

        <div
          className={`relative flex items-center justify-center shrink-0 px-3 ${
            isMobile ? "py-3" : "py-4"
          } border-b border-neutral-800`}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="absolute left-2 p-1.5 rounded-full hover:bg-neutral-800 transition-colors cursor-pointer"
              aria-label="Back"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <h2 className="w-full min-w-0 font-bold text-[15px] px-10 text-center truncate">
            {title}
          </h2>
          <button
            type="button"
            onClick={requestClose}
            className="absolute right-2 p-1.5 rounded-full hover:bg-neutral-800 transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        {/* overflow-x-hidden so a stray wide child can't add a second bar.
            `min-h-0` is what lets a flex child actually shrink and scroll. */}
        {/* Flex all the way down: `height: 100%` wouldn't resolve against a
            flex item that has no explicit height, so the child stays a flex
            item instead of relying on a percentage. */}
        <div
          className={
            scrollBody
              ? "overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar"
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

export default ResponsiveSheet;
