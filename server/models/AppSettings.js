import { Schema, model } from "mongoose";

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
};

export default model("AppSettings", appSettingsSchema);
