import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Clock } from "lucide-react";
import { toast } from "react-hot-toast";
import { Icons } from "../components/icons";
import SchedulePickerSheet from "../components/SchedulePickerSheet";
import { scheduleAPI } from "../services/api";
import { formatScheduleLabel, formatTimeUntil } from "../lib/schedule";
import { normalizeMedia } from "../lib/mediaTypes";
import AudioPlayer from "../components/AudioPlayer";
import LocationChip from "../components/LocationChip";
import ConfirmDialog from "../components/ui/ConfirmDialog";

/** Stable key across the two collections — ids only collide across types. */
const keyOf = (item) => `${item.type}:${item._id}`;

const ScheduledItem = ({ item, busy, onReschedule, onPublishNow, onCancel }) => {
  const mediaItems = normalizeMedia(item.media);
  const audioItem = mediaItems.find((m) => m.type === "audio");
  const visualItems = mediaItems.filter((m) => m.type !== "audio");
  const failed = item.scheduleStatus === "failed";
  const publishing = item.scheduleStatus === "publishing";

  return (
    <div className="border-b border-neutral-800 px-4 py-4">
      <div className="flex items-center gap-2 text-[13px]">
        {failed ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" />
            <span className="text-rose-400">Couldn't be posted</span>
          </>
        ) : (
          <>
            <Clock className="h-4 w-4 shrink-0 text-neutral-400" />
            <span className="text-neutral-300">{formatScheduleLabel(item.scheduledFor)}</span>
            <span className="text-neutral-500">· {formatTimeUntil(item.scheduledFor)}</span>
          </>
        )}
        <span className="ml-auto rounded-full border border-neutral-700 px-2 py-[1px] text-[11px] text-neutral-400">
          {item.type === "comment" ? "Reply" : "Post"}
        </span>
      </div>

      {failed && item.scheduleError && (
        <p className="mt-2 text-[13px] text-neutral-400">{item.scheduleError}</p>
      )}

      {item.content && (
        <p className="mt-3 whitespace-pre-wrap break-words text-[15px] text-white">
          {item.content}
        </p>
      )}

      {item.location && (
        <div className="mt-2">
          <LocationChip location={item.location} />
        </div>
      )}

      {/* The poll hasn't started — its clock begins when the post goes out —
          so this is a preview of the question, not a live ballot. */}
      {item.poll?.question && (
        <div className="mt-3 rounded-xl border border-neutral-800 p-3">
          <p className="text-[15px] font-medium text-white">{item.poll.question}</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {item.poll.options?.map((option) => (
              <div
                key={option.id || option.text}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[14px] text-neutral-300"
              >
                {option.text}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-neutral-500">Starts counting down once posted</p>
        </div>
      )}

      {mediaItems.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {audioItem && <AudioPlayer item={audioItem} />}
          {visualItems.length > 0 && (
            <div className="flex flex-row gap-2 overflow-x-auto scrollbar-hide">
              {visualItems.map((m) =>
                m.type === "video" ? (
                  <video
                    key={m.url}
                    src={m.url}
                    preload="metadata"
                    className="h-24 w-24 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <img
                    key={m.url}
                    src={m.url}
                    alt=""
                    className="h-24 w-24 shrink-0 rounded-lg object-cover"
                  />
                )
              )}
            </div>
          )}
        </div>
      )}

      {item.isAiGenerated && (
        <span className="mt-3 inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-800/60 px-2 py-[2px] text-[11px] text-neutral-300">
          <Icons.ai className="h-3.5 w-3.5" />
          AI info
        </span>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || publishing}
          onClick={() => onReschedule(item)}
          className="rounded-full border border-neutral-700 px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Reschedule
        </button>
        <button
          type="button"
          disabled={busy || publishing}
          onClick={() => onPublishNow(item)}
          className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Post now
        </button>
        <button
          type="button"
          disabled={busy || publishing}
          onClick={() => onCancel(item)}
          className="ml-auto rounded-full px-4 py-1.5 text-[13px] font-medium text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

/**
 * The list of things waiting to go out. Reachable from the composer menu.
 *
 * Published items drop off the list on their own — the server only returns
 * pending, publishing and failed — so the page re-fetches on a timer to stay
 * honest about what's still queued.
 */
const ScheduledPostsPage = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [picking, setPicking] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const data = await scheduleAPI.list();
      setItems(data?.data?.items || []);
    } catch {
      if (!quiet) toast.error("Couldn't load your scheduled posts");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // The publisher ticks every 30s; match it so an item disappears from the
    // list at roughly the moment it actually goes out.
    const id = setInterval(() => load({ quiet: true }), 30 * 1000);
    return () => clearInterval(id);
  }, [load]);

  const handleReschedule = async (item, date) => {
    setBusyKey(keyOf(item));
    try {
      await scheduleAPI.reschedule(item.type, item._id, date.toISOString());
      toast.success(`Moved to ${formatScheduleLabel(date)}`);
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.error?.message || "Couldn't reschedule");
      await load({ quiet: true });
    } finally {
      setBusyKey(null);
    }
  };

  const handlePublishNow = async (item) => {
    setBusyKey(keyOf(item));
    try {
      await scheduleAPI.publishNow(item.type, item._id);
      toast.success(item.type === "comment" ? "Reply posted" : "Posted");
      setItems((prev) => prev.filter((i) => keyOf(i) !== keyOf(item)));
    } catch (err) {
      toast.error(err.response?.data?.error?.message || "Couldn't post this");
      // Whatever went wrong, the server knows the real state.
      await load({ quiet: true });
    } finally {
      setBusyKey(null);
    }
  };

  const handleCancel = async (item) => {
    setBusyKey(keyOf(item));
    try {
      await scheduleAPI.cancel(item.type, item._id);
      toast.success("Schedule cancelled");
      setItems((prev) => prev.filter((i) => keyOf(i) !== keyOf(item)));
    } catch (err) {
      toast.error(err.response?.data?.error?.message || "Couldn't cancel");
      await load({ quiet: true });
    } finally {
      setBusyKey(null);
      setConfirming(null);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/90 px-4 py-3 backdrop-blur-md">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 transition-colors hover:bg-neutral-800 cursor-pointer"
          aria-label="Go back"
        >
          <Icons.back className="h-5 w-5 text-white" />
        </button>
        <h1 className="font-semibold">Scheduled posts</h1>
      </header>

      <main className="mx-auto max-w-[620px] pb-20">
        {loading ? (
          <div className="flex justify-center py-16">
            <Icons.spinner className="h-8 w-8 animate-spin text-neutral-400" />
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-20 text-center">
            <Clock className="mx-auto mb-3 h-12 w-12 text-neutral-700" />
            <p className="font-medium text-white">Nothing scheduled</p>
            <p className="mt-1 text-sm text-neutral-500">
              Posts and replies you schedule will wait here until it's time.
            </p>
          </div>
        ) : (
          items.map((item) => (
            <ScheduledItem
              key={keyOf(item)}
              item={item}
              busy={busyKey === keyOf(item)}
              onReschedule={setPicking}
              onPublishNow={handlePublishNow}
              onCancel={setConfirming}
            />
          ))
        )}
      </main>

      {picking && (
        <SchedulePickerSheet
          value={picking.scheduledFor}
          kind={picking.type === "comment" ? "Comment" : "Post"}
          onDone={(date) => handleReschedule(picking, date)}
          onClose={() => setPicking(null)}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title="Cancel this schedule?"
          confirmLabel="Discard"
          cancelLabel="Keep it"
          onConfirm={() => handleCancel(confirming)}
          onCancel={() => setConfirming(null)}
        >
          It won't be posted, and the draft will be discarded.
        </ConfirmDialog>
      )}
    </div>
  );
};

export default ScheduledPostsPage;
