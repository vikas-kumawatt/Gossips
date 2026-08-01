import { useCallback, useEffect, useRef } from "react";

/**
 * Long press, without the press also counting as a tap.
 *
 * The awkward part isn't the timer, it's everything the platform does around
 * it. Holding a link on a phone pops the OS share/copy sheet and starts a text
 * selection; letting go still fires a click, so the page navigates out from
 * under the thing you just opened. Each of those is suppressed here rather
 * than at every call site.
 *
 * Pointer events, not touch events: one code path covers touch, pen and a
 * mouse held down, and `pointercancel` gives us the scroll case for free —
 * dragging the page shouldn't be read as a long press.
 *
 * @param {Function} onLongPress
 * @param {{ delay?: number, moveTolerance?: number }} [options]
 * @returns props to spread onto the element
 */
export const useLongPress = (onLongPress, { delay = 450, moveTolerance = 10 } = {}) => {
  const timer = useRef(null);
  const origin = useRef(null);
  // Set when the long press fires, read and cleared by the click that follows.
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  const start = useCallback(
    (event) => {
      // Left button only; a right-click has its own meaning.
      if (event.button !== undefined && event.button !== 0) return;
      /*
       * Touch and pen only. On a mouse this is not a gesture anyone performs
       * deliberately — it would turn any unhurried click into a surprise, and
       * suppressing the context menu would cost "open in new tab". Desktop
       * gets the same thing from a menu entry instead.
       */
      if (event.pointerType === "mouse") return;

      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };

      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress(event);
      }, delay);
    },
    [onLongPress, delay]
  );

  const move = useCallback(
    (event) => {
      if (!origin.current) return;
      /*
       * A finger never holds perfectly still. Without a tolerance the press is
       * cancelled by the tremor of holding it; with too much, a scroll counts
       * as a press.
       */
      const dx = Math.abs(event.clientX - origin.current.x);
      const dy = Math.abs(event.clientY - origin.current.y);
      if (dx > moveTolerance || dy > moveTolerance) cancel();
    },
    [cancel, moveTolerance]
  );

  const handleClick = useCallback((event) => {
    if (!fired.current) return false;
    // Swallow the click that ends a long press, so the link doesn't navigate.
    fired.current = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, []);

  // A press interrupted by an unmount would otherwise fire into a dead
  // component.
  useEffect(() => cancel, [cancel]);

  return {
    // Spread onto the pressable element.
    handlers: {
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      /*
       * Stops the Android/iOS callout from hijacking the gesture. Only when a
       * press is actually in progress, so a desktop right-click still opens
       * the browser's own menu.
       */
      onContextMenu: (event) => {
        if (timer.current || fired.current) event.preventDefault();
      },
      style: {
        // Kills the iOS callout and the blue selection flash on hold.
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        touchAction: "manipulation",
      },
    },
    /** Call from onClick; returns true when the click was a long press. */
    consumeClick: handleClick,
  };
};
