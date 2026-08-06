import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bot, KeyRound, Pause, Play } from "lucide-react";
import { toast } from "react-hot-toast";
import { Icons } from "../../components/icons";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { botAPI } from "../../services/api";
import {
  canPause,
  canResume,
  isIncomplete,
  statusLabel,
  statusTone,
  untilLabel,
} from "./botStatus";

/**
 * The AI accounts someone owns.
 *
 * ── Built like the rest of the app, which it wasn't at first ────────────────
 *
 * The first version of this screen was a panel: its own sidebar, its own layout shell, its own set
 * of `Panel`/`Badge`/`Button` primitives borrowed from `components/admin/`. It worked, and it was
 * wrong — it looked like the staff tools rather than like Gossips, and reaching it took three taps
 * through Settings.
 *
 * So this now follows the same shape as `ScheduledPostsPage`, which is the app's idiom for "a list of
 * your own things": a sticky header with a back arrow, a 620px column, rows divided by a hairline,
 * `toast` for feedback rather than inline banners, and `ConfirmDialog` for anything destructive. A
 * feature that looks like the app is a feature people believe is part of it.
 */

const STATUS_COLOUR = {
  green: "text-emerald-400",
  amber: "text-amber-400",
  red: "text-rose-400",
  neutral: "text-neutral-400",
};

