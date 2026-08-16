import ApiKey from "../models/ApiKey.js";
import BotPersona from "../models/BotPersona.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import { getIO } from "../config/socket.js";
import { DM_SENT, appEvents } from "../utils/appEvents.js";
import { decryptSecret } from "../utils/keyVault.js";
import { getSettings } from "../utils/settings.js";
import { validateDecision } from "./actionValidator.js";
import { executeActions, logAction } from "./executor.js";
import { loadMemories } from "./memory.js";
import { collectAllowedTargets, shapeActor, shapeMessage } from "./perceptionBudget.js";
import { baseUrlFor, needsEndpoint } from "./providers.js";
import { dmReplyBudget } from "./rateLimits.js";
import { ENDPOINT_SOURCE, assertSafeEndpoint } from "./selfHosted.js";
import { FAILURE_KINDS, replyToConversation } from "./reasoningClient.js";

/**
 * Replying to a direct message, while the person is still looking at the screen.
 *
 * The runner would eventually notice — an unread conversation is part of every perception — but
 * "eventually" is up to twenty minutes, and a reply that arrives twenty minutes later reads as a
 * different thing entirely. So this is the fast path, and the runner is the durable one. Both
 * exist on purpose: if this drops a reply for any reason, the next cycle still sees the message
 * as unread and answers it.
 *
 * That relationship is also what makes it safe for this path to be in-process and best-effort.
 *
 * ── Three behaviours that decide whether it feels like a person ─────────────
 *
 * **Debounce.** People send "hey", "are you there", "I had a question" as three messages in ten
 * seconds. Answering each one produces three replies to one thought — the single most bot-like
 * thing an account can do. A short quiet period per conversation collapses the burst into one
 * answer, and it also collapses three model calls into one.
 *
 * **Serialisation per bot.** Two conversations firing at once would run two cycles against the
 * same key concurrently, doubling the spend spike and racing the DM budget. Replies for a bot go
 * one at a time.
 *
 * **A typing indicator, for as long as the reply would take to type.** Not decoration: an instant
 * reply to a long message is the clearest possible tell. The delay is computed from the length of
 * what was actually written, so it is proportionate rather than a fixed pause.
 */

/**
 * How long to wait for someone to stop typing before answering.
 *
 * Long enough to catch a burst, short enough that a single message still gets a prompt reply.
 * Every further message in the window resets it, so a person mid-thought is never interrupted.
 */
const DEBOUNCE_MS = 4 * 1000;

/**
 * How much of the conversation the model sees.
 *
 * Longer than the cycle's per-conversation cap of five. A cycle is budgeting one tail against
 * eleven other sections; a reply has nothing else to spend tokens on, and the failure mode it
 * prevents — answering a question that was already answered two messages ago — is the one people
 * notice most.
 */
const REPLY_CONTEXT_MESSAGES = 10;

/** Roughly a fast human typist, with floor and ceiling. */
const MS_PER_CHARACTER = 35;
const MIN_TYPING_MS = 1200;
const MAX_TYPING_MS = 7000;

/** conversation key → pending debounce timer. */
const pending = new Map();

