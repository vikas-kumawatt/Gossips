/**
 * Staff gating. Always mounted *after* `protect`, so `req.user` is a live
 * database document — the role is read from it, never from the JWT. A token
 * issued before a demotion therefore stops working immediately.
 */

import { roleOf } from "../utils/roles.js";

const STAFF_ROLES = ["admin", "super_admin"];

const deny = (res) =>
  // Deliberately 404, not 403: an unauthorised caller shouldn't be able to
  // confirm that these routes exist.
  res.status(404).json({ error: "Not found" });

export const requireAdmin = (req, res, next) => {
  if (!req.user || !STAFF_ROLES.includes(roleOf(req.user))) return deny(res);
  if (req.user.accountStatus !== "active") return deny(res);
  return next();
};

export const requireSuperAdmin = (req, res, next) => {
  if (!req.user || roleOf(req.user) !== "super_admin") return deny(res);
  if (req.user.accountStatus !== "active") return deny(res);
  return next();
};
