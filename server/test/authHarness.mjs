import { mock } from "node:test";
import mongoose from "mongoose";

/**
 * Runs the real auth handlers against in-memory everything.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The auth suites here used to be `simulate*` helpers defined inside each test
 * file: a local re-implementation of a branch, asserted against itself. None of
 * them imported `authController`, so none of them could fail when the
 * controller changed. On paths whose failure mode is a silent takeover or a
 * bypassed lockout, a suite that cannot fail is what makes the failure
 * silent — it converts "untested" into "believed tested".
 *
 * So the handlers under test are the shipped ones. Everything they touch that
 * is not logic — Mongo, bcrypt, SMTP, Firebase — is mocked here, which also
 * keeps the suites hermetic, fast, and off the native bcrypt binding.
 *
 * ── Using it ────────────────────────────────────────────────────────────────
 *
 *   import { loadAuth, db, resetDb, makeRes, makeReq, mailedCode } from "./authHarness.mjs";
 *
 *   let auth;
 *   before(async () => { auth = await loadAuth(); });
 *   beforeEach(resetDb);
 *
 * `loadAuth()` must run before anything imports the controller, because the
 * mocks have to be registered first — hence the dynamic import inside it.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 *
 * **A test file must not statically import any module that touches a model.**
 * Static imports are hoisted and run before `before()`, so such a module binds
 * the *real* `User`/`UserSession` and every call from it reaches for an actual
 * Mongo and hangs until mongoose's 10s buffering timeout, surfacing as a 500
 * from a handler that is in fact fine. Pull those in with `await import(...)`
 * inside `before()`, after `loadAuth()`:
 *
 *   let TRUSTED_DEVICE_DURATION_MS;
 *   before(async () => {
 *     auth = await loadAuth();
 *     ({ TRUSTED_DEVICE_DURATION_MS } = await import("../utils/trustedDevices.js"));
 *   });
 *
 * Pure modules — `utils/otp.js`, `utils/twoFactor.js`, `config/jwt.js` — import
 * nothing but node builtins and are safe at the top of the file.
 */

export const oid = () => new mongoose.Types.ObjectId();

/**
 * The fake database, plus a log of every write.
 *
 * `writes` is what lets a test assert something did *not* happen, which is
 * usually the interesting assertion on these paths.
 */
export const db = {
  users: [],
  pending: [],
  sessions: [],
  revokedTokens: [],
  writes: [],
  mail: [],
};

export const resetDb = () => {
  db.users = [];
  db.pending = [];
  db.sessions = [];
  db.revokedTokens = [];
  db.writes = [];
  db.mail = [];
};

/**
 * Enough of Mongo's filter language for the queries these handlers issue.
 *
 * `$ne` matters especially: `HUMAN_ACCOUNT` is `{ isBot: { $ne: true } }` and
 * not `{ isBot: false }`, because rows predating the field have no `isBot` at
 * all. A matcher that only did equality would fail every lookup and make the
 * suites pass for the wrong reason.
 */
export const matches = (row, filter) =>
  Object.entries(filter).every(([key, value]) => {
    /*
     * A dotted key against an array of subdocuments, as the backup-code write
     * uses: `{ "twoFactorBackupCodes.codeHash": <hash> }` matches the row when
     * any element carries that hash. Paired with the positional `$` handling in
     * `applyUpdate`.
     */
    if (key.includes(".")) {
      const [field, sub] = key.split(".");
      const array = row[field];
      return Array.isArray(array) && array.some((element) => element?.[sub] === value);
    }
    if (key === "_id" || key === "user") {
      if (value && typeof value === "object" && !(value instanceof Date) && "$in" in value) {
        return value.$in.some((candidate) => String(candidate) === String(row[key]));
      }
      return String(row[key]) === String(value);
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$exists" in value) return (row[key] !== undefined && row[key] !== null) === value.$exists;
      if ("$ne" in value) return row[key] !== value.$ne;
      if ("$gt" in value) return row[key] != null && row[key] > value.$gt;
      if ("$gte" in value) return row[key] != null && row[key] >= value.$gte;
      if ("$lt" in value) return row[key] != null && row[key] < value.$lt;
      if ("$lte" in value) return row[key] != null && row[key] <= value.$lte;
      if ("$in" in value) return value.$in.includes(row[key]);
    }
    return row[key] === value;
  });

