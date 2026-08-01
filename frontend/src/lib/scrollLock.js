/**
 * One reference-counted body scroll lock, shared by every overlay.
 *
 * Each overlay used to save `document.body.style.overflow` on mount and
 * restore it on unmount. That is only correct if overlays close in the exact
 * reverse order they opened, and the responsive dropdowns broke that: choosing
 * an item starts a 200ms animated close *and* immediately mounts whatever the
 * item opened. The new overlay captures "hidden", the old one then restores
 * "" — the page scrolls behind an open sheet, and when that sheet finally
 * closes it restores "hidden" with nothing on screen, leaving the whole app
 * unscrollable until reload.
 *
 * Counting instead of saving means order stops mattering: the lock lifts when
 * the last overlay lets go, and not before.
 */

let depth = 0;
let previousOverflow = "";

export const lockBodyScroll = () => {
  if (depth === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  depth += 1;
};

export const unlockBodyScroll = () => {
  if (depth === 0) return;
  depth -= 1;
  if (depth === 0) document.body.style.overflow = previousOverflow;
};
