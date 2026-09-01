import assert from "node:assert/strict";
import test, { mock, before, beforeEach } from "node:test";
import mongoose from "mongoose";

/**
 * Adding a password to a Google-only account — against the real handlers.
 *
 * ── Why this file imports `authController` ──────────────────────────────────
 *
 * It used to be four `simulate*` helpers defined in this file, each a local
 * re-implementation of a branch, asserted against itself. `authController` was
 * never imported and neither were the models, so *every case passed no matter
 * what the controller did*. Change `signupUser` to write the password straight
 * onto the Google account — the exact unauthenticated takeover this design
 * exists to prevent — and the suite stayed green.
 *
 * That is worse than having no test here. The risk this path carries is a
 * silent regression, and a suite that cannot fail is precisely what makes a
 * regression silent: it turns "untested" into "believed tested".
 *
 * So the handlers under test are the shipped ones. Everything they touch that
 * isn't logic — Mongo, bcrypt, SMTP, Firebase — is mocked, which also keeps the
 * suite hermetic and off the native bcrypt binding.
 *
 * ── What is actually asserted ───────────────────────────────────────────────
 *
 *   1. `loginUser` refuses a Google-only account with `needPasswordSetup`.
 *   2. `signupUser` routes it through OTP and writes *no password anywhere*.
 *   3. A bot row sharing the owner's address is never the account attached to.
 *   4. `verifyOtp` applies the password under a guard, and refuses when the
 *      account gained one in the meantime or is no longer available.
 */

const oid = () => new mongoose.Types.ObjectId();

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Every write any model receives, so a test can assert one did *not* happen. */
let writes = [];
/** Rows the fake `User` collection will match on. */
let userRows = [];
/** Rows created in `PendingSignup`. */
let pendingRows = [];
let sentMail = [];

/*
 * Enough of Mongo's filter language for the queries these handlers issue.
 *
 * `$ne` matters especially: `HUMAN_ACCOUNT` is `{ isBot: { $ne: true } }` and
 * not `{ isBot: false }`, because rows predating the field have no `isBot` at
 * all. A fake that only did equality would quietly fail every lookup and make
 * these tests pass for the wrong reason.
 */
const matches = (row, filter) =>
  Object.entries(filter).every(([key, value]) => {
    if (key === "_id") return String(row._id) === String(value);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$exists" in value) {
        return (row[key] !== undefined && row[key] !== null) === value.$exists;
      }
      if ("$ne" in value) return row[key] !== value.$ne;
      if ("$gt" in value) return row[key] > value.$gt;
      if ("$lt" in value) return row[key] < value.$lt;
    }
    return row[key] === value;
  });

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

