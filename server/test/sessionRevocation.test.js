import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { loadAuth, db, resetDb, makeRes, makeReq, makeUser, makeSession } from "./authHarness.mjs";

/**
 * Listing and revoking device sessions, against the real handlers.
 *
 * Previously `revokeSingle` / `logoutOthers` / `logoutAll` closures in
 * `tokenSecurity.test.js`, asserted against themselves. These are the controls a
 * person reaches for *after* they think they have been compromised, so the
 * failure mode is someone believing they have kicked an attacker out when they
 * have not — and they now also carry device trust, since revoking a session is
 * what withdraws its right to skip the second factor.
 */

let auth;
let deviceIsTrusted;
before(async () => {
  auth = await loadAuth();
  // After loadAuth: a static import would bind the real UserSession.
  ({ deviceIsTrusted } = await import("../utils/trustedDevices.js"));
});
beforeEach(resetDb);

const CURRENT = "device-current01";
const OTHER_A = "device-other001";
const OTHER_B = "device-other002";

const seedSessions = (user) => {
  db.sessions.push(
    makeSession(user._id, CURRENT),
    makeSession(user._id, OTHER_A),
    makeSession(user._id, OTHER_B, {
      isTrusted: true,
      trustedAt: new Date(),
      trustedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }),
  );
};

const authed = (user, body = {}, deviceId = CURRENT) => {
  const req = makeReq(body, { deviceId });
  req.user = { _id: user._id };
  return req;
};

test("list: reports the caller's devices and marks the current one", async () => {
  const user = makeUser();
  db.users.push(user);
  seedSessions(user);

  const res = makeRes();
  await auth.listSessions(authed(user), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 3);
  assert.equal(res.body.sessions.filter((s) => s.isCurrent).length, 1);
  assert.equal(res.body.sessions.find((s) => s.isCurrent).deviceId, CURRENT);
});

test("list: never shows another account's devices", async () => {
  const alex = makeUser();
  const other = makeUser({ email: "other@example.com" });
  db.users.push(alex, other);
  seedSessions(alex);
  db.sessions.push(makeSession(other._id, "device-stranger1"));

  const res = makeRes();
  await auth.listSessions(authed(alex), res);

  assert.equal(res.body.sessions.length, 3);
  assert.ok(res.body.sessions.every((s) => s.deviceId !== "device-stranger1"));
});

test("list: reports trust only while it is still in date", async () => {
  /*
   * These fields used to default to true and be re-set on every token issue, so
   * this screen described every device as trusted — on the one screen whose
   * purpose is helping someone spot a device that is not theirs.
   */
  const user = makeUser();
  db.users.push(user);
  db.sessions.push(
    makeSession(user._id, CURRENT),
    makeSession(user._id, OTHER_A, {
      isTrusted: true,
      trustedAt: new Date(),
      trustedUntil: new Date(Date.now() - 1000),
    }),
    makeSession(user._id, OTHER_B, {
      isTrusted: true,
      trustedAt: new Date(),
      trustedUntil: new Date(Date.now() + 60_000),
    }),
  );

  const res = makeRes();
  await auth.listSessions(authed(user), res);

  const byDevice = Object.fromEntries(res.body.sessions.map((s) => [s.deviceId, s]));
  assert.equal(byDevice[CURRENT].isTrusted, false, "never trusted");
  assert.equal(byDevice[OTHER_A].isTrusted, false, "trust has lapsed");
  assert.equal(byDevice[OTHER_A].trustedUntil, null, "and is not advertised");
  assert.equal(byDevice[OTHER_B].isTrusted, true);
});

test("revoke: removes exactly the named session", async () => {
  const user = makeUser();
  db.users.push(user);
  seedSessions(user);
  const target = db.sessions.find((s) => s.deviceId === OTHER_A);

  const res = makeRes();
  const req = authed(user);
  req.params = { sessionId: String(target._id) };
  await auth.revokeSession(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isCurrent, false);
  assert.equal(db.sessions.length, 2);
  assert.ok(!db.sessions.some((s) => s.deviceId === OTHER_A));
});

test("revoke: withdraws that device's trust along with its session", async () => {
  const user = makeUser();
  db.users.push(user);
  seedSessions(user);
  const trusted = db.sessions.find((s) => s.deviceId === OTHER_B);
  assert.equal(deviceIsTrusted(trusted), true, "precondition");

  const res = makeRes();
  const req = authed(user);
  req.params = { sessionId: String(trusted._id) };
  await auth.revokeSession(req, res);

  assert.ok(
    !db.sessions.some((s) => s.deviceId === OTHER_B),
    "revoking is how a person takes back a device's right to skip 2FA",
  );
});

test("revoke: cannot touch a session belonging to someone else", async () => {
  const alex = makeUser();
  const other = makeUser({ email: "other@example.com" });
  db.users.push(alex, other);
  const theirs = makeSession(other._id, "device-stranger1");
  db.sessions.push(theirs);

  const res = makeRes();
  const req = authed(alex);
  req.params = { sessionId: String(theirs._id) };
  await auth.revokeSession(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(db.sessions.length, 1, "another account's session must survive");
});

test("logout-others: clears every device but this one", async () => {
  const user = makeUser();
  db.users.push(user);
  seedSessions(user);

  const res = makeRes();
  await auth.logoutOtherDevices(authed(user), res);

  assert.equal(res.statusCode, 200);
  assert.equal(db.sessions.length, 1);
  assert.equal(db.sessions[0].deviceId, CURRENT, "the device you are holding stays signed in");
});

test("logout-others: leaves other accounts alone", async () => {
  const alex = makeUser();
  const other = makeUser({ email: "other@example.com" });
  db.users.push(alex, other);
  seedSessions(alex);
  db.sessions.push(makeSession(other._id, "device-stranger1"));

  const res = makeRes();
  await auth.logoutOtherDevices(authed(alex), res);

  assert.ok(db.sessions.some((s) => s.deviceId === "device-stranger1"));
  assert.ok(!db.sessions.some((s) => String(s.user) === String(alex._id) && s.deviceId !== CURRENT));
});

test("logout-all: clears every device including this one", async () => {
  const user = makeUser();
  db.users.push(user);
  seedSessions(user);

  const res = makeRes();
  await auth.logoutAllDevices(authed(user), res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    db.sessions.filter((s) => String(s.user) === String(user._id)).length,
    0,
    "'log out everywhere' has to mean everywhere, or it is worse than not offering it",
  );
});
