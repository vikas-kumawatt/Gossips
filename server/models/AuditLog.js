import { Schema, model } from "mongoose";

/**
 * AuditLog — an append-only record of every staff action.
 *
 * Written by `utils/audit.js`, never updated or deleted through the API. The
 * actor's username and the target's label are denormalised so the log still
 * reads correctly after the underlying documents change or are removed.
 */
export const AUDIT_ACTIONS = [
  "user.suspend",
  "user.unsuspend",
  "user.verify",
  "user.unverify",
  "user.role_change",
  "user.force_logout",
  "post.delete",
  "comment.delete",
  "report.status_change",
  "settings.update",
];

const auditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Kept even if the staff account is later renamed or removed.
    actorUsername: { type: String, required: true },
    actorRole: { type: String, required: true },

    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },

    targetType: {
      type: String,
      enum: ["user", "post", "comment", "report", "settings"],
      required: true,
    },
    targetId: { type: Schema.Types.ObjectId, default: null },
    // Human-readable stand-in: @username, a content excerpt, a setting key.
    targetLabel: { type: String, default: "" },

    // Action-specific context: { from, to, reason, durationDays, ... }
    details: { type: Schema.Types.Mixed, default: {} },

    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export default model("AuditLog", auditLogSchema);
