import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "react-hot-toast";
import { attachmentAPI } from "../services/api";
import { formatVotes, pollTimeLeft, votePercent } from "../lib/attachments";

/**
 * A poll in the feed.
 *
 * Before you vote you see the options and nothing else — the server withholds
 * the counts entirely, so there's nothing here to peek at in a network tab.
 * After voting, or once it closes, the bars and totals appear.
 *
 * @param {"post"|"comment"} type
 * @param {object} poll  the per-viewer projection from the server
 */
const PollCard = ({ type, id, poll: initial, isAuthor }) => {
  const [poll, setPoll] = useState(initial);
  const [voting, setVoting] = useState(null);
  // Re-render on a timer so the countdown ticks and the poll flips to closed
  // without a reload.
  const [, setNow] = useState(Date.now());

  /*
   * Resync from the parent only when the poll meaningfully changes. `initial`
   * is a fresh object identity on every parent render, so depending on it
   * directly would replace an optimistic just-voted state with the stale
   * pre-vote copy the feed still holds — buttons would reappear after voting.
   */
  useEffect(() => {
    setPoll(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, initial?.hasVoted, initial?.closesAt, initial?.totalVotes]);

  const closed = poll.closed || (poll.closesAt && new Date(poll.closesAt) <= new Date());

  useEffect(() => {
    if (closed) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(timer);
  }, [closed]);

  /**
   * The moment a live poll's clock runs out, the results become visible — but
   * this client was told `votes: null` because at fetch time they were hidden.
   * Pull the real numbers once rather than leaving empty bars on screen.
   */
  useEffect(() => {
    if (!closed || poll.totalVotes !== null || poll.hasVoted) return;
    let cancelled = false;
    attachmentAPI
      .getPoll(type, id)
      .then((data) => {
        if (!cancelled && data?.data?.poll) setPoll(data.data.poll);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [closed, poll.totalVotes, poll.hasVoted, type, id]);

  const reveal = closed || poll.hasVoted;

  const vote = async (optionId, e) => {
    e.stopPropagation();
    e.preventDefault();
    if (poll.hasVoted || closed || voting) return;

    setVoting(optionId);
    try {
      const data = await attachmentAPI.vote(type, id, optionId);
      setPoll(data.data.poll);
    } catch (err) {
      // A 409 carries the true state — another tab got there first.
      const recovered = err.response?.data?.data?.poll;
      if (recovered) setPoll(recovered);
      toast.error(err.response?.data?.error?.message || "Couldn't record your vote");
    } finally {
      setVoting(null);
    }
  };

  const total = poll.totalVotes ?? 0;

  return (
    <div className="mb-3 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      {poll.question && (
        <p className="break-words text-[15px] font-medium text-white">{poll.question}</p>
      )}

      {poll.options.map((option) => {
        const percent = votePercent(option.votes, total);
        const mine = poll.myOptionId === option.id;

        if (!reveal) {
          return (
            <button
              key={option.id}
              type="button"
              disabled={Boolean(voting)}
              onClick={(e) => vote(option.id, e)}
              className="w-full rounded-full border border-neutral-600 px-4 py-2 text-center text-[14px] font-medium text-white transition-colors hover:border-white hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
            >
              {option.text}
            </button>
          );
        }

        return (
          <div key={option.id} className="relative overflow-hidden rounded-lg">
            {/* The bar is a sibling behind the text rather than a background
                on it, so the label stays legible at every fill level. */}
            <div
              className={`absolute inset-y-0 left-0 rounded-lg transition-[width] duration-500 ${
                mine ? "bg-blue-600/40" : "bg-neutral-700/60"
              }`}
              style={{ width: `${percent}%` }}
            />
            <div className="relative flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[14px] text-white">
                {option.text}
              </span>
              {mine && <Check className="h-4 w-4 shrink-0 text-blue-400" />}
              <span className="shrink-0 text-[13px] tabular-nums font-medium text-neutral-300">
                {percent}%
              </span>
            </div>
          </div>
        );
      })}

      <p className="text-[13px] text-neutral-500">
        {reveal && <>{formatVotes(total)} · </>}
        {pollTimeLeft(poll.closesAt)}
        {isAuthor && !reveal && " · You'll see results when someone votes"}
      </p>
    </div>
  );
};

export default PollCard;
