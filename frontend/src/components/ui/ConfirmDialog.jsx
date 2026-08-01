import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { lockBodyScroll, unlockBodyScroll } from "../../lib/scrollLock";

/**
 * A destructive confirmation — "delete this?", "block them?".
 *
 * Deliberately a centered alert on every screen size, unlike the rest of the
 * app's overlays. A bottom sheet reads as "here are some options"; an alert
 * reads as "stop and decide", and that difference is the whole point of a
 * confirm. It's also what iOS, Instagram and X all still do on phones.
 *
 * Mount to show, unmount to hide. Six near-identical hand-rolled dialogs used
 * to do this each in their own way, with slightly different widths, z-indexes
 * and button orders.
 *
 * @param {string} title      the question, e.g. "Delete post?"
 * @param {node}   children   what happens if they confirm
 * @param {string} confirmLabel
 * @param {"danger"|"default"} tone  danger paints the confirm button red
 * @param {boolean} busy      disables both buttons mid-request
 */
const ConfirmDialog = ({
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef(null);

  useEffect(() => {
    // Focus lands on Cancel, not Confirm: a stray Enter should do nothing.
    cancelRef.current?.focus();

    const handleKey = (e) => {
      if (e.key !== "Escape") return;
      /*
       * A confirm is usually raised from a sheet, whose own Escape handler is
       * also on `document`. stopPropagation doesn't stop listeners on the same
       * node — only stopImmediatePropagation does — so without this, one
       * Escape dismissed the confirm and the sheet behind it.
       */
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      onCancel?.();
    };
    // Capture phase, so this runs before the sheet's bubble-phase listener.
    document.addEventListener("keydown", handleKey, true);
    lockBodyScroll();

    return () => {
      document.removeEventListener("keydown", handleKey, true);
      unlockBodyScroll();
    };
  }, [onCancel]);

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      // Above every sheet and panel: a confirm is often raised *from* one.
      className="fixed inset-0 z-[2500] flex items-center justify-center bg-black/70 px-4"
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onCancel?.();
      }}
    >
      <div
        className="w-full max-w-[340px] rounded-2xl border border-neutral-700 bg-[#181818] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold text-white">{title}</h2>
        {children && (
          <div className="mt-2 text-sm leading-relaxed text-neutral-400">{children}</div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onCancel?.();
            }}
            className="flex-1 cursor-pointer rounded-xl border border-neutral-700 py-2.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onConfirm?.();
            }}
            className={`flex-1 cursor-pointer rounded-xl py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${
              tone === "danger" ? "bg-rose-600 text-white" : "bg-white text-black"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ConfirmDialog;
