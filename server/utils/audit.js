import AuditLog from "../models/AuditLog.js";

/**
 * Record a staff action. Denormalises the actor so the entry stays readable
 * after renames or deletions.
 *
 * Never throws: a failure to write the log must not roll back or 500 an action
 * the admin already performed. Failures are logged loudly instead.
 */
export const recordAudit = async (req, { action, targetType, targetId = null, targetLabel = "", details = {} }) => {
  try {
    await AuditLog.create({
      actor: req.user._id,
      actorUsername: req.user.username,
      actorRole: req.user.role,
      action,
      targetType,
      targetId,
      targetLabel,
      details,
      ip: req.ip || req.headers["x-forwarded-for"] || null,
    });
  } catch (error) {
    console.error("recordAudit failed:", action, error);
  }
};
