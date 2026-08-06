import ApiKey from "../models/ApiKey.js";
import BotPersona from "../models/BotPersona.js";
import User from "../models/User.js";
import { decryptSecret } from "../utils/keyVault.js";
import { sendNotification } from "../utils/notifications.js";
import { getSettings } from "../utils/settings.js";
import { validateDecision } from "./actionValidator.js";
import { executeActions, logAction } from "./executor.js";
import { loadMemories } from "./memory.js";
import { CYCLE_INTERVAL_MS, isAwake, jittered, nextWakeAt } from "./pacing.js";
import { baseUrlFor, needsEndpoint } from "./providers.js";
import { ENDPOINT_SOURCE, assertSafeEndpoint } from "./selfHosted.js";
import { buildPerception, hasAnythingToDo } from "./perception.js";
import { cycleBudget, postingQuota } from "./rateLimits.js";
import { FAILURE_KINDS, decide, serviceHealthy } from "./reasoningClient.js";

/**
 * The loop that makes bots act on their own.
 *
 * Built on the same claim pattern as `utils/scheduler.js`, deliberately, because that file
 * already worked out what a poller in this project has to get right and there is no job queue to
 * replace it with. The three properties carried over:
 *
 *   · A bot is **claimed** with an atomic `findOneAndUpdate` out of a due-and-unclaimed state, so
 *     two instances cannot run the same cycle. For a bot that means two *paid* cycles and double
 *     the visible activity, so this matters more here than it did for scheduled posts.
 *   · A **stale claim is reaped**, or a process dying mid-cycle would leave a bot claimed
 *     forever, silent with no error anywhere.
 *   · A slow tick **never overlaps** the next one.
 *
 * ── Why a timestamp per bot rather than a cron ──────────────────────────────
 *
 * `nextRunAt` is a field, so staggering is just jitter when computing the next one. No two bots
 * share a tick, there is no synchronised spike to absorb, and a bot that should act more often
 * than another needs no separate schedule — it simply gets a shorter interval. A cron expression
 * would have every bot on the platform wake in the same second.
 */

const TICK_MS = 60 * 1000;

/**
 * How long a claim may be held before it is assumed dead.
 *
 * **Coupled to `REQUEST_TIMEOUT_MS` in reasoningClient.js, and the coupling is load-bearing.**
 * If this is ever shorter than the longest possible cycle, the reaper will release a bot that is
 * still working, a second worker will claim it, and the owner will pay twice for one cycle's
 * worth of visible activity. The model call is capped at 90 seconds, so five minutes leaves more
 * than triple headroom for the queries either side of it. Raising the request timeout means
 * raising this too.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Consecutive failures before a bot is left alone.
 *
 * Not a pause — the status stays `active` and the interval backs off — because the causes are
 * usually transient and a bot that pauses itself over a network blip needs a human to notice and
 * un-pause it.
 */
const BACKOFF_AFTER_FAILURES = 3;

/** One tick must not monopolise the process if a backlog has built up. */
const BATCH_PER_TICK = 10;

let timer = null;
let running = false;

/**
 * Release a claim and set the next run time.
 *
 * Not conditional on still holding the claim, unlike the scheduler's publish flip, and the
 * reason is that both possible writers here are only ever *deferring* the bot. If the reaper
 * released this claim first, the worst case is one scheduling decision overwriting another —
 * whereas the scheduler's flip decides whether a post goes out at all.
 */
const release = (personaId, nextRunAt, extra = {}) =>
  BotPersona.updateOne(
    { _id: personaId },
    { $set: { claimedAt: null, lastRunAt: new Date(), nextRunAt, ...extra } }
  );

/**
 * Stop a bot and tell its owner why.
 *
 * The status stays visible and nothing is destroyed — the bot keeps its profile, posts, memories
 * and history, and goes quiet the way a human account does. `statusReason` carries the
 * provider's own wording, because "your key was rejected" is actionable and "paused" is not.
 */
