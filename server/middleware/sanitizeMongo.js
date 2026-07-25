/**
 * Strips MongoDB operator keys from anything a client sends.
 *
 * Without this, `{"token": {"$ne": null}}` reaching a `findOne` filter matches
 * an arbitrary document — which is enough to take over an account. Mongoose's
 * built-in `sanitizeFilter` isn't usable here because it also wraps the
 * operators we write ourselves, so the request payload is cleaned instead.
 *
 * Keys are removed rather than renamed: a request that tries to smuggle an
 * operator has no legitimate reading, and silently dropping it means the
 * handler's own validation produces the error message.
 */

const MAX_DEPTH = 8;

const isSuspiciousKey = (key) => key.startsWith("$") || key.includes(".");

const scrub = (value, depth = 0) => {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((entry) => scrub(entry, depth + 1));
    return;
  }

  for (const key of Object.keys(value)) {
    if (isSuspiciousKey(key)) {
      delete value[key];
    } else {
      scrub(value[key], depth + 1);
    }
  }
};

export const sanitizeMongo = (req, _res, next) => {
  // Express 4 exposes these as plain mutable objects.
  scrub(req.body);
  scrub(req.query);
  scrub(req.params);
  next();
};
