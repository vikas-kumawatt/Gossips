import { useCallback, useMemo, useState } from "react";

/**
 * The GIF / audio / poll / location state shared by all three composers.
 *
 * The three composers each keep their own `mediaFiles` — that code already
 * existed and works — so this hook takes the current count as an argument
 * rather than owning it. Everything genuinely new lives here, once.
 *
 * Only one attachment at a time, matching the server rule in
 * utils/attachments.js: photos, or a GIF, or audio, or a poll. Picking a new
 * one clears the last, which is friendlier than greying three buttons out and
 * making people guess why.
 */
export const useComposerAttachments = ({ mediaCount = 0, clearMedia } = {}) => {
  const [gif, setGif] = useState(null);
  const [audio, setAudio] = useState(null); // { blob, url, duration, waveform }
  const [poll, setPoll] = useState(null);
  const [location, setLocation] = useState(null);
  const [openSheet, setOpenSheet] = useState(null); // gif | audio | poll | location

  /** Releases the object URL behind a recorded clip. */
  const dropAudio = useCallback(() => {
    setAudio((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

  /** Clears whatever occupies the single attachment slot. */
  const clearAttachment = useCallback(() => {
    setGif(null);
    setPoll(null);
    dropAudio();
    clearMedia?.();
  }, [dropAudio, clearMedia]);

  const chooseGif = useCallback(
    (value) => {
      clearAttachment();
      setGif(value);
    },
    [clearAttachment]
  );

  const chooseAudio = useCallback(
    (value) => {
      clearAttachment();
      setAudio(value);
    },
    [clearAttachment]
  );

  const choosePoll = useCallback(
    (value) => {
      clearAttachment();
      setPoll(value);
    },
    [clearAttachment]
  );

  /** Which slot is taken, if any. Location isn't a slot — it can always be added. */
  const attachmentKind = useMemo(() => {
    if (poll) return "poll";
    if (audio) return "audio";
    if (gif) return "gif";
    if (mediaCount > 0) return "media";
    return null;
  }, [poll, audio, gif, mediaCount]);

  /** True when the composer has something to post beyond text. */
  const hasAttachment = attachmentKind !== null || Boolean(location);

  /**
   * Adds the attachment fields to a FormData the caller has already filled
   * with content, audience and so on. Kept here so the three composers can't
   * drift on field names.
   */
  const appendTo = useCallback(
    (formData) => {
      if (gif) formData.append("gif", JSON.stringify(gif));
      if (poll) formData.append("poll", JSON.stringify(poll));
      if (location) formData.append("location", JSON.stringify(location));
      if (audio) {
        // Same field name as photos and video — the server types it from the
        // mimetype, so audio doesn't need a channel of its own.
        const extension = (audio.blob.type.split("/")[1] || "webm").split(";")[0];
        formData.append("media", audio.blob, `audio.${extension}`);
        if (audio.waveform?.length) formData.append("waveform", JSON.stringify(audio.waveform));
      }
    },
    [gif, poll, location, audio]
  );

  const reset = useCallback(() => {
    setGif(null);
    setPoll(null);
    setLocation(null);
    dropAudio();
    setOpenSheet(null);
  }, [dropAudio]);

  return {
    gif,
    audio,
    poll,
    location,
    attachmentKind,
    hasAttachment,
    openSheet,
    setOpenSheet,
    chooseGif,
    chooseAudio,
    choosePoll,
    setLocation,
    setGif,
    setPoll,
    dropAudio,
    clearAttachment,
    appendTo,
    reset,
  };
};

export default useComposerAttachments;
