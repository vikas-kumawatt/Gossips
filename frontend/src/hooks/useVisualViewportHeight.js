import { useEffect } from "react";

/**
 * Pin a full-screen layout to the *visual* viewport, so an open keyboard shortens it
 * instead of pushing it off the top of the screen.
 *
 * `interactive-widget=resizes-content` in the viewport meta handles this on Chrome and
 * Android: the layout viewport shrinks, `100dvh` shrinks with it, and a flex column
 * simply gets shorter. iOS Safari ignores that hint. There, the keyboard leaves the
 * layout viewport at full height and the browser *pans* — it scrolls the document to
 * bring the focused input into view, which drags a viewport-tall shell upward and
 * takes the chat header with it.
 *
 * So on iOS the height has to come from `visualViewport`, which is the only thing that
 * reports the space the keyboard has left. Publishing it as `--app-height` lets the
 * shell's height be a plain CSS declaration rather than inline style plumbed through
 * several components.
 *
 * Scoped to the component that calls it, deliberately: it takes over the document's
 * scroll position, which is right for a chat screen that owns the whole viewport and
 * wrong for an ordinary scrolling page.
 */
export const useVisualViewportHeight = () => {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport) return undefined;

    const apply = () => {
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      /*
       * Undo the pan.
       *
       * iOS scrolls the *document* to reveal the focused field. The shell is exactly
       * viewport-tall and clips its own overflow, so there is nothing legitimate to
       * scroll to — any non-zero offset is the browser having moved the layout out
       * from under the visual viewport, and putting it back is what keeps the header
       * on screen.
       */
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);

    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      // Released so pages that scroll normally aren't left with a pinned height.
      root.style.removeProperty("--app-height");
    };
  }, []);
};

export default useVisualViewportHeight;