/** bot id → the tail of its reply chain, so replies for one bot never overlap. */
const chains = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task` after everything already queued for this bot.
 *
 * A promise chain rather than a queue object: there is nothing to inspect, nothing to cancel, and
 * the map entry is dropped as soon as the chain drains, so an idle bot holds nothing.
 */
const inOrderForBot = (botId, task) => {
  const key = String(botId);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task).catch((error) => {
    console.error("bot reply chain error:", error?.message ?? error);
  });
  chains.set(key, next);
  next.finally(() => {
    // Only clear if nothing else joined behind us.
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
};

const showTyping = (botId, recipientId, isTyping) => {
  try {
    /*
     * Straight to the recipient's room. No privacy or block check, unlike the socket handler:
     * this only runs because that person just messaged this bot, so there is nothing to leak, and
     * a block created in the intervening seconds is caught by `sendDirectMessage` anyway.
     */
    getIO()?.to(String(recipientId)).emit("userTyping", { userId: String(botId), isTyping });
  } catch {
    // No io yet, or a closed server. A missing typing dot is not worth failing a reply over.
  }
};

/**
 * The conversation, as the model sees it.
 *
 * Built from the same shapers as a cycle's perception — including the `untrusted_` labelling on
 * everything the other person wrote — so the injection framing is identical on both paths. A
 * second, looser shape for replies would make the DM surface the soft spot, and the DM surface is
 * the one an attacker can write to directly.
 */
const buildConversation = async (conversationKey, bot, peer) => {
  const messages = await Message.find({
    conversation: conversationKey,
    isDeleted: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .limit(REPLY_CONTEXT_MESSAGES)
    .select("content media createdAt sender")
    .lean();

  if (!messages.length) return null;

  return {
    id: conversationKey,
    with: shapeActor(peer),
    unread: messages.filter((message) => String(message.sender) !== String(bot._id)).length,
    // Oldest first, so the tail reads as a conversation rather than backwards.
    recent: messages.reverse().map((message) => shapeMessage(message, bot._id)),
  };
};

/**
 * Decide and send one reply. Assumes the bot and persona have already been resolved.
 */
const replyOnce = async ({ bot, persona, peer, conversationKey }) => {
  const cycleId = `${persona._id}-dm-${Date.now()}`;

  const record = await ApiKey.findOne({ _id: bot.apiKey, owner: bot.owner })
    .select("+encryptedKey isValid revokedAt provider baseUrl endpointSource")
    .lean();
  if (!record || record.revokedAt || !record.isValid) return;

  let apiKey;
  try {
    apiKey = decryptSecret(record.encryptedKey);
  } catch {
    // The runner reports and pauses on this; a DM is not the place to raise it.
    return;
  }

  /*
   * An owner-supplied endpoint is checked here too.
   *
   * This used to be skipped, on the reasoning that the runner re-checks and would
   * pause the bot on its next cycle, so a resolver call on the reply latency path
   * bought nothing the durable path didn't already provide.
   *
   * That reasoning covers the bot eventually stopping. It does not cover what
   * happens in between: a cycle is up to twenty minutes, this path is triggered
   * by every inbound DM, and each run hands the owner's decrypted API key to
   * whatever the endpoint's hostname resolves to at that instant. So a name that
   * has begun answering with an internal address is used as many times as
   * messages arrive before the runner next looks — and the Python service's own
   * endpoint guard cannot catch it, because that one matches on the literal
   * hostname and never resolves.
   *
   * The cost the old comment weighed is real but small: `dns.lookup` goes through
   * the OS resolver cache, and it sits in front of a model call measured in
   * seconds. Failing quietly here is still this path's normal behaviour — the
   * message stays unread and the runner handles it properly.
   */
  if (needsEndpoint(record.provider) && record.endpointSource === ENDPOINT_SOURCE.OWNER) {
    const checked = await assertSafeEndpoint(baseUrlFor(record), ENDPOINT_SOURCE.OWNER);
    if (!checked.ok) return;
  }

  const conversation = await buildConversation(conversationKey, bot, peer);
  if (!conversation) return;

  /*
   * The allowlist, derived by running the real `collectAllowedTargets` over a perception that
   * happens to contain one conversation. Hand-building `{ conversations: new Map([...]) }` here
   * would be a second derivation of "what was this bot shown" — the exact duplication the Maps
   * refactor existed to remove — and it would be the copy that drifts, because this path is the
   * one with fewer eyes on it.
   */
  const allowedTargets = collectAllowedTargets({ conversations: [conversation] });

  const { self, bySubject } = await loadMemories(bot._id, [String(peer._id)]);
  const summary = bySubject.get(String(peer._id));

  const result = await replyToConversation({
    bot,
    persona,
    conversation,
    memory: { self, about: summary && peer.username ? { [peer.username]: summary } : {} },
    apiKey,
    provider: record.provider,
    // Validated above, immediately before this call, for the same reason the
    // runner validates immediately before its own.
    baseUrl: baseUrlFor(record),
  });

  if (!result.ok) {
    /*
     * A dead key is the runner's business, not this path's — it owns the pause, the owner
     * notification and the `ApiKey` update, and doing any of that from here would race it. The
     * message stays unread, so the next cycle picks it up and handles it properly.
     */
    if (result.kind !== FAILURE_KINDS.KEY_INVALID) {
      console.error(`bot ${bot.username} reply failed: ${result.error}`);
    }
    return;
  }

  const settings = await getSettings();
  const { actions, rejected } = validateDecision(result.decision, {
    allowedTargets,
    extraBlockedTags: settings?.blockedHashtags || [],
    systemPrompt: persona.systemPrompt,
  });

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

  /*
   * Only replies. `/reply` asks for a single `reply_dm`, but a model can return anything the
   * schema allows, and a DM arriving is not licence to go and like six posts — that is what a
   * cycle is for. Filtered rather than rejected: choosing to say nothing is a valid answer.
   */
  const replies = actions.filter((action) => action.type === "reply_dm");
  if (!replies.length) {
    await logAction({
      bot: bot._id,
      owner: bot.owner,
      action: "do_nothing",
      outcome: "executed",
      targetType: "Conversation",
      targetId: conversationKey,
      reason: "chose not to reply",
      cycleId,
    });
    return;
  }

  const [reply] = replies;

  /*
   * The pause happens *after* the text exists, so its length can set the duration. Typing for two
   * seconds and then sending four sentences is its own kind of tell.
   */
  const typingMs = Math.min(MAX_TYPING_MS, Math.max(MIN_TYPING_MS, reply.text.length * MS_PER_CHARACTER));
  showTyping(bot._id, peer._id, true);
  await sleep(typingMs);
  showTyping(bot._id, peer._id, false);

  await executeActions([reply], {
    bot,
    cycleId,
    // One reply. The hourly DM cap was already checked; this stops a stray extra action.
    remainingActions: 1,
    usage: {
      inputTokens: result.decision.usage?.input_tokens ?? 0,
      outputTokens: result.decision.usage?.output_tokens ?? 0,
      model: persona.replyModel,
      latencyMs: result.decision.usage?.latency_ms ?? 0,
    },
  });
};

/**
 * Everything that can rule out a reply, cheapest first.
 *
 * Returns the resolved bot and persona, or null. All of it runs *after* the debounce, so a burst
 * of five messages costs one pass rather than five.
 */
const resolveTarget = async (receiverId, senderId) => {
  const bot = await User.findById(receiverId)
    .select("username name isBot owner apiKey accountStatus")
    .lean();
  // The overwhelmingly common case: an ordinary conversation between two people.
  if (!bot?.isBot || bot.accountStatus !== "active" || !bot.apiKey) return null;

  const sender = await User.findById(senderId).select("username name isBot").lean();
  if (!sender) return null;
  /*
   * No bot-to-bot replies, enforced here as well as in the validator. Without it two bots that
   * message each other would ping-pong forever at the *fast* cadence rather than the slow one —
   * a reply every few seconds, each one costing both owners money, with nobody watching.
   */
  if (sender.isBot) return null;

  const settings = await getSettings();
  if (settings?.maintenanceMode || settings?.botsEnabled === false) return null;
  if (!settings?.directMessagesEnabled) return null;

  const persona = await BotPersona.findOne({ bot: bot._id })
    .select("systemPrompt postingStyle replyModel status")
    .lean();
  if (!persona || persona.status !== "active") return null;

  /*
   * The hourly DM cap, last because it is the only one that costs a query against a growing
   * collection — and because a paused or non-bot account should never have reached it.
   */
  const budget = await dmReplyBudget(bot._id);
  if (!budget.ok) {
    await logAction({
      bot: bot._id,
      owner: bot.owner,
      action: "cycle_skipped",
      outcome: "rejected",
      reason: budget.reason,
    });
    return null;
  }

  return { bot, persona, peer: sender };
};

/**
 * A direct message was delivered. Reply if the recipient is a bot.
 *
 * Exported for the tests; production wires it through `appEvents`.
 */
export const onDirectMessage = (event) => {
  /*
   * `?? {}` rather than a default parameter, because a default only covers `undefined` and an
   * emitter can hand over `null`. Destructuring in the signature threw on exactly that, and the
   * only reason it wasn't visible in production was `announce` swallowing it.
   */
  const { conversation, senderId, receiverId } = event ?? {};
  if (!conversation || !senderId || !receiverId) return;
  // A note to self is not a conversation to answer.
  if (String(senderId) === String(receiverId)) return;

  const key = String(conversation);

  /*
   * Reset rather than ignore. The last message in a burst is the one that should be answered, and
   * restarting the clock is what makes "they're still typing" behave the way a person would.
   */
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(key);

    inOrderForBot(receiverId, async () => {
      const target = await resolveTarget(receiverId, senderId);
      if (!target) return;
      await replyOnce({ ...target, conversationKey: key });
    });
  }, DEBOUNCE_MS);

  /*
   * Unref'd so a pending reply can't hold the process open during a shutdown. The message is
   * already stored and still unread, so the runner will answer it after the restart.
   */
  if (typeof timer.unref === "function") timer.unref();
  pending.set(key, { timer });
};

let subscribed = false;

/**
 * Subscribe to the message stream.
 *
 * Guarded against being called twice, which would produce two replies to every message — the
 * kind of bug that only appears once someone adds a second call site.
 */
export const startDmResponder = () => {
  if (subscribed) return;
  if (process.env.BOTS_ENABLED !== "true") return;

  appEvents.on(DM_SENT, onDirectMessage);
  subscribed = true;
  console.log("Bot DM responder listening");
};

export const stopDmResponder = () => {
  appEvents.off(DM_SENT, onDirectMessage);
  subscribed = false;
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
};
