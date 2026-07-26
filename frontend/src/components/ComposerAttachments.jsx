// There's no mic in the local icon set, and adding one just for this would be
// a second style of icon to keep in sync.
import { MapPin, Mic, X } from "lucide-react";
import { Icons } from "./icons";
import GifPicker from "./GifPicker";
import AudioRecorderSheet from "./AudioRecorderSheet";
import PollComposerSheet from "./PollComposerSheet";
import LocationPickerSheet from "./LocationPickerSheet";
import AudioPlayer from "./AudioPlayer";
import { POLL_DURATIONS } from "../lib/attachments";

/**
 * The composer's attachment row and the previews above it.
 *
 * Split out of the three composers — CreatePost, Reply and ReplyComment each
 * carried an identical row of four dead buttons — so GIF, audio, poll and
 * location are wired once. Each composer keeps its own photo picker, which is
 * why `onPickImage` is passed in rather than owned here.
 */

/**
 * One toolbar button. Dimmed with a reason when its slot is taken.
 *
 * The icon is read off `props` rather than destructured because the eslint
 * config has no react plugin, so a destructured component used only in JSX
 * reads as an unused variable. A member expression sidesteps that.
 */
const ToolButton = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    disabled={props.disabled}
    title={props.disabled ? props.disabledHint : props.label}
    aria-label={props.label}
    className={`transition-colors cursor-pointer disabled:cursor-not-allowed ${
      props.disabled
        ? "text-neutral-700"
        : props.active
          ? "text-blue-500"
          : "text-neutral-500 hover:text-blue-500"
    }`}
  >
    <props.icon className="h-5 w-5" />
  </button>
);

export const ComposerToolbar = ({ attachments, onPickImage, mediaCount = 0 }) => {
  const { attachmentKind, location, setOpenSheet } = attachments;

  // A slot is blocked only by a *different* kind of attachment — tapping the
  // one that's already there reopens it for editing.
  const blockedBy = (kind) => attachmentKind && attachmentKind !== kind;
  const hint = "Remove the current attachment first";

  return (
    <>
      <ToolButton
        icon={Icons.image}
        label="Add photos or video"
        onClick={onPickImage}
        disabled={blockedBy("media")}
        disabledHint={hint}
        active={mediaCount > 0}
      />
      <ToolButton
        icon={Icons.gif}
        label="Add a GIF"
        onClick={() => setOpenSheet("gif")}
        disabled={blockedBy("gif")}
        disabledHint={hint}
        active={attachmentKind === "gif"}
      />
      <ToolButton
        icon={Mic}
        label="Add audio"
        onClick={() => setOpenSheet("audio")}
        disabled={blockedBy("audio")}
        disabledHint={hint}
        active={attachmentKind === "audio"}
      />
      <ToolButton
        icon={Icons.poll}
        label="Add a poll"
        onClick={() => setOpenSheet("poll")}
        disabled={blockedBy("poll")}
        disabledHint={hint}
        active={attachmentKind === "poll"}
      />
      <ToolButton
        icon={Icons.location}
        label="Add location"
        onClick={() => setOpenSheet("location")}
        active={Boolean(location)}
      />
    </>
  );
};

/** Previews of whatever is attached, shown above the toolbar. */
export const ComposerPreviews = ({ attachments }) => {
  const { gif, audio, poll, location, setGif, clearAttachment, setPoll, setLocation, setOpenSheet } =
    attachments;

  const durationLabel =
    POLL_DURATIONS.find((d) => d.value === poll?.durationMinutes)?.label || "";

  return (
    <>
      {gif && (
        <div className="relative mt-3 w-fit">
          <img src={gif.url} alt="Selected GIF" className="max-h-56 rounded-xl" />
          <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">
            GIF
          </span>
          <button
            type="button"
            onClick={() => setGif(null)}
            className="absolute right-2 top-2 rounded-full bg-black/80 p-2 text-white cursor-pointer"
            aria-label="Remove GIF"
          >
            <Icons.close className="h-3 w-3" />
          </button>
        </div>
      )}

      {audio && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-800/40 p-2">
          <div className="min-w-0 flex-1">
            <AudioPlayer
              item={{ url: audio.url, duration: audio.duration, waveform: audio.waveform }}
            />
          </div>
          <button
            type="button"
            onClick={clearAttachment}
            className="shrink-0 rounded-full p-2 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white cursor-pointer"
            aria-label="Remove audio"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {poll && (
        <div className="mt-3 rounded-xl border border-neutral-700 bg-neutral-800/40 p-3">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 break-words text-[15px] font-medium text-white">
              {poll.question}
            </p>
            <button
              type="button"
              onClick={() => setOpenSheet("poll")}
              className="shrink-0 text-[13px] font-semibold text-white hover:underline cursor-pointer"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setPoll(null)}
              className="shrink-0 rounded-full p-1 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white cursor-pointer"
              aria-label="Remove poll"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {poll.options.map((option, i) => (
              <div
                key={i}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[14px] text-neutral-300"
              >
                {option}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-neutral-500">Runs for {durationLabel}</p>
        </div>
      )}

      {location && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-800/60 px-3 py-2">
          <MapPin className="h-4 w-4 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-300">
            {location.name}
          </span>
          <button
            type="button"
            onClick={() => setLocation(null)}
            className="shrink-0 rounded-full p-1 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white cursor-pointer"
            aria-label="Remove location"
          >
            <Icons.close className="h-3 w-3" />
          </button>
        </div>
      )}
    </>
  );
};

/** The four sheets. Rendered once per composer, outside its card. */
export const ComposerSheets = ({ attachments }) => {
  const {
    openSheet,
    setOpenSheet,
    chooseGif,
    chooseAudio,
    choosePoll,
    setLocation,
    poll,
    location,
  } = attachments;

  return (
    <>
      {openSheet === "gif" && (
        <GifPicker onSelect={chooseGif} onClose={() => setOpenSheet(null)} />
      )}
      {openSheet === "audio" && (
        <AudioRecorderSheet onDone={chooseAudio} onClose={() => setOpenSheet(null)} />
      )}
      {openSheet === "poll" && (
        <PollComposerSheet
          value={poll}
          onDone={choosePoll}
          onClose={() => setOpenSheet(null)}
        />
      )}
      {openSheet === "location" && (
        <LocationPickerSheet
          value={location}
          onDone={setLocation}
          onClose={() => setOpenSheet(null)}
        />
      )}
    </>
  );
};