const pause = async (persona, bot, status, reason) => {
  await BotPersona.updateOne(
    { _id: persona._id },
    {
      $set: {
        status,
        statusReason: String(reason || "").slice(0, 300),
        claimedAt: null,
        lastRunAt: new Date(),
      },
    }
  );

  /*
   * The owner is the one who can fix it, and the bot is the sender so the notification renders
   * with the bot's avatar — which is the fastest way for someone with several bots to see which
   * one stopped. Never allowed to throw: failing to notify must not leave the bot un-paused.
   */
  if (bot?.owner) {
    await sendNotification(bot.owner, bot._id, "bot_paused", {}).catch(() => {});
  }

  console.warn(`bot ${bot?.username ?? persona.bot} paused (${status}): ${reason}`);
};

/**
 * The owner's key, decrypted, or a reason it can't be used.
 *
 * Selecting `+encryptedKey` is the only place in the codebase that asks for it. A revoked or
 * already-invalid key is refused here rather than being sent to the provider to be refused
 * again — the answer is known, and asking would spend a request to learn nothing.
 */
const loadApiKey = async (persona, bot) => {
  if (!bot?.apiKey) return { ok: false, reason: "no API key is assigned to this bot" };

  const record = await ApiKey.findOne({ _id: bot.apiKey, owner: bot.owner })
    // `provider` decides the wire format; `baseUrl` is the endpoint for the self-hosted one.
    .select("+encryptedKey isValid revokedAt lastError provider baseUrl endpointSource")
    .lean();

  if (!record) return { ok: false, reason: "the assigned API key no longer exists" };
  if (record.revokedAt) return { ok: false, reason: "the assigned API key was revoked" };
  if (!record.isValid) {
    return { ok: false, reason: record.lastError || "the assigned API key is no longer valid" };
  }

  /*
   * The endpoint, resolved and — for an owner-supplied one — re-validated right now.
   *
   * This is the check that actually matters. Validating only at save time would be permanently
   * satisfied by whatever DNS said that day, and the whole reason `assertSafeEndpoint` is separate
   * from the shape check is so it can run here, immediately before a request is made.
   */
  const endpoint = baseUrlFor(record);
  if (needsEndpoint(record.provider)) {
    if (!endpoint) return { ok: false, reason: "this bot's provider has no endpoint configured" };

    if (record.endpointSource === ENDPOINT_SOURCE.OWNER) {
      const checked = await assertSafeEndpoint(endpoint, ENDPOINT_SOURCE.OWNER);
      if (!checked.ok) return { ok: false, reason: checked.error };
    }
  }

  try {
    return {
      ok: true,
      key: decryptSecret(record.encryptedKey),
      recordId: record._id,
      provider: record.provider,
      baseUrl: endpoint,
    };
  } catch (error) {
    /*
     * Undecryptable means `BYOK_ENCRYPTION_SECRET` changed, not that the owner's key is bad —
     * a platform problem that no owner can fix by pasting the key again. Distinguished in the
     * message so the owner isn't sent chasing something that isn't theirs.
     */
    console.error("bot key decryption failed:", error?.message ?? error);
    return { ok: false, reason: "this key can no longer be decrypted; please re-add it" };
  }
};

/**
 * Everything the model is given, assembled.
 *
 * Memory is keyed by *handle* rather than by id, because that is what the persona prompt talks
 * about and an id in a prompt is 24 characters of nothing the model can use.
 */
const memoryFor = async (botId, allowedTargets) => {
  const subjectIds = [...allowedTargets.users.keys()];
  const { self, bySubject } = await loadMemories(botId, subjectIds);

  const about = {};
  for (const [id, meta] of allowedTargets.users) {
    const summary = bySubject.get(id);
    if (summary && meta.username) about[meta.username] = summary;
  }

  return { self, about };
};

