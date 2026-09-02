import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import {
  loadAuth,
  db,
  resetDb,
  makeRes,
  makeReq,
  makeUser,
  makeSession,
  mailTransport,
} from "./authHarness.mjs";

/**
 * Forgot / reset password, and what a reset actually invalidates.
 *
 * The confirmation email is the easy half. The half worth testing is the
 * promise it makes: it tells the user their sessions were revoked, so the
 * revocation had better be complete — including the access tokens the server
 * has never seen, which deleting `UserSession` rows does not touch.
 */

let auth;
let isTokenBeforeCutoff;
before(async () => {
  auth = await loadAuth();
  // After loadAuth: tokenCutoff.js imports User.
  ({ isTokenBeforeCutoff } = await import("../utils/tokenCutoff.js"));
});
beforeEach(() => {
  resetDb();
  mailTransport.fail = false;
  mailTransport.failNext = false;
  process.env.FRONTEND_URL = "https://gossips.test";
});

const forgot = async (email) => {
  const res = makeRes();
  await auth.forgotPassword({ ...makeReq({ email }), method: "POST" }, res);
  return res;
};

const reset = async (token, password = "NewPassword1") => {
  const res = makeRes();
  await auth.resetPassword(makeReq({ token, password }), res);
  return res;
};

/** The raw token out of the emailed link, which is the only place it exists. */
const emailedResetToken = () =>
  db.mail.at(-1)?.html?.match(/reset-password\/([a-f0-9]{64})/)?.[1] ?? null;

// ── forgotPassword ───────────────────────────────────────────────────────────

test("forgot: an unknown address gets the same answer as a known one", async () => {
  db.users.push(makeUser());

  const known = await forgot("alex@example.com");
  const unknown = await forgot("nobody@example.com");

  assert.equal(known.statusCode, 200);
  assert.equal(unknown.statusCode, 200);
  assert.deepEqual(known.body, unknown.body, "the response must not disclose registration");
  assert.equal(db.mail.length, 1, "and only the real address is mailed");
});

test("forgot: a failed send still answers like an unknown address", async () => {
  /*
   * The send used to be awaited bare, so during an SMTP outage a registered
   * address got a 500 and an unregistered one a 200 — a mail problem became an
   * enumeration oracle for as long as it lasted.
   */
  db.users.push(makeUser());
  mailTransport.failNext = true;

  const known = await forgot("alex@example.com");
  const unknown = await forgot("nobody@example.com");

  assert.equal(known.statusCode, 200);
  assert.deepEqual(known.body, unknown.body);
});

test("forgot: only the hash of the token is stored", async () => {
  const user = makeUser();
  db.users.push(user);

  await forgot("alex@example.com");
  const raw = emailedResetToken();

  assert.ok(raw, "a token reaches the user by email");
  assert.notEqual(user.resetPasswordToken, raw, "the database must not hold the bearer secret");
  assert.ok(user.resetPasswordExpires > Date.now());
});

test("forgot: a bot row sharing an address is never sent a reset link", async () => {
  db.users.push(makeUser({ email: "owner@example.com", isBot: true }));

  const res = await forgot("owner@example.com");

  assert.equal(res.statusCode, 200);
  assert.equal(db.mail.length, 0, "a reset must never mint a session for a bot account");
});

// ── resetPassword ────────────────────────────────────────────────────────────

const startReset = async () => {
  const user = makeUser();
  db.users.push(user);
  await forgot(user.email);
  const token = emailedResetToken();
  db.mail.length = 0;
  return { user, token };
};

test("reset: a valid token sets the new password and consumes itself", async () => {
  const { user, token } = await startReset();

  const res = await reset(token);
  assert.equal(res.statusCode, 200);
  assert.equal(user.password, "hashed:NewPassword1");
  assert.equal(user.resetPasswordToken, undefined, "single use");

  const replay = await reset(token);
  assert.equal(replay.statusCode, 400, "the link must not work twice");
});

test("reset: an expired or forged token is refused", async () => {
  const { user, token } = await startReset();

  user.resetPasswordExpires = Date.now() - 1000;
  assert.equal((await reset(token)).statusCode, 400);

  user.resetPasswordExpires = Date.now() + 3600000;
  assert.equal((await reset("f".repeat(64))).statusCode, 400);
  assert.equal((await reset(null)).statusCode, 400);
});

test("reset: a weak password is refused and the token survives for another try", async () => {
  const { user, token } = await startReset();

  const res = await reset(token, "weak");
  assert.equal(res.statusCode, 400);
  assert.ok(user.resetPasswordToken, "a typo must not burn the link");
});

