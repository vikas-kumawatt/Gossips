import React, { useCallback, useRef, useState } from "react";
import VideoPlayerOverlay from "./VideoPlayerOverlay";

/*
 * Chat video: a silent thumbnail in the thread, a purpose-built player over it.
 *
 * The bubble used to be a bare `<video controls>`. That put the browser's own
 * control strip inside the bubble — a play button, a scrubber, a volume slider and
 * a "more options" kebab offering Download and Picture-in-Picture — all of it
 * rendered at whatever size the UA felt like, overlapping the 260px bubble, and
 * styled nothing like the rest of the app. Chrome's kebab in particular exposes
 * "Download" on a Cloudinary URL, which is a different (and unauthenticated) path
 * to media than the one the app offers.
 *
 * So: no `controls` on the bubble. Tapping opens a full-screen player whose chrome
 * we own — see Chat/VideoPlayerOverlay. The centre play button is what marks the
 * bubble as a video; a corner badge said the same thing twice.
 */

const IMAGE_URL = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;

/**
 * A `poster` only when there is a real image to use.
 *
 * The upload handler now stores a generated Cloudinary still for videos, so new
 * messages arrive with a genuine .jpg here. This guard is what makes the change
 * safe for everything already in the database: those messages were stored when
 * `thumbnail` fell back to `secure_url`, so their `thumbnail` is the .mp4 itself.
 * Handing that to `poster` is worse than handing it nothing — the browser commits
 * to a poster, fails to decode it as an image, and paints an empty box rather than
 * falling back to the first frame.
 *
 * A poster URL that 404s is fine, by contrast: the spec falls back to the first
 * frame on a failed *download*. It's the 200-that-isn't-an-image that breaks. So
 * this only has to reject non-images, not verify they load.
 *
 * With no poster, `preload="metadata"` paints frame one — the same trick, and the
 * same reasoning, as the video tile in SharedPostCard.
 */
const posterFor = (item) => {
  const thumb = item?.thumbnail;
  if (!thumb || thumb === item?.url) return undefined;
  return IMAGE_URL.test(thumb) ? thumb : undefined;
};

const ChatVideoBubble = ({ item, cornerClass = "rounded-[18px]" }) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef(null);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    // Focus returns to the bubble that opened the player, so a keyboard user
    // doesn't land back at the top of the thread.
    triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={item.caption ? `Play video: ${item.caption}` : "Play video"}
        className="relative block w-fit"
      >
        {/*
          `preload="metadata"` is what paints the first frame, which is the whole
          reason there is usually no `poster` here (see posterFor above) — with
          `preload="none"` the bubble is an empty black box. `muted` matters even
          though nothing is playing: iOS will not render a frame for an unmuted
          video it hasn't been told it may load.

          `min-w`/`min-h` because a `<video>` with no metadata yet and `w-auto` has
          no intrinsic size to lay out, so the bubble would collapse to nothing
          before the first byte arrives and the play button would have no box to
          sit in.
        */}
        <video
          src={item.url}
          poster={posterFor(item)}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          width={item.dimensions?.width || undefined}
          height={item.dimensions?.height || undefined}
          className={`block max-w-[260px] max-h-[340px] min-w-[160px] min-h-[120px] w-auto h-auto bg-black/40 pointer-events-none ${cornerClass}`}
        >
          Your browser does not support video.
        </video>

        {/*
          The play button is the only marker. There was a camcorder badge in the
          corner as well, which said the same thing a second time on a 260px bubble
          and covered part of the frame it was describing.
        */}
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
        >
          <span className="w-12 h-12 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-6 h-6 text-white translate-x-[1px]"
            >
              <path d="M6.5 4.98c0-1.37 1.5-2.17 2.67-1.43l10.6 7.02c1.1.73 1.1 2.33 0 3.06L9.17 20.45C7.99 21.19 6.5 20.39 6.5 19V4.98z" />
            </svg>
          </span>
        </span>
      </button>

      {isOpen && (
        <VideoPlayerOverlay
          src={item.url}
          poster={posterFor(item)}
          onClose={handleClose}
        />
      )}
    </>
  );
};

export default ChatVideoBubble;