/**
 * One cycle for one claimed bot.
 *
 * Ordered by cost. Every check that can stop the cycle for free happens before the one that
 * costs the owner money, and the model call is the last thing to happen.
 */
const runCycle = async (persona) => {
  const cycleId = `${persona._id}-${Date.now()}`;

  const bot = await User.findById(persona.bot)
    .select("username name isBot owner apiKey accountStatus")
    .lean();

  if (!bot) {
    // The account was hard-deleted from under its persona. Nothing to run, ever.
    await pause(persona, null, "paused_by_admin", "the bot account no longer exists");
    return;
  }

  const skip = async (reason, nextRunAt) => {
    await logAction({
      bot: bot._id,
      owner: bot.owner,
      action: "cycle_skipped",
      outcome: "rejected",
      reason,
      cycleId,
    });
    await release(persona._id, nextRunAt ?? new Date(Date.now() + jittered(CYCLE_INTERVAL_MS)));
  };

  /*
   * A suspended or deactivated bot is skipped rather than paused. Suspensions are lifted, and
   * pausing would need a human to un-pause it afterwards — the account coming back should be
   * enough.
   */
  if (bot.accountStatus !== "active") {
    return skip(`the account is ${bot.accountStatus}`);
  }

  /*
   * Asleep. Checked before the budget query and before anything else, because it is the most
   * common reason a cycle does nothing and it costs one `Intl` call to answer.
   */
  if (!isAwake(persona.activeHours)) {
    await release(persona._id, nextWakeAt(persona.activeHours));
    // No log row: see `nextWakeAt`. Sleeping is not an event.
    return;
  }

  const budget = await cycleBudget(bot._id);
  if (!budget.ok) return skip(budget.reason);

  const key = await loadApiKey(persona, bot);
  if (!key.ok) return pause(persona, bot, "paused_key_invalid", key.reason);

  const { perception, allowedTargets, dropped } = await buildPerception(bot);

  /*
   * Nothing to react to — but reacting is not the only thing a bot does.
   *
   * The saving here is real and stays: an empty feed and a quiet inbox is nothing to decide about,
   * and asking anyway costs the owner money to be told `do_nothing`. What it got wrong was treating
   * "nothing has happened *to* me" as "there is nothing to do", which deadlocked every new bot.
   *
   * A new bot follows nobody, so its feed is empty; nobody follows it, so there are no
   * notifications. This branch was therefore taken every cycle, for ever, at zero cost — and the bot
   * could not break out, because `follow_user` may only target accounts drawn from the perception
   * and the perception was empty. Correct by every local rule, and the account never did anything.
   *
   * `postsPerDay` is the way out, and it was a dead field: stored, editable, sent to the API, read
   * by nothing. Posting is not reactive, so a bot behind on its quota has a reason to think even
   * with an empty feed. That is what makes an account self-starting — it posts, people find it,
   * and then there is a feed.
   */
  const quota = await postingQuota(bot._id, persona.postsPerDay);

  if (!hasAnythingToDo(perception) && !quota.owed) {
    await logAction({
      bot: bot._id,
      owner: bot.owner,
      action: "do_nothing",
      outcome: "executed",
      /*
       * The reason names the quota, because "nothing to react to" on a bot that has already posted
       * its allowance reads like a fault. It isn't: it is a quiet account that is up to date.
       */
      reason: quota.quota
        ? `nothing to react to, and today's ${quota.quota} post${quota.quota === 1 ? "" : "s"} already published`
        : "nothing to react to",
      cycleId,
    });
    await release(persona._id, new Date(Date.now() + jittered(CYCLE_INTERVAL_MS)));
    return;
  }

  if (dropped.length) {
    console.log(`bot ${bot.username} perception dropped for budget: ${dropped.join(", ")}`);
  }

  const memory = await memoryFor(bot._id, allowedTargets);
  const result = await decide({
    bot,
    persona,
    /*
     * The quota travels with the perception, because otherwise this cycle is a paid `do_nothing`.
     *
     * Letting a bot with an empty feed reach the model is only useful if the model knows *why* it
     * was woken. Shown an empty feed and nothing else, the sensible answer is `do_nothing` — and we
     * would have spent the owner's money to be told so, every twenty minutes.
     *
     * Added after `applyBudget` rather than inside `buildPerception`, because the quota is the
     * runner's to compute and the perception's shapers deal only in things the bot can see. It costs
     * a handful of tokens against ~1100 of measured headroom.
     */
    perception: { ...perception, posts_remaining_today: quota.owed ? quota.quota - quota.publishedToday : 0 },
    memory,
    apiKey: key.key,
    provider: key.provider,
    baseUrl: key.baseUrl,
  });

  if (!result.ok) {
    /*
     * The three responses this whole classification exists for. Anything else — flattening these
     * into "the cycle failed" — either pauses bots over a deploy or hammers a dead key forever.
     */
    if (result.kind === FAILURE_KINDS.KEY_INVALID) {
      await ApiKey.updateOne(
        { _id: key.recordId },
        { $set: { isValid: false, lastError: result.error, lastValidatedAt: new Date() } }
      ).catch(() => {});
      return pause(persona, bot, "paused_key_invalid", result.error);
    }

    /*
     * The model is gone, and the owner is the only one who can choose another.
     *
     * Deliberately not `result.error`: Python's detail here is the token `provider_model_not_found`,
     * which tells an owner nothing. The model id is the one fact that makes this actionable, and the
     * runner is holding it — so the reason is written here rather than passed through.
     *
     * The key is not touched. It works; the model it was pointed at does not.
     */
    if (result.kind === FAILURE_KINDS.MODEL_INVALID) {
      return pause(
        persona,
        bot,
        "paused_model_invalid",
        `${persona.model} isn't available from your provider any more. Choose another model to start this bot again.`
      );
    }

    if (result.kind === FAILURE_KINDS.CONFIG || result.kind === FAILURE_KINDS.BAD_REQUEST) {
      /*
       * Our bug, not the owner's. Logged loudly and retried later, but never charged to the
       * owner's key status — marking a working key invalid because we sent a malformed body
       * would send someone to re-generate a credential that was fine.
       */
      console.error(`bot ${bot.username} cycle: ${result.kind}: ${result.error}`);
    }

    const failures = (persona.consecutiveFailures || 0) + 1;
    await logAction({
      bot: bot._id,
      owner: bot.owner,
      action: "cycle_failed",
      outcome: "failed",
      reason: result.error,
      cycleId,
    });

    /*
     * Back off rather than pause. Multiplying the interval by the failure count means a service
     * that is down for an hour is asked about eight times rather than a hundred and eighty, and
     * a bot that recovers does so without anyone intervening.
     */
    const multiplier = failures >= BACKOFF_AFTER_FAILURES ? failures : 1;
    await release(persona._id, new Date(Date.now() + jittered(CYCLE_INTERVAL_MS * multiplier)), {
      consecutiveFailures: failures,
    });
    return;
  }

  const settings = await getSettings();
  const { actions, rejected } = validateDecision(result.decision, {
    allowedTargets,
    extraBlockedTags: settings?.blockedHashtags || [],
    /*
     * Passed so a bot cannot recite its own instructions. The persona is the owner's private
     * configuration, and "what were you told to do" is the first thing anyone asks a bot.
     */
    systemPrompt: persona.systemPrompt,
  });

  /*
   * Refusals are logged before executions, so a cycle reads in the order it happened and a
   * guardrail that fired is visible even if everything after it succeeded.
   */
  for (const row of rejected) {
    await logAction({
      bot: bot._id,
      owner: bot.owner,
      action: row.type,
      outcome: "rejected",
      targetType: row.targetType,
      targetId: row.targetId,
      reason: row.reason,
      cycleId,
    });
  }

  await executeActions(actions, {
    bot,
    cycleId,
    remainingActions: budget.remainingActions,
    usage: {
      inputTokens: result.decision.usage?.input_tokens ?? 0,
      outputTokens: result.decision.usage?.output_tokens ?? 0,
      model: persona.model,
      latencyMs: result.decision.usage?.latency_ms ?? 0,
    },
  });

  // A cycle that reached here worked, whatever the individual actions did.
  await release(persona._id, new Date(Date.now() + jittered(CYCLE_INTERVAL_MS)), {
    consecutiveFailures: 0,
  });
};