test("reset: sends the 'your password was changed' confirmation", async () => {
  const { token } = await startReset();

  await reset(token);

  assert.equal(db.mail.length, 1);
  assert.match(db.mail[0].subject, /password/i);
  assert.equal(db.mail[0].to, "alex@example.com");
});

test("reset: a failed confirmation email does not fail the reset", async () => {
  // The password is already changed by then; answering 500 would tell the user
  // it had not been.
  const { user, token } = await startReset();
  mailTransport.failNext = true;

  const res = await reset(token);

  assert.equal(res.statusCode, 200);
  assert.equal(user.password, "hashed:NewPassword1");
});

test("reset: clears any lockout, so the new password works immediately", async () => {
  const { user, token } = await startReset();
  user.failedLoginAttempts = 5;
  user.lockoutUntil = new Date(Date.now() + 10 * 60 * 1000);

  await reset(token);

  assert.equal(user.failedLoginAttempts, 0);
  assert.equal(user.lockoutUntil, null);
});

// ── What the confirmation email promises ─────────────────────────────────────

test("reset: deletes every session, including trusted devices", async () => {
  const { user, token } = await startReset();
  db.sessions.push(
    makeSession(user._id, "device-aaaaaaa1"),
    makeSession(user._id, "device-bbbbbbb2", {
      isTrusted: true,
      trustedAt: new Date(),
      trustedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }),
  );

  await reset(token);

  assert.equal(
    db.sessions.filter((s) => String(s.user) === String(user._id)).length,
    0,
    "including the device that was allowed to skip 2FA",
  );
});

test("reset: voids access tokens already issued, not just refresh", async () => {
  /*
   * The gap this closes. Deleting `UserSession` rows stops new access tokens
   * being minted; it does nothing to the ones already on devices, which the
   * server has never seen and cannot enumerate. So the person who resets their
   * password *because* they are compromised left the attacker a working token
   * for the rest of its fifteen minutes — while being emailed a note saying
   * their sessions had been revoked.
   */
  const { user, token } = await startReset();

  // A token minted before the reset.
  const stolen = { id: String(user._id), typ: "access", iat: Math.floor(Date.now() / 1000) - 60 };
  assert.equal(isTokenBeforeCutoff(stolen, user), false, "precondition: valid before the reset");

  await reset(token);

  assert.equal(
    isTokenBeforeCutoff(stolen, user),
    true,
    "an access token issued before the reset must stop working",
  );
});

test("cutoff: a token minted in the same second as the reset still works", async () => {
  /*
   * `iat` has one-second granularity and the cutoff is milliseconds, so a naive
   * comparison rejects the token handed out by the very next sign-in and locks
   * the user out of the account they just recovered.
   */
  const { user, token } = await startReset();
  await reset(token);

  const cutoffSecond = Math.floor(new Date(user.sessionsValidFrom).getTime() / 1000);
  assert.equal(isTokenBeforeCutoff({ iat: cutoffSecond }, user), false);
  assert.equal(isTokenBeforeCutoff({ iat: cutoffSecond + 1 }, user), false);
  assert.equal(isTokenBeforeCutoff({ iat: cutoffSecond - 1 }, user), true);
});

test("cutoff: an account that never reset anything is unaffected", async () => {
  const user = makeUser();
  assert.equal(user.sessionsValidFrom, undefined);
  assert.equal(isTokenBeforeCutoff({ iat: 1 }, user), false);
});

test("cutoff: a token with no issue time is refused rather than trusted", async () => {
  const user = makeUser({ sessionsValidFrom: new Date() });
  assert.equal(isTokenBeforeCutoff({}, user), true);
  assert.equal(isTokenBeforeCutoff({ iat: "nonsense" }, user), true);
});

test("log out everywhere: voids the other devices' access tokens too", async () => {
  const user = makeUser();
  db.users.push(user);
  db.sessions.push(makeSession(user._id, "device-aaaaaaa1"), makeSession(user._id, "device-bbbbbbb2"));

  const otherDevice = { id: String(user._id), typ: "access", iat: Math.floor(Date.now() / 1000) - 60 };

  const res = makeRes();
  const req = makeReq({}, { deviceId: "device-aaaaaaa1" });
  req.user = { _id: user._id };
  await auth.logoutAllDevices(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(db.sessions.length, 0);
  assert.equal(
    isTokenBeforeCutoff(otherDevice, user),
    true,
    "'everywhere' has to reach the devices that are not making this request",
  );
});
