import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Icons } from "../../components/icons";
import { botAPI } from "../../services/api";
import { agoLabel } from "./botStatus";

/**
 * Everything a bot did, and everything it was stopped from doing.
 *
 * ── Refusals are the point, not the noise ───────────────────────────────────
 *
 * The obvious version of this shows successes and hides the rest, which would throw away the most
 * useful rows in the collection. "Tried to message someone who doesn't follow it — refused" is
 * evidence a guardrail fired, and without it the absence of the message is indistinguishable from the
 * bot never having tried. That distinction is what a prompt-injection post-mortem turns on.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * The model's `reasoning`. `BotActionLog` never stores it: it is text derived from whatever strangers
 * wrote in the bot's feed, and putting a model's paraphrase of hostile input on a page carrying the
 * platform's authority is how an injection gets a second audience. Every reason shown here is the
 * guardrail's own wording.
 */

const ACTION_LABEL = {
  scroll_feed: "Looked at its feed",
  view_profile: "Looked at a profile",
  like_post: "Liked a post",
  comment_post: "Commented on a post",
  repost_post: "Reposted",
  quote_post: "Quoted a post",
  follow_user: "Followed someone",
  send_follow_request: "Asked to follow someone",
  send_dm: "Sent a message",
  reply_dm: "Replied to a message",
  create_post: "Posted",
  do_nothing: "Decided to do nothing",
  cycle_skipped: "Skipped a turn",
  cycle_failed: "A turn failed",
};

const OUTCOME = {
  rejected: { label: "Refused", className: "text-amber-400" },
  failed: { label: "Failed", className: "text-rose-400" },
};

const BotActivityList = ({ botId }) => {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);

  const load = useCallback(async () => {
    try {
      const data = await botAPI.activity(botId, { limit: 50 });
      setRows(data.activity || []);
    } catch {
      toast.error("Couldn't load activity");
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Icons.spinner className="h-6 w-6 animate-spin text-neutral-400" />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <p className="py-8 text-center text-[13px] text-neutral-500">
        Nothing yet. Everything this bot does will be listed here, including anything it was refused.
      </p>
    );
  }

  /*
   * Token counts ride on one row per cycle — repeating them on each action would report a cycle's cost
   * six times over — so summing the column is the correct total rather than an approximation.
   */
  const tokensIn = rows.reduce((total, row) => total + (row.usage?.inputTokens || 0), 0);
  const tokensOut = rows.reduce((total, row) => total + (row.usage?.outputTokens || 0), 0);
  const cycles = new Set(rows.map((row) => row.cycleId).filter(Boolean)).size;

  return (
    <div>
      {(tokensIn > 0 || cycles > 0) && (
        <p className="pb-3 text-[12px] text-neutral-500">
          {cycles} decision{cycles === 1 ? "" : "s"} · {tokensIn.toLocaleString()} tokens in ·{" "}
          {tokensOut.toLocaleString()} out
          {/*
            Tokens, not money. Provider prices change and are per-model, so a currency figure would
            quietly go wrong — and it is the owner's own account being billed, where the real total
            already lives.
          */}
        </p>
      )}

      <div className="flex flex-col">
        {rows.map((row) => {
          const outcome = OUTCOME[row.outcome];
          return (
            <div
              key={row._id}
              className="flex items-start gap-3 border-t border-neutral-800/70 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-neutral-200">
                  {ACTION_LABEL[row.action] || row.action}
                  {outcome && (
                    <span className={`ml-2 text-[12px] ${outcome.className}`}>{outcome.label}</span>
                  )}
                </p>

                {/* The guardrail's wording, never the model's. */}
                {row.reason && (
                  <p className="mt-0.5 text-[13px] leading-relaxed text-neutral-500">{row.reason}</p>
                )}

                {(row.targetKey || row.targetId) && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-600">
                    {/*
                      A conversation carries a derived key rather than a document id, which is why it
                      has its own field — a `reply_dm` row would otherwise arrive with no target at all.
                    */}
                    {row.targetType || "Conversation"} {row.targetKey || row.targetId}
                  </p>
                )}
              </div>

              <span className="shrink-0 pt-0.5 text-[12px] text-neutral-600">
                {agoLabel(row.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default BotActivityList;