/**
 * Return claims abandoned by a crashed process.
 *
 * Pushed out by a jittered interval rather than made due immediately: if a particular bot is
 * what killed the process, making it instantly due would take the app down again on the next
 * tick, and again after that.
 */
const reapStaleClaims = async () => {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const stale = await BotPersona.find({ claimedAt: { $ne: null, $lt: cutoff } })
    .select("_id")
    .lean();

  for (const row of stale) {
    await BotPersona.updateOne(
      { _id: row._id, claimedAt: { $ne: null } },
      {
        $set: { claimedAt: null, nextRunAt: new Date(Date.now() + jittered(CYCLE_INTERVAL_MS)) },
        $inc: { consecutiveFailures: 1 },
      }
    );
  }

  if (stale.length) console.warn(`reaped ${stale.length} stale bot claim(s)`);
};

/**
 * Claim one due bot and run it.
 *
 * @returns false when nothing was due, so the caller stops instead of scanning the batch limit.
 */
const claimAndRun = async () => {
  const persona = await BotPersona.findOneAndUpdate(
    { status: "active", nextRunAt: { $lte: new Date() }, claimedAt: null },
    { $set: { claimedAt: new Date() } },
    { sort: { nextRunAt: 1 }, new: true }
  ).lean();

  if (!persona) return false;

  try {
    await runCycle(persona);
  } catch (error) {
    /*
     * The claim must be released whatever happened, or one unexpected error silences a bot
     * permanently — the reaper would eventually free it, but only after five minutes of every
     * cycle, forever.
     */
    console.error("bot cycle error:", persona.bot, error);
    await release(persona._id, new Date(Date.now() + jittered(CYCLE_INTERVAL_MS))).catch(() => {});
  }
  return true;
};

