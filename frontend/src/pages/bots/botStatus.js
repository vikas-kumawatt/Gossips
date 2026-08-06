/**
 * How a bot's status reads to its owner.
 *
 * Shared between the list and the detail view rather than written twice, because the important part
 * is not the wording — it is `canResume`. A paused bot is only resumable by its owner when *they*
 * were the one who paused it: the server refuses `active` over any other paused state with a 409,
 * since restarting a bot whose key still doesn't work would just pause it again on the next cycle.
 *
 * So the button is hidden rather than offered-and-refused. A control that always fails is worse than
 * no control: it teaches an owner that the dashboard doesn't work, when in fact it is telling them
 * something true about their key.
 */

/** Mirrors `BOT_STATUSES` in server/models/BotPersona.js. */
export const STATUS_LABEL = {
  active: "Active",
  paused_by_owner: "Paused",
  paused_key_invalid: "Stopped — key problem",
  paused_model_invalid: "Stopped — model unavailable",
  paused_rate_limited: "Paused — rate limited",
  paused_by_admin: "Paused by Gossips",
};

/** Tone names, not classes — each page maps them to its own colours. */
export const STATUS_TONE = {
  active: "green",
  paused_by_owner: "neutral",
  paused_key_invalid: "red",
  // Amber, not red: nothing is broken and no credential is at risk — a field needs changing.
  paused_model_invalid: "amber",
  paused_rate_limited: "amber",
  paused_by_admin: "amber",
};

export const statusLabel = (status) => STATUS_LABEL[status] || "Not set up";
export const statusTone = (status) => STATUS_TONE[status] || "neutral";

/**
 * Which pauses an owner may lift. See the note above for why this is a shorter list than it looks.
 *
 * `paused_model_invalid` is here and `paused_key_invalid` is not, and the difference is whether the
 * owner has anything to fix in between. A dead key needs a new credential, and the server refuses
 * `active` until the key checks out — so offering the button would teach them the dashboard is
 * broken. A retired model needs a different value in a dropdown they can see, so restarting after
 * changing it is the whole workflow.
 *
 * Resuming *without* changing it will simply pause again on the next cycle, which is why the reason
 * text says what to do first.
 */
export const canResume = (status) =>
  status === "paused_by_owner" || status === "paused_model_invalid";

export const canPause = (status) => status === "active";

/**
 * A bot with no persona row.
 *
 * Shouldn't happen — `createBot` writes both — but a half-finished create or a failed migration
 * would leave one, and the runner ignores it. Worth naming in the UI rather than rendering a card
 * with empty fields, because "not set up" is actionable and a blank row is not.
 */
export const isIncomplete = (bot) => !bot?.persona;

/**
 * "4m ago", for something that already happened.
 *
 * Lives here beside `untilLabel` rather than being imported from the admin panel's `ui.jsx`. This
 * area used to borrow that file's primitives wholesale, which is how it ended up looking like the
 * staff tools instead of like the app — and a shared helper is the thread that pulls the rest of
 * that styling back in.
 */
export const agoLabel = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString();
};

/**
 * "in 4m", for a time that hasn't happened yet.
 *
 * `relativeTime` in components/admin/ui.jsx only counts backwards: it computes
 * `Date.now() - date`, so a timestamp in the future goes negative, lands in the
 * `< 60 seconds` branch and renders as "just now". Every value it was written for —
 * created, suspended, reported — is in the past, so that was never wrong there.
 *
 * `nextRunAt` is the one field in this feature that points forward, and "Next just
 * now" for a bot due in a quarter of an hour is worse than showing nothing: it says
 * the bot is about to act when it is idle, which is the opposite of the truth.
 *
 * Kept here rather than added to the admin file, because it is this area's problem
 * and that file has seven other callers.
 */
export const untilLabel = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  // Overdue, which is normal: the runner ticks once a minute and claims in batches.
  if (seconds <= 30) return "due now";
  if (seconds < 60) return "in under a minute";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;

  // A bot asleep until tomorrow morning. A date reads better than "in 14h".
  return date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
};
