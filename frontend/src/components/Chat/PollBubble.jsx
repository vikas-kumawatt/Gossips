import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { votePercent, formatVotes } from "../../lib/attachments";

/**
 * "Closes in 3 hours" / "Poll closed". Same shape of math as `pollTimeLeft`
 * in lib/attachments, but that helper's wording and its `closesAt` field
 * belong to the feed poll model — this one reads a chat poll's `expiresAt`
 * and needs its own copy.
 */
const formatExpiry = (expiresAt) => {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Poll closed";

  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "Closes in less than a minute";
  if (minutes < 60) return `Closes in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Closes in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `Closes in ${days} day${days === 1 ? "" : "s"}`;
};

/**
 * A signature of the server's vote state, so the resync effect below only
 * fires when the numbers actually changed — not on every parent re-render,
 * which would stomp an optimistic click before the socket round trip lands.
 */
const voteSignature = (poll) =>
  poll?.options?.map((o) => `${o.id}:${o.voteCount}:${o.votedByMe}`).join("|");

/**
 * A poll inside a chat message bubble.
 *
 * Voting is over the socket, not an API call this component makes itself —
 * `onVote(messageId, optionIds)` is handed the full set of options the reader
 * wants selected (the server replaces their votes wholesale), and the click
 * is reflected locally right away rather than waiting on the round trip.
 * When a fresh `message.poll` arrives via props with different vote counts,
 * that's treated as authoritative and overwrites the local guess.
 */
const PollBubble = ({ message, isOwn, onVote }) => {
  const poll = message.poll;
  const [localPoll, setLocalPoll] = useState(poll);

  useEffect(() => {
    setLocalPoll(poll);
    // `poll` itself is intentionally left out of the deps below: it's a new
    // object identity on every parent render, and depending on it directly
    // would overwrite an optimistic just-voted state with the pre-vote copy
    // still sitting in the message list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message._id, poll?.totalVotes, voteSignature(poll)]);

  if (!localPoll || !Array.isArray(localPoll.options) || localPoll.options.length === 0) {
    return <p className="text-[13.5px] italic text-white/40">Poll unavailable</p>;
  }

  const closed = !!localPoll.expiresAt && new Date(localPoll.expiresAt).getTime() <= Date.now();
  const showVoteCount = localPoll.settings?.showVoteCount !== false;
  const total = localPoll.totalVotes ?? 0;
  const expiry = formatExpiry(localPoll.expiresAt);

  const handleSelect = (optionId) => {
    const current = localPoll.options.filter((o) => o.votedByMe).map((o) => o.id);
    const next = localPoll.allowMultipleAnswers
      ? current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
      : [optionId];

    setLocalPoll((prev) => ({
      ...prev,
      totalVotes: (prev.totalVotes ?? 0) + (next.length - current.length),
      options: prev.options.map((o) => {
        const was = o.votedByMe;
        const now = next.includes(o.id);
        if (was === now) return o;
        return { ...o, votedByMe: now, voteCount: Math.max(0, o.voteCount + (now ? 1 : -1)) };
      }),
    }));

    onVote?.(message._id, next);
  };

  return (
    <div
      className={`flex flex-col gap-2 min-w-[220px] max-w-[280px] ${
        closed ? "opacity-60" : ""
      }`}
    >
      {localPoll.question && (
        <p className="text-[14.5px] font-medium text-white break-words">
          {localPoll.question}
        </p>
      )}

      <div
        role="group"
        aria-label={localPoll.question || "Poll options"}
        className="flex flex-col gap-1.5"
      >
        {localPoll.options.map((option) => {
          const percent = votePercent(option.voteCount, total);
          const selected = !!option.votedByMe;

          return (
            <button
              key={option.id}
              type="button"
              disabled={closed}
              aria-pressed={selected}
              onClick={closed ? undefined : () => handleSelect(option.id)}
              className={`relative w-full overflow-hidden rounded-xl border text-left transition-colors ${
                selected ? "border-white" : isOwn ? "border-white/30" : "border-white/15"
              } ${closed ? "cursor-default" : "cursor-pointer hover:border-white/50"}`}
            >
              {/* Fill sits behind the label as a sibling, not a background on
                  it, so the text stays legible at every fill level. */}
              <div
                className={`absolute inset-y-0 left-0 transition-[width] duration-300 ${
                  selected ? (isOwn ? "bg-black/25" : "bg-blue-500/30") : isOwn ? "bg-black/15" : "bg-white/10"
                }`}
                style={{ width: `${percent}%` }}
              />
              <div className="relative flex items-center gap-2 px-3 py-2">
                {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-white">
                  {option.text}
                </span>
                <span className="shrink-0 flex items-center gap-1.5 text-[12px] text-white/70">
                  {showVoteCount && <span className="tabular-nums">{option.voteCount}</span>}
                  <span className="tabular-nums">{percent}%</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[11.5px] text-white/50">
        {formatVotes(total)}
        {localPoll.isAnonymous && " · Anonymous"}
        {expiry && ` · ${expiry}`}
      </p>
    </div>
  );
};

export default PollBubble;