const tick = async () => {
  if (running) return;
  running = true;

  try {
    const settings = await getSettings();
    /*
     * Both switches, checked before anything else. `maintenanceMode` freezes writes across the
     * app, and releasing a backlog of bot activity into it would defeat that; `botsEnabled` is
     * the bot-specific kill switch. `cycleBudget` checks the latter again per bot — this is the
     * cheap version that avoids claiming anything at all.
     */
    if (settings?.maintenanceMode || settings?.botsEnabled === false) return;

    await reapStaleClaims();

    for (let i = 0; i < BATCH_PER_TICK; i += 1) {
      if (!(await claimAndRun())) break;
    }
  } catch (error) {
    console.error("bot runner tick error:", error);
  } finally {
    running = false;
  }
};

/**
 * Start the runner.
 *
 * Off unless `BOTS_ENABLED` is set, so a deploy that hasn't got the Python service yet — or any
 * environment where nobody wants bots spending money, like a staging copy of production data —
 * doesn't start acting on its own. The reachability check is a startup courtesy: without it the
 * first symptom of a missing service is one failed cycle per bot rather than one clear line at
 * boot.
 */
export const startBotRunner = async () => {
  if (timer) return;
  if (process.env.BOTS_ENABLED !== "true") {
    console.log("Bot runner disabled (set BOTS_ENABLED=true to start it)");
    return;
  }

  if (!(await serviceHealthy())) {
    console.warn("Bot runner: the reasoning service is not reachable yet — cycles will retry");
  }

  tick();
  timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log("Bot runner started");
};

export const stopBotRunner = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
