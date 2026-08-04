import React from "react";
import { guessMediaType } from "../lib/mediaTypes";
import VideoPlayerOverlay from "./Chat/VideoPlayerOverlay";

const MediaModal = ({ selectedImage, closeModal }) => {
  // The lightbox is opened with a bare URL from the media strip, so the type
  // has to be guessed here rather than passed through. The shared guess is at
  // least the same one every other renderer uses.
  const isVideo = (url) => guessMediaType(url) === "video";

  /*
   * Video gets the app's own player.
   *
   * This rendered `<video controls autoPlay>`, so a video opened from the shared-media
   * gallery or a post showed the browser's control strip — including the kebab menu
   * offering Download and Picture-in-Picture on a raw Cloudinary URL. The player has
   * the scrubber, the keyboard handling and the focus management this modal never had.
   */
  if (isVideo(selectedImage)) {
    return <VideoPlayerOverlay src={selectedImage} onClose={closeModal} />;
  }

  return (
    <div
      className="fixed inset-0 z-[200] cursor-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Media preview"
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="absolute inset-0 bg-black bg-opacity-75"
        onClick={(e) => closeModal(e)}
      />

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="relative max-w-screen-xl max-h-screen p-4 pointer-events-auto">
          <button
            onClick={(e) => closeModal(e)}
            className="fixed top-6 left-6 bg-neutral-500 rounded-full p-2 text-black hover:bg-gray-200 transition cursor-pointer z-[201]"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>

          <img
            src={selectedImage}
            alt="Full size image"
            className="max-h-screen max-w-full object-contain"
            onClick={(e) => {
              e.stopPropagation();
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default MediaModal;