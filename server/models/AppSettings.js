import { Schema, model } from "mongoose";
import { ENDPOINT_SOURCE, checkEndpointShape } from "../bots/selfHosted.js";

/**
 * AppSettings — a single document holding runtime feature flags.
 *
 * Read through `getSettings()` in utils/settings.js, which caches in memory and
 * invalidates on write, so the hot request paths that check these flags don't
 * hit the database each time.
 */
const appSettingsSchema = new Schema(
  {
    // Enforced as a singleton by this fixed key.
    key: { type: String, default: "global", unique: true, immutable: true },

    // ── Access ──────────────────────────────────────────────────────────────
    // Blocks everything except auth + the admin panel, so staff can still work.
    maintenanceMode: { type: Boolean, default: false },
    maintenanceMessage: {
      type: String,
      default: "Gossips is down for maintenance. We'll be back shortly.",
      maxlength: 300,
    },
    registrationsOpen: { type: Boolean, default: true },

    // ── Content ─────────────────────────────────────────────────────────────
    postingEnabled: { type: Boolean, default: true },
    commentingEnabled: { type: Boolean, default: true },
    mediaUploadsEnabled: { type: Boolean, default: true },
    directMessagesEnabled: { type: Boolean, default: true },
    maxPostLength: { type: Number, default: 500, min: 1, max: 500 },
    maxCommentLength: { type: Number, default: 500, min: 1, max: 500 },

    // ── Moderation ──────────────────────────────────────────────────────────
    // Reports on one target beyond this are surfaced as urgent in the queue.
    autoFlagReportThreshold: { type: Number, default: 5, min: 1, max: 100 },
    // Accounts younger than this can't post — a blunt spam brake.
    minAccountAgeHoursToPost: { type: Number, default: 0, min: 0, max: 168 },

    /*
     * How many AI bot accounts one person may own.
     *
     * An operator lever rather than a constant, because the right number is a policy
     * judgement that changes with how the feature is being used — and because the reason to
     * cap it at all is partly abuse (a single owner farming engagement across twenty
     * personas) and partly cost, neither of which is fixed.
     *
     * `0` is meaningful: it stops new bots being created without touching the ones that
     * exist, which is the lever to reach for if bot behaviour ever needs pausing at the
     * platform level while an issue is investigated.
     */
    maxBotsPerOwner: { type: Number, default: 5, min: 0, max: 50 },

    /*
     * The kill switch for AI bot activity.
     *
     * Distinct from `maxBotsPerOwner: 0`, which only stops new bots being created. This stops
     * every existing bot mid-flight: the runner checks it before spending anything, so no
     * inference call is made and no action is taken while it is off. Nothing is destroyed —
     * bots keep their profiles, posts and history, and resume where they left off.
     *
     * The lever to reach for if bot behaviour is ever the thing causing an incident, and the
     * reason it lives here rather than in an env var is that an env var needs a deploy.
     */
    botsEnabled: { type: Boolean, default: true },

    /*
     * Per-bot activity ceilings. See bots/rateLimits.js for what each one protects and why
     * the defaults are what they are.
     *
     * `0` is meaningful for each: it freezes that one surface without touching the others, so
     * DM replies can be stopped while likes and posts carry on.
     */
    botMaxDecisionsPerHour: { type: Number, default: 6, min: 0, max: 60 },
    botMaxActionsPerDay: { type: Number, default: 60, min: 0, max: 500 },
    botMaxDmRepliesPerHour: { type: Number, default: 10, min: 0, max: 100 },

    /*
     * Self-hosted inference endpoints the operator runs and offers to owners.
     *
     * These are safe *because* they come from here. A URL in this list was chosen by whoever
     * administers the platform, on a network they already control, so a private address is the
     * expected value rather than an attack — `http://127.0.0.1:11434` is the point of the feature.
     * See the note on `ENDPOINT_SOURCE` in bots/selfHosted.js for why the source, not the address, is
     * what decides the rules.
     *
     * Empty by default: a deployment with no local model has nothing to offer.
     */
    botSelfHostedEndpoints: { type: [String], default: [] },

    /*
     * Whether an owner may supply their *own* endpoint URL.
     *
     * Off by default, and deliberately harder to turn on than anything else in this file, because it
     * is the only setting that lets a request body influence which host this server connects to. When
     * enabled, an owner's URL must be https, must carry no credentials, and must resolve exclusively
     * to public addresses — re-checked before every call, not only on save.
     *
     * Most deployments should leave this alone. The useful case is covered by the list above.
     */
    botAllowCustomEndpoints: { type: Boolean, default: false },

    /*
     * Extra usernames nobody may register, on top of the built-in list in
     * utils/reservedUsernames.js. Lives here so a name can be held back the
     * day it becomes a problem — a copycat brand, a campaign handle — without
     * waiting for a deploy. The built-ins stay in code because they're tied to
     * routes and shouldn't be removable by accident.
     */
    reservedUsernames: { type: [String], default: [] },

    /*
     * Hashtags the app won't index or link, on top of the built-in list in
     * utils/blockedHashtags.js. A blocked tag doesn't block the post — it just
     * stops being a route to more of the same.
     */
    blockedHashtags: { type: [String], default: [] },

    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const SETTINGS_KEY = "global";

// Editable through the admin panel. Anything outside this list is ignored, so
// a crafted request can't write `key`, `updatedBy` or unknown fields.
export const EDITABLE_SETTINGS = {
  maintenanceMode: "boolean",
  maintenanceMessage: "string",
  registrationsOpen: "boolean",
  postingEnabled: "boolean",
  commentingEnabled: "boolean",
  mediaUploadsEnabled: "boolean",
  directMessagesEnabled: "boolean",
  maxPostLength: "number",
  maxCommentLength: "number",
  autoFlagReportThreshold: "number",
  minAccountAgeHoursToPost: "number",
  maxBotsPerOwner: "number",
  botsEnabled: "boolean",
  botMaxDecisionsPerHour: "number",
  botMaxActionsPerDay: "number",
  botMaxDmRepliesPerHour: "number",
  botSelfHostedEndpoints: "endpointList",
  botAllowCustomEndpoints: "boolean",
  reservedUsernames: "usernameList",
  blockedHashtags: "tagList",
};

/**
 * Normalises the operator's self-hosted endpoint list.
 *
 * Each entry goes through the same validator an owner's URL would, on the `operator` path — so a
 * typo, a `file://`, or an encoded address is refused here rather than at call time. Private
 * addresses are *allowed*, which is the whole distinction: this list is the operator naming machines
 * on their own network.
 *
 * Returning `null` for a non-array matches the other normalisers, and means the admin controller
 * leaves the stored value alone rather than writing an empty list over it.
 */
export const normalizeSelfHostedEndpoints = (value) => {
  if (!Array.isArray(value)) return null;

  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const checked = checkEndpointShape(entry, ENDPOINT_SOURCE.OPERATOR);
    // Silently dropping a bad entry beats writing one that fails on every cycle.
    if (checked.ok) seen.add(checked.url);
  }
  // A handful is realistic; the cap stops one paste becoming a list every key lookup has to walk.
  return [...seen].sort().slice(0, 20);
};

/**
 * Normalises an admin-supplied hashtag list. Same shape as the reserved
 * usernames one, different character rules: a tag may be a single character
 * and may be up to 100 long.
 */
export const normalizeBlockedHashtags = (value) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().replace(/^#/, "").toLowerCase();
    // Must be a shape the parser could actually produce, or blocking it is a
    // no-op that looks like it worked.
    if (!/^[a-z0-9_]{1,100}$/.test(tag) || /^\d+$/.test(tag)) continue;
    seen.add(tag);
  }
  return [...seen].sort().slice(0, 2000);
};

/**
 * Normalises the admin-supplied reserved list: lowercased, deduped, and
 * restricted to things that could actually be a username in the first place.
 * Anything that can't be registered doesn't need reserving, and letting junk
 * in would just make the list unreadable.
 */
export const normalizeReservedUsernames = (value) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim().toLowerCase();
    // Must be a shape User.username could actually take, or reserving it is
    // a no-op that looks like it worked.
    if (!/^[a-z0-9_]{3,30}$/.test(name)) continue;
    seen.add(name);
  }
  // Capped so one paste can't turn the settings document into a payload that
  // every availability check then has to walk.
  return [...seen].sort().slice(0, 500);
};

export default model("AppSettings", appSettingsSchema);