/*
 * Reads hand back a copy, the way Mongoose hands back a separate document.
 *
 * Returning the stored object itself aliases reader and writer, and that
 * quietly breaks the read-modify-write patterns these handlers use. `reissueOtp`
 * is the sharp case: it reads the row, updates it, and on a mail failure rolls
 * back to the values it read. With a live reference the "previous" values have
 * already been overwritten, so the rollback restores the new values over
 * themselves — the fake makes a correct controller look broken, which is as bad
 * as the reverse.
 *
 * Shallow is right: nested arrays stay shared, so a positional update through
 * `updateOne` is still visible to a test holding the row it pushed in.
 */
const copy = (value) =>
  Array.isArray(value) ? value.map((row) => (row && typeof row === "object" ? { ...row } : row))
  : value && typeof value === "object" ? { ...value }
  : value;

/** Mongoose's chainable query, enough of it to be awaited or `.lean()`ed. */
const makeQuery = (result) => {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return query;
};

const applyUpdate = (row, update, filter = {}) => {
  for (const [key, value] of Object.entries(update.$set || {})) {
    /*
     * The positional operator: `{ "twoFactorBackupCodes.$.used": true }` sets
     * the field on whichever element the *filter* matched. Assigning the dotted
     * string as a literal key instead would leave the real array untouched, so
     * a test asserting a backup code was consumed would fail against a
     * controller that consumes it correctly.
     */
    if (key.includes(".$.")) {
      const [field, , sub] = key.split(".");
      const array = row[field];
      if (!Array.isArray(array)) continue;
      const selector = Object.entries(filter).find(([k]) => k.startsWith(`${field}.`) && !k.includes(".$."));
      const element = selector
        ? array.find((candidate) => candidate?.[selector[0].split(".")[1]] === selector[1])
        : array[0];
      if (element) element[sub] = value;
      continue;
    }
    row[key] = value;
  }
  for (const [key, delta] of Object.entries(update.$inc || {})) {
    row[key] = (row[key] || 0) + delta;
  }
};

/**
 * Schema defaults the handlers rely on.
 *
 * `PendingSignup.attempts` is the one that bites: the controller never passes it
 * to `create`, because the schema defaults it to 0 — and `claimAttempt` filters
 * on `attempts: { $lt: OTP_MAX_ATTEMPTS }`, which an undefined field does not
 * satisfy. Without these, every first verification answered "too many incorrect
 * codes" and the suite blamed the controller.
 */
const SCHEMA_DEFAULTS = {
  PendingSignup: () => ({ attempts: 0, resendCount: 0, lastSentAt: new Date() }),
  UserSession: () => ({
    isCurrent: true,
    isTrusted: false,
    trustedAt: null,
    trustedUntil: null,
    revokedAt: null,
    lastActiveAt: new Date(),
    previousRefreshTokenHash: null,
    rotatedAt: null,
  }),
  User: () => ({
    failedLoginAttempts: 0,
    lockoutUntil: null,
    twoFactorEnabled: false,
    twoFactorBackupCodes: [],
    accountStatus: "active",
    isBot: false,
  }),
};

/**
 * Give a returned copy the document behaviour those handlers use.
 *
 * `forgotPassword` and `resetPassword` are the only auth handlers that mutate a
 * mongoose *document* and call `save()` rather than issuing an `updateOne`, so
 * without this they threw a TypeError and every test blamed the controller.
 *
 * `save()` merges the copy back over the stored row, and reproduces the one
 * pre-save hook that matters here: `User` hashes a password that has been
 * changed. Leaving that out would let `resetPassword` appear to store a
 * plaintext password, which is exactly the kind of thing this suite is for.
 */
const asDocument = (name, rows, document) => {
  if (!document || typeof document !== "object") return document;
  Object.defineProperty(document, "save", {
    enumerable: false,
    value: async () => {
      if (name === "User" && typeof document.password === "string" && !document.password.startsWith("hashed:")) {
        document.password = `hashed:${document.password}`;
      }
      db.writes.push({ model: name, save: true, _id: document._id });
      const stored = rows().find((row) => String(row._id) === String(document._id));
      if (stored) Object.assign(stored, document);
      else rows().push({ ...document });
      return document;
    },
  });
  return document;
};