const fakeUserModel = {
  findOne: (filter) => makeQuery(userRows.find((row) => matches(row, filter)) ?? null),
  findById: (id) => makeQuery(userRows.find((row) => String(row._id) === String(id)) ?? null),
  updateOne: async (filter, update) => {
    writes.push({ model: "User", filter, update });
    const row = userRows.find((candidate) => matches(candidate, filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(row, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  },
  create: async (doc) => {
    writes.push({ model: "User", create: doc });
    const row = { _id: oid(), ...doc };
    userRows.push(row);
    return row;
  },
  exists: async (filter) => userRows.some((row) => matches(row, filter)),
};

const fakePendingModel = {
  find: (filter) => makeQuery(pendingRows.filter((row) => matches(row, filter))),
  findOne: (filter) => makeQuery(pendingRows.find((row) => matches(row, filter)) ?? null),
  create: async (doc) => {
    writes.push({ model: "PendingSignup", create: doc });
    const row = { ...doc, resendCount: doc.resendCount ?? 1, attempts: 0, lastSentAt: new Date() };
    pendingRows.push(row);
    return row;
  },
  deleteOne: async () => ({ deletedCount: 1 }),
  deleteMany: async () => ({ deletedCount: 0 }),
  findOneAndDelete: async (filter) => {
    const index = pendingRows.findIndex((row) => matches(row, filter));
    if (index === -1) return null;
    return pendingRows.splice(index, 1)[0];
  },
  findOneAndUpdate: async (filter) => pendingRows.find((row) => matches(row, filter)) ?? null,
  exists: async (filter) => pendingRows.some((row) => matches(row, filter)),
};

const noopModel = {
  findOne: () => makeQuery(null),
  find: () => makeQuery([]),
  create: async (doc) => doc,
  updateOne: async () => ({ matchedCount: 0 }),
  updateMany: async () => ({ matchedCount: 0 }),
  deleteMany: async () => ({ deletedCount: 0 }),
  countDocuments: async () => 0,
  findOneAndUpdate: async () => null,
};

/** Minimal express `res`, recording what the handler answered. */
const makeRes = () => {
  const res = {
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
  };
  return res;
};

let authController;

before(async () => {
  process.env.JWT_SECRET = "test-secret-for-google-password-setup";
  /*
   * Set before the import, because `authController` decides at module scope
   * whether mail is configured and swaps in a transporter that always throws if
   * not — which would make every signup here a 502 rather than exercising the
   * path under test.
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
          sentMail.push(message);
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
        throw new Error("no app");
      },
      credential: { cert: () => ({}) },
      initializeApp: () => {},
      auth: () => ({ verifyIdToken: async () => ({}) }),
    },
  });

  mock.module("../models/User.js", { defaultExport: fakeUserModel });
  mock.module("../models/PendingSignup.js", { defaultExport: fakePendingModel });
  mock.module("../models/UserSession.js", { defaultExport: noopModel });
  mock.module("../models/UserSettings.js", { defaultExport: noopModel });
  mock.module("../controllers/notificationController.js", {
    namedExports: { sendWelcomeNotification: async () => {} },
  });
  mock.module("../utils/geo.js", { namedExports: { countryUpdate: async () => {} } });
  mock.module("../utils/username.js", {
    namedExports: { generateAvailableUsername: async () => "alex_g" },
  });
  mock.module("../utils/tokenRevocation.js", {
    namedExports: { revokeAccessToken: async () => {} },
  });

  authController = await import("../controllers/authController.js");
});

beforeEach(() => {
  writes = [];
  userRows = [];
  pendingRows = [];
  sentMail = [];
});

const googleOnlyUser = () => ({
  _id: oid(),
  name: "Alex G",
  email: "alex@example.com",
  username: "alexg",
  googleId: "google-uid-12345",
  password: undefined,
  isBot: false,
  accountStatus: "active",
  comparePassword: async () => false,
});

// ── 1. loginUser ─────────────────────────────────────────────────────────────

test("loginUser: a Google-only account is told to set a password, not signed in", async () => {
  userRows.push(googleOnlyUser());
  const res = makeRes();

  await authController.loginUser(
    { body: { email: "alex@example.com", password: "Password123" }, get: () => undefined, headers: {} },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.needPasswordSetup, true);
  assert.equal(res.body.token, undefined, "no session may be issued");
});

// ── 2. signupUser ────────────────────────────────────────────────────────────

test("signupUser: routes a Google-only account through OTP and writes no password", async () => {
  const user = googleOnlyUser();
  userRows.push(user);
  const res = makeRes();

  await authController.signupUser(
    { body: { name: "Alex G", email: "alex@example.com", password: "Password123" }, get: () => undefined, headers: {} },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.requiresVerification, true);
  assert.ok(res.body.verificationToken, "a ticket, not a session");
  assert.equal(res.body.token, undefined, "no session may be issued before the code");

  // The pending row names the account to attach to.
  assert.equal(pendingRows.length, 1);
  assert.equal(String(pendingRows[0].user), String(user._id));
  assert.notEqual(pendingRows[0].passwordHash, "Password123", "stored hashed, never plaintext");

  /*
   * The assertion this whole file exists for. Signing up must not put a
   * password on the account — that was an unauthenticated takeover of any
   * Google-only user whose address you could guess, in one request.
   */
  const passwordWrites = writes.filter(
    (write) => write.model === "User" && write.update?.$set && "password" in write.update.$set,
  );
  assert.equal(passwordWrites.length, 0, "signup must never write a password to a User row");
  assert.equal(user.password, undefined);
});

test("signupUser: an account that already has a password is refused outright", async () => {
  const user = { ...googleOnlyUser(), password: "hashed:Existing123" };
  userRows.push(user);
  const res = makeRes();

  await authController.signupUser(
    { body: { name: "Someone Else", email: "alex@example.com", password: "Password123" }, get: () => undefined, headers: {} },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "User already exists");
  assert.equal(pendingRows.length, 0, "no pending row for an account that cannot be claimed");
  assert.equal(user.password, "hashed:Existing123", "the existing password is untouched");
});

test("signupUser: a weak password is rejected before any row is written", async () => {
  userRows.push(googleOnlyUser());
  const res = makeRes();

  await authController.signupUser(
    { body: { name: "Alex G", email: "alex@example.com", password: "weak" }, get: () => undefined, headers: {} },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /password/i);
  assert.equal(pendingRows.length, 0);
  assert.equal(sentMail.length, 0);
});

// ── 3. Bot exclusion ─────────────────────────────────────────────────────────

test("signupUser: a bot row sharing the owner's address is never attached to", async () => {
  /*
   * Bots carry their owner's email. Without the HUMAN_ACCOUNT filter this
   * lookup returns the bot, and a path that attaches credentials to a
   * passwordless row would be attaching them to somebody's bot — handing the
   * persona's identity to whoever controls the mailbox.
   */
  const bot = {
    _id: oid(),
    email: "owner@example.com",
    name: "Persona Bot",
    isBot: true,
    googleId: undefined,
    password: undefined,
    accountStatus: "active",
  };
  userRows.push(bot);
  const res = makeRes();

  await authController.signupUser(
    { body: { name: "Owner", email: "owner@example.com", password: "Password123" }, get: () => undefined, headers: {} },
    res,
  );

  // Treated as a brand-new signup: a pending row with no account to attach to.
  assert.equal(res.body.requiresVerification, true);
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0].user, null, "must not name the bot row");
  assert.notEqual(String(pendingRows[0].user ?? ""), String(bot._id));
});

// ── 4. verifyOtp ─────────────────────────────────────────────────────────────

/** Drive signup, then read the code out of the mailed message. */
const startPasswordSetup = async (user) => {
  userRows.push(user);
  const res = makeRes();
  await authController.signupUser(
    { body: { name: user.name, email: user.email, password: "Password123" }, get: () => undefined, headers: {} },
    res,
  );
  const code = sentMail.at(-1)?.subject?.match(/\d{6}/)?.[0];
  assert.ok(code, "the mailed subject carries the code");
  return { token: res.body.verificationToken, code };
};

test("verifyOtp: applies the password to the named account and verifies the address", async () => {
  const user = googleOnlyUser();
  const { token, code } = await startPasswordSetup(user);
  const res = makeRes();

  await authController.verifyOtp({ body: { token, code }, get: () => undefined, headers: {} }, res);

  const guarded = writes.find(
    (write) => write.model === "User" && write.update?.$set && "password" in write.update.$set,
  );
  assert.ok(guarded, "the password is applied on verification, not before");
  assert.deepEqual(
    guarded.filter.password,
    { $exists: false },
    "applied under a guard, so a password gained in the meantime is not overwritten",
  );
  assert.equal(guarded.update.$set.isEmailVerified, true);
});

test("verifyOtp: refuses when the account gained a password while the code was in flight", async () => {
  const user = googleOnlyUser();
  const { token, code } = await startPasswordSetup(user);

  // Ten minutes is long enough for the account to have set one another way.
  user.password = "hashed:SetByAnotherRoute1";

  const res = makeRes();
  await authController.verifyOtp({ body: { token, code }, get: () => undefined, headers: {} }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.alreadyVerified, true);
  assert.equal(user.password, "hashed:SetByAnotherRoute1", "must not be overwritten");
});

test("verifyOtp: refuses when the account is no longer available", async () => {
  for (const status of ["deleted", "deactivated"]) {
    writes = [];
    userRows = [];
    pendingRows = [];
    sentMail = [];

    const user = googleOnlyUser();
    const { token, code } = await startPasswordSetup(user);
    user.accountStatus = status;

    const res = makeRes();
    await authController.verifyOtp({ body: { token, code }, get: () => undefined, headers: {} }, res);

    assert.equal(res.statusCode, 410, `${status} account must be refused`);
    assert.equal(res.body.expired, true);
    assert.equal(user.password, undefined, `${status}: no password may be applied`);
  }
});

test("verifyOtp: a wrong code applies nothing", async () => {
  const user = googleOnlyUser();
  const { token, code } = await startPasswordSetup(user);
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");

  const res = makeRes();
  await authController.verifyOtp({ body: { token, code: wrong }, get: () => undefined, headers: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(user.password, undefined);
  const passwordWrites = writes.filter(
    (write) => write.model === "User" && write.update?.$set && "password" in write.update.$set,
  );
  assert.equal(passwordWrites.length, 0);
});
