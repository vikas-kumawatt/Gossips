import React, { useRef, useState, useEffect } from "react";
import { Icons } from "./icons";

const PostMedia = ({ mediaArray, videoRefs, isMuted, toggleMute, openModal }) => {
  const isSingleMedia = mediaArray.length === 1;
  const scrollContainerRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [dragDistance, setDragDistance] = useState(0);

  const isVideo = (url) => {
    return (
      url &&
      (url.endsWith(".mp4") || url.endsWith(".webm") || url.endsWith(".ogg"))
    );
  };

  const handleMouseDown = (e) => {
    if (isSingleMedia) return;
    setIsDragging(true);
    setStartX(e.pageX - scrollContainerRef.current.offsetLeft);
    setScrollLeft(scrollContainerRef.current.scrollLeft);
    setDragDistance(0);
    scrollContainerRef.current.style.cursor = "grabbing";
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.cursor = "grab";
    }
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const x = e.pageX - scrollContainerRef.current.offsetLeft;
    const walk = (x - startX) * 2;
    setDragDistance(Math.abs(walk));
    scrollContainerRef.current.scrollLeft = scrollLeft - walk;
  };

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      setIsDragging(false);
      if (scrollContainerRef.current) {
        scrollContainerRef.current.style.cursor = "grab";
      }
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, []);

  const handleMediaClick = (e, mediaUrl) => {
    if (dragDistance > 10) {
      return;
    }
    openModal(e, mediaUrl);
  };

  const handleDragStart = (e) => {
    e.preventDefault();
  };

  const renderMediaItem = (mediaUrl, index) => {
    const mediaClasses = isSingleMedia
      ? "w-70 h-full object-cover rounded-md cursor-pointer"
      : "h-64 w-64 object-cover rounded-md";

    if (isVideo(mediaUrl)) {
      return (
        <div
          key={mediaUrl}
          className={`relative ${isSingleMedia ? "w-70" : "flex-shrink-0"}`}
        >
          <video
            ref={(el) => (videoRefs.current[mediaUrl] = el)}
            src={mediaUrl}
            muted={isMuted[mediaUrl] ?? true}
            playsInline
            loop
            className={mediaClasses}
            onClick={(e) => handleMediaClick(e, mediaUrl)}
          />
          <button
            onClick={(e) => toggleMute(e, mediaUrl)}
            className="absolute bottom-2 right-2 bg-neutral-950/70 text-white p-2 rounded-full cursor-pointer"
          >
            {isMuted[mediaUrl] ?? true ? <Icons.muted /> : <Icons.unmuted />}
          </button>
        </div>
      );
    } else {
      return (
        <img
          key={mediaUrl}
          src={mediaUrl}
          alt={`Post media ${index}`}
          className={mediaClasses}
          onClick={(e) => handleMediaClick(e, mediaUrl)}
          draggable="false"
          onDragStart={handleDragStart}
        />
      );
    }
  };

  if (mediaArray.length === 0) return null;

  return (
    <div
      className="mb-3 rounded-md overflow-x-auto scrollbar-hide"
      ref={scrollContainerRef}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      style={{ cursor: isSingleMedia ? "default" : "grab" }}
    >
      <div
        className={`${
          isSingleMedia ? "" : "flex flex-row flex-nowrap space-x-2"
        }  relative`}
      >
        {mediaArray.map((item, index) => renderMediaItem(item, index))}
      </div>
    </div>
  );
};

export default PostMedia;