/** A model backed by one array in `db`, recording every write. */
const makeModel = (name, rows) => ({
  find: (filter = {}) =>
    makeQuery(copy(rows().filter((row) => matches(row, filter))).map((d) => asDocument(name, rows, d))),
  findOne: (filter = {}) =>
    makeQuery(asDocument(name, rows, copy(rows().find((row) => matches(row, filter)) ?? null))),
  findById: (id) =>
    makeQuery(asDocument(name, rows, copy(rows().find((row) => String(row._id) === String(id)) ?? null))),
  countDocuments: async (filter = {}) => rows().filter((row) => matches(row, filter)).length,
  exists: async (filter = {}) => rows().some((row) => matches(row, filter)),

  create: async (doc) => {
    db.writes.push({ model: name, create: doc });
    const row = { ...(SCHEMA_DEFAULTS[name]?.() ?? {}), _id: doc._id ?? oid(), ...doc };
    rows().push(row);
    return row;
  },
  updateOne: async (filter, update) => {
    db.writes.push({ model: name, filter, update });
    const row = rows().find((candidate) => matches(candidate, filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(row, update, filter);
    return { matchedCount: 1, modifiedCount: 1 };
  },
  updateMany: async (filter, update) => {
    db.writes.push({ model: name, filter, update, many: true });
    const hits = rows().filter((row) => matches(row, filter));
    hits.forEach((row) => applyUpdate(row, update, filter));
    return { matchedCount: hits.length, modifiedCount: hits.length };
  },
  findOneAndUpdate: async (filter, update, options = {}) => {
    db.writes.push({ model: name, filter, update });
    const row = rows().find((candidate) => matches(candidate, filter));
    if (!row) {
      if (!options.upsert) return null;
      const created = { _id: oid(), ...filter, ...(update.$set || {}) };
      rows().push(created);
      return copy(created);
    }
    applyUpdate(row, update, filter);
    return copy(row);
  },
  findOneAndDelete: async (filter) => {
    const index = rows().findIndex((row) => matches(row, filter));
    if (index === -1) return null;
    db.writes.push({ model: name, filter, deleted: true });
    return copy(rows().splice(index, 1)[0]);
  },
  deleteOne: async (filter) => {
    const index = rows().findIndex((row) => matches(row, filter));
    if (index === -1) return { deletedCount: 0 };
    rows().splice(index, 1);
    return { deletedCount: 1 };
  },
  deleteMany: async (filter = {}) => {
    const keep = rows().filter((row) => !matches(row, filter));
    const removed = rows().length - keep.length;
    if (name === "User") db.users = keep;
    else if (name === "PendingSignup") db.pending = keep;
    else if (name === "UserSession") db.sessions = keep;
    return { deletedCount: removed };
  },
});

/** Whether the next `sendMail` should throw, and what the mail transport saw. */
export const mailTransport = {
  failNext: false,
  fail: false,
};

/**
 * The 6-digit code from the most recent verification email.
 *
 * Read out of the real mailed subject rather than reached for in the database,
 * so a change that stops actually sending the code shows up as a failure here.
 */
export const mailedCode = () => db.mail.at(-1)?.subject?.match(/\d{6}/)?.[0] ?? null;

/** A minimal express `res` that records what the handler answered. */
export const makeRes = () => ({
  statusCode: null,
  body: null,
  headers: {},
  cookies: {},
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  set(key, value) {
    this.headers[key] = value;
    return this;
  },
  cookie(name, value) {
    this.cookies[name] = value;
    return this;
  },
  clearCookie() {
    return this;
  },
});

/**
 * A minimal express `req`.
 *
 * `deviceId` becomes the `x-device-id` header, which is how `requestDeviceId`
 * identifies a device — the trusted-device tests need two requests to agree on
 * one, and two others to differ.
 */
export const makeReq = (body = {}, { deviceId, headers = {}, cookies = {} } = {}) => {
  const all = { ...headers };
  if (deviceId) all["x-device-id"] = deviceId;
  return {
    body,
    cookies,
    headers: all,
    params: {},
    query: {},
    get: (key) => all[String(key).toLowerCase()],
    ip: "203.0.113.1",
  };
};

let loaded = null;

/**
 * Register the mocks and import the real controller. Idempotent.
 */
export const loadAuth = async () => {
  if (loaded) return loaded;

  process.env.JWT_SECRET = "auth-harness-secret";
  /*
   * Set before the import: `authController` decides at module scope whether
   * mail is configured and swaps in a transporter that always throws if not,
   * which would turn every signup in every suite into a 502.
   */
  process.env.BREVO_EMAIL = "no-reply@gossips.test";
  process.env.BREVO_SMTP_KEY = "test-key";
  process.env.SMTP_USER = "test-user";

  mock.module("bcrypt", {
    defaultExport: {
      hash: async (plain) => `hashed:${plain}`,
      compare: async (plain, hash) => hash === `hashed:${plain}`,
    },
  });

  mock.module("nodemailer", {
    defaultExport: {
      createTransport: () => ({
        sendMail: async (message) => {
          if (mailTransport.fail || mailTransport.failNext) {
            mailTransport.failNext = false;
            const error = new Error("SMTP unavailable");
            error.code = "ECONNREFUSED";
            throw error;
          }
          db.mail.push(message);
          return { messageId: "test" };
        },
        verify: () => {},
      }),
    },
  });

  mock.module("firebase-admin", {
    defaultExport: {
      apps: [],
      app: () => {
        throw new Error("no default app");
      },
      credential: { cert: () => ({}) },
      initializeApp: () => {},
      auth: () => ({ verifyIdToken: async () => ({}) }),
    },
  });

  mock.module("../models/User.js", {
    defaultExport: makeModel("User", () => db.users),
  });
  mock.module("../models/PendingSignup.js", {
    defaultExport: makeModel("PendingSignup", () => db.pending),
  });
  mock.module("../models/UserSession.js", {
    defaultExport: makeModel("UserSession", () => db.sessions),
  });
  mock.module("../models/UserSettings.js", {
    defaultExport: makeModel("UserSettings", () => []),
  });

  mock.module("../controllers/notificationController.js", {
    namedExports: { sendWelcomeNotification: async () => {} },
  });
  mock.module("../utils/geo.js", { namedExports: { countryUpdate: async () => {} } });
  mock.module("../utils/username.js", {
    namedExports: { generateAvailableUsername: async () => "generated_name" },
  });
  /*
   * `tokenRevocation.js` itself is left real — it is the access-token denylist,
   * which is worth exercising rather than stubbing. Only the model underneath it
   * is faked. Replacing the whole module also silently dropped the exports other
   * suites import from it, which is its own argument for mocking as far down as
   * possible and no further.
   */
  mock.module("../models/RevokedToken.js", {
    defaultExport: makeModel("RevokedToken", () => db.revokedTokens),
  });

  loaded = await import("../controllers/authController.js");
  return loaded;
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** An ordinary password account, signed up and verified. */
export const makeUser = (overrides = {}) => {
  const row = {
    _id: oid(),
    name: "Alex Smith",
    username: "alexsmith",
    email: "alex@example.com",
    password: "hashed:Password123",
    isBot: false,
    accountStatus: "active",
    isEmailVerified: true,
    failedLoginAttempts: 0,
    lockoutUntil: null,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorBackupCodes: [],
    counts: {},
    ...overrides,
  };
  /*
   * `comparePassword` is a schema method, so it does not come from the fake
   * model — it lives on the row, matching the mocked bcrypt above.
   */
  row.comparePassword = async (plain) => row.password === `hashed:${plain}`;
  return row;
};

/** A live, unrevoked session for a device. */
export const makeSession = (userId, deviceId, overrides = {}) => ({
  _id: oid(),
  user: userId,
  deviceId,
  refreshTokenHash: `hash-${deviceId}`,
  refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  revokedAt: null,
  isTrusted: false,
  trustedAt: null,
  trustedUntil: null,
  lastActiveAt: new Date(),
  ...overrides,
});
