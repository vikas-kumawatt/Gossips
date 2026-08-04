import React from "react";
import { useLongPress } from "../../hooks/useLongPress";

/**
 * A div that opens a context menu on long press, right-click or keyboard.
 *
 * Exists because group message bubbles are rendered inline inside
 * `messages.map(...)` rather than as a component, so `useLongPress` — a hook —
 * can't be called per message there. Wrapping in a component is what makes the
 * hook legal without restructuring the whole thread render.
 *
 * Group chat previously had `onContextMenu` and nothing else, so on a phone the
 * message menu was unreachable: reply, edit, unsend, pin, report and download were
 * desktop-only features of a feature people use on a phone. This is the same
 * treatment DM bubbles already got (#47).
 */
const LongPressArea = ({ onTrigger, className = "", children, ...rest }) => {
  const longPress = useLongPress((event) => onTrigger(event));

  return (
    <div
      className={`${longPress.className} ${className}`}
      {...longPress.handlers}
      onContextMenu={(event) => {
        // The hook suppresses the OS callout mid-press; a genuine right-click
        // still has to open the app's menu instead of the browser's.
        longPress.handlers.onContextMenu?.(event);
        onTrigger(event);
      }}
      // Swallows the click that ends a long press, so the bubble's own handlers
      // don't fire as well as the menu opening.
      onClick={(event) => longPress.consumeClick(event)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          onTrigger(event);
        }
      }}
      {...rest}
    >
      {children}
    </div>
  );
};

export default LongPressArea;