const BotsListPage = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    try {
      const next = await botAPI.listBots();
      setData(next);
    } catch {
      if (!quiet) toast.error("Couldn't load your bots");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (bot, work, done) => {
    setBusyId(bot._id);
    try {
      await work();
      toast.success(done);
      /*
       * Reloaded rather than patched in place. The server may have changed more than was asked —
       * resuming sets the next run time — and a hand-merged copy is how a screen starts disagreeing
       * with the thing it describes.
       */
      await load({ quiet: true });
    } catch (error) {
      // `error` is `{ message }`, not a string — see the envelope note in services/api.js.
      toast.error(error.response?.data?.error?.message || "That didn't work");
      await load({ quiet: true });
    } finally {
      setBusyId(null);
      setConfirming(null);
    }
  };

  const { bots = [], limit = 0, remaining = 0 } = data || {};

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/90 px-4 py-3 backdrop-blur-md">
        <button
          onClick={() => navigate(-1)}
          className="cursor-pointer rounded-full p-2 transition-colors hover:bg-neutral-800"
          aria-label="Go back"
        >
          <Icons.back className="h-5 w-5 text-white" />
        </button>
        <h1 className="font-semibold">AI accounts</h1>

        {/* Keys live one tap away rather than behind a sidebar — they're the prerequisite, not a
            separate area of the product. */}
        <Link
          to="/ai-bots/keys"
          className="ml-auto flex items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] text-neutral-300 transition-colors hover:bg-neutral-800"
        >
          <KeyRound className="h-3.5 w-3.5" />
          Keys
        </Link>
      </header>

      <main className="mx-auto max-w-[620px] pb-20">
        {loading ? (
          <div className="flex justify-center py-16">
            <Icons.spinner className="h-8 w-8 animate-spin text-neutral-400" />
          </div>
        ) : (
          <>
            {bots.length === 0 ? (
              <div className="px-6 py-20 text-center">
                <Bot className="mx-auto mb-3 h-12 w-12 text-neutral-700" />
                <p className="font-medium text-white">No AI accounts yet</p>
                <p className="mx-auto mt-1 max-w-[320px] text-sm leading-relaxed text-neutral-500">
                  {limit === 0
                    ? "New AI accounts are currently disabled on Gossips."
                    : "Add an API key, then create a bot. It runs on your key, posts as itself, and is labelled as AI everywhere."}
                </p>
              </div>
            ) : (
              bots.map((bot) => {
                const status = bot.persona?.status;
                const working = busyId === bot._id;

                return (
                  <div key={bot._id} className="border-b border-neutral-800 px-4 py-4">
                    <div className="flex items-start gap-3">
                      <Link to={`/ai-bots/${bot._id}`} className="shrink-0">
                        <img
                          src={bot.profilePic || "/default-avatar.png"}
                          alt=""
                          className="h-11 w-11 rounded-full bg-neutral-800 object-cover"
                        />
                      </Link>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Link
                            to={`/ai-bots/${bot._id}`}
                            className="truncate font-semibold text-white hover:underline"
                          >
                            {bot.name || bot.username}
                          </Link>
                          <span className="rounded-full border border-neutral-700 px-2 py-[1px] text-[11px] text-neutral-400">
                            AI
                          </span>
                        </div>

                        <p className="mt-0.5 truncate text-[13px] text-neutral-500">
                          @{bot.username}
                        </p>

                        <p
                          className={`mt-2 text-[13px] ${STATUS_COLOUR[statusTone(status)] || STATUS_COLOUR.neutral}`}
                        >
                          {statusLabel(status)}
                          {status === "active" && bot.persona?.nextRunAt && (
                            <span className="text-neutral-500">
                              {" "}
                              · next {untilLabel(bot.persona.nextRunAt)}
                            </span>
                          )}
                        </p>

                        {/* The provider's own wording for a dead key — "your credit balance is too
                            low" is actionable, "paused" is not. */}
                        {status && status !== "active" && bot.persona?.statusReason && (
                          <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                            {bot.persona.statusReason}
                          </p>
                        )}

                        {status === "paused_key_invalid" && (
                          <Link
                            to="/ai-bots/keys"
                            className="mt-1 inline-block text-[13px] text-blue-400 hover:underline"
                          >
                            Fix or reassign its key
                          </Link>
                        )}

                        {isIncomplete(bot) && (
                          <p className="mt-1 text-[13px] text-neutral-500">
                            This account has no bot settings attached, so it never runs.
                          </p>
                        )}

                        <div className="mt-3 flex items-center gap-2">
                          {canPause(status) && (
                            <button
                              type="button"
                              disabled={working}
                              onClick={() =>
                                act(
                                  bot,
                                  () => botAPI.updateBot(bot._id, { status: "paused_by_owner" }),
                                  "Paused"
                                )
                              }
                              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-neutral-800 disabled:opacity-50"
                            >
                              <Pause className="h-3.5 w-3.5" />
                              Pause
                            </button>
                          )}

                          {/* Resume only for a bot its owner paused — the server refuses `active`
                              over any other paused state, so offering it would always fail. */}
                          {canResume(status) && (
                            <button
                              type="button"
                              disabled={working}
                              onClick={() =>
                                act(
                                  bot,
                                  () => botAPI.updateBot(bot._id, { status: "active" }),
                                  "Resumed"
                                )
                              }
                              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-neutral-800 disabled:opacity-50"
                            >
                              <Play className="h-3.5 w-3.5" />
                              Resume
                            </button>
                          )}

                          <Link
                            to={`/ai-bots/${bot._id}`}
                            className="rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] font-medium text-neutral-300 transition-colors hover:bg-neutral-800"
                          >
                            Edit
                          </Link>

                          <button
                            type="button"
                            disabled={working}
                            onClick={() => setConfirming(bot)}
                            className="ml-auto cursor-pointer rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-rose-400 disabled:opacity-50"
                            aria-label={`Delete ${bot.username}`}
                          >
                            <Icons.trash className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            <div className="px-4 py-5">
              <button
                type="button"
                disabled={remaining <= 0}
                onClick={() => navigate("/ai-bots/new")}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <Icons.plus className="h-4 w-4" />
                New AI account
              </button>
              <p className="mt-2 text-center text-[12px] text-neutral-500">
                {limit === 0
                  ? "Disabled on this server"
                  : `${bots.length} of ${limit} used`}
              </p>
            </div>
          </>
        )}
      </main>

      {confirming && (
        <ConfirmDialog
          title={`Delete @${confirming.username}?`}
          confirmLabel="Delete"
          busy={busyId === confirming._id}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            act(confirming, () => botAPI.deleteBot(confirming._id), "Deleted")
          }
        >
          Its settings and memories go. Posts and messages other people can see stay where they are,
          and its activity log is kept.
        </ConfirmDialog>
      )}
    </div>
  );
};

export default BotsListPage;
