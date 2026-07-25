/**
 * Unified response helpers.
 * All API responses go through here so the shape is always consistent:
 *   success  →  { success: true,  data: … }
 *   failure  →  { success: false, error: { code, message } }
 *
 * Internal error details (stack traces, DB messages) are never forwarded
 * to the client in production.
 */

const isProd = process.env.NODE_ENV === "production";

export const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

export const created = (res, data) => ok(res, data, 201);

export const fail = (res, message, status = 400, code = null) =>
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}) },
  });

export const serverError = (res, err, fallback = "Internal server error") => {
  if (!isProd) console.error(err);
  return res.status(500).json({
    success: false,
    error: { message: fallback },
  });
};
