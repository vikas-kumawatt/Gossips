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

/**
 * Exported because socket.io packets never pass through Express middleware, so
 * the `app.use` below can't reach them. The socket layer runs the same scrub
 * over every inbound packet — without it `{"messageId": {"$gt": null}}` reaches
 * `findById` and returns an arbitrary document.
 */
export const scrub = (value, depth = 0) => {
  if (value === null || typeof value !== "object") return;

  /*
   * Past the limit, arrays are emptied rather than left alone.
   *
   * This used to `return` here, which is the one thing a sanitiser must never do:
   * an object at the limit had its keys deleted, but an *array* at the limit was
   * skipped entirely — so wrapping a payload in nine layers of arrays smuggled its
   * `$`-operators straight through, on HTTP and on every socket packet. The bound
   * still has to exist, because a deeply nested array literal is otherwise a
   * stack-overflow payload, so the branch is discarded instead of trusted.
   *
   * Nothing legitimate in this app nests nine levels deep, so emptying is not a
   * behaviour change for any real request.
   */
  if (depth > MAX_DEPTH) {
    if (Array.isArray(value)) value.length = 0;
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => scrub(entry, depth + 1));
    return;
  }

  for (const key of Object.keys(value)) {
    // Past the depth limit, drop the branch entirely rather than returning
    // early. Bailing out used to leave everything below untouched, so a
    // payload nested one level deeper than the limit smuggled its operators
    // straight through — the guard failed open, which is the one thing a
    // sanitiser must never do.
    if (isSuspiciousKey(key) || depth >= MAX_DEPTH) {
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
