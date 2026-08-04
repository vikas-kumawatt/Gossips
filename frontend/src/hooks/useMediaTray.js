import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MEDIA_PER_MESSAGE, pickComposerFiles } from "../lib/composerMedia";

/**
 * The staged attachments, and the object URLs that preview them.
 *
 * Both threads did this by hand and only the DM one did it correctly. The group page
 * held a single `mediaPreview` and revoked its URL inline; the DM page had the tray but
 * its URL bookkeeping was the subtle part, and duplicating that was never going to end
 * with two identical copies.
 *
 * @param onReject Called once per distinct reason with `(message, count)`, so the page
 *                 decides whether that's a toast or an inline error.
 */
const useMediaTray = ({ onReject } = {}) => {
  const [items, setItems] = useState([]);

  /*
   * Every object URL created here, so unmount can release them.
   *
   * This was a `useCallback` over `messages` and `selectedMediaFiles`, consumed by
   * `useEffect(() => () => cleanup(), [cleanup])`. That cleanup runs whenever the
   * callback's *identity* changes — which is on every message and every attachment, not
   * only on unmount. Picking a second image revoked the first one's URL and its
   * thumbnail went blank; so did any message arriving while media was staged.
   *
   * A ref has a stable identity, so the effect below runs its cleanup exactly once.
   */
  const urlsRef = useRef(new Set());

  const track = useCallback((url) => {
    if (url?.startsWith("blob:")) urlsRef.current.add(url);
    return url;
  }, []);

  const release = useCallback((url) => {
    if (!url?.startsWith("blob:")) return;
    urlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const add = useCallback(
    (files) => {
      const { accepted, rejections } = pickComposerFiles(files, items.length);

      for (const [reason, count] of rejections) {
        onReject?.(count > 1 ? `${count} files skipped — ${reason}` : reason, count);
      }

      if (!accepted.length) return;
      // The URL is minted here rather than in the pure filter: `createObjectURL` is a
      // side effect, and it must only run for files that are actually being kept —
      // otherwise a rejected batch leaks one URL per file.
      setItems((prev) => [
        ...prev,
        ...accepted.map((item) => ({ ...item, url: track(URL.createObjectURL(item.file)) })),
      ]);
    },
    [items.length, onReject, track]
  );

  const removeAt = useCallback(
    (index) => {
      setItems((prev) => {
        release(prev[index]?.url);
        return prev.filter((_, i) => i !== index);
      });
    },
    [release]
  );

  /**
   * Hand the staged files over and empty the tray in one step.
   *
   * Deliberately does *not* revoke the URLs: the optimistic bubbles use them as their
   * source while the upload is in flight, so they have to outlive this call. The caller
   * releases them when the send settles — the same contract `useVoiceRecorder.takePreview`
   * has, for the same reason.
   */
  const take = useCallback(() => {
    // Read from the closure, not from inside an updater. A `setItems(prev => ...)` that
    // assigns `prev` to an outer variable looks equivalent and isn't: the updater is
    // called during render, twice under StrictMode, and not necessarily before this
    // function returns — so the caller could be handed an empty array.
    const taken = items;
    setItems([]);
    return taken;
  }, [items]);

  /**
   * Put a taken selection back, after a failed send.
   *
   * The blob URLs used to be revoked on failure, which made the user's pick
   * unrecoverable: the files had already been cleared from the composer, so a failure on
   * the last of six left nothing on screen and nothing to retry with. Keeping the objects
   * alive means Retry is just pressing send again.
   *
   * Merged rather than "restore only if empty": the user may have attached something else
   * while the upload was in flight, and dropping the originals on the floor would leak
   * their blob URLs until unmount. The originals go first, since they were picked first.
   */
  const restore = useCallback(
    (taken) => {
      setItems((current) => {
        const seen = new Set(current.map((item) => item.url));
        const merged = [...taken.filter((item) => !seen.has(item.url)), ...current];
        merged.slice(MAX_MEDIA_PER_MESSAGE).forEach((item) => release(item.url));
        return merged.slice(0, MAX_MEDIA_PER_MESSAGE);
      });
    },
    [release]
  );

  /** Empty the tray and release everything — a cancel, not a send. */
  const clear = useCallback(() => {
    items.forEach((item) => release(item.url));
    setItems([]);
  }, [items, release]);

  useEffect(
    () => () => {
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      urlsRef.current.clear();
    },
    []
  );

  return { items, add, removeAt, take, restore, clear, track, release };
};

export default useMediaTray;
