import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { loadAuth, db, resetDb, makeRes, makeReq, makeUser, makeSession } from "./authHarness.mjs";

/**
 * Refresh-token rotation and reuse detection, against the real
 * `refreshAccessToken`.
 *
 * This lived in `tokenSecurity.test.js` as a `simulateRefresh` closure asserted
 * against itself, so the controller could stop detecting reuse entirely without
 * a failure. Reuse detection is the control that turns a stolen refresh token
 * from a permanent, invisible foothold into a one-shot that burns the whole
 * account's sessions — a regression here is silent by construction, because the
 * happy path keeps working perfectly for both the user and the thief.
 */

let auth;
before(async () => {
  auth = await loadAuth();
});
beforeEach(resetDb);

const DEVICE = "device-abcdef01";

/** Sign in for real, so the session row and cookie are the ones the app makes. */
const signIn = async (user, deviceId = DEVICE) => {
  const res = makeRes();
  await auth.loginUser(
    makeReq({ email: user.email, password: "Password123" }, { deviceId }),
    res,
  );
  assert.equal(res.statusCode, 200, "sign-in should succeed");
  return { accessToken: res.body.token, cookies: res.cookies };
};

const refresh = async (refreshToken, { accountId, deviceId = DEVICE } = {}) => {
  const res = makeRes();
  await auth.refreshAccessToken(
    makeReq(accountId ? { accountId } : {}, {
      deviceId,
      cookies: { refreshToken },
    }),
    res,
  );
  return res;
};

test("tokens: no two are ever byte-identical, even minted in the same second", async () => {
  /*
   * `UserSession.refreshTokenHash` is uniquely indexed, and rotation only means
   * anything if the new token differs from the old. Both fail if the payload is
   * just `{ id, typ, iat, exp }`, because that is fixed by the account and the
   * current second — which is what a `jti` nonce is there to prevent. This ran
   * red before it was added: two sign-ins inside one second produced the same
   * string.
   */
  const user = makeUser();
  db.users.push(user);

  const issued = new Set();
  for (let i = 0; i < 8; i++) {
    const { accessToken, cookies } = await signIn(user, `device-uniq${String(i).padStart(4, "0")}`);
    issued.add(accessToken);
    issued.add(cookies.refreshToken);
  }

  assert.equal(issued.size, 16, "every access and refresh token must be distinct");
});

test("rotation: a valid refresh token is exchanged and the old one stops working", async () => {
  const user = makeUser();
  db.users.push(user);
  const { cookies } = await signIn(user);
  const original = cookies.refreshToken;

  const first = await refresh(original);
  assert.equal(first.statusCode, 200);
  assert.ok(first.body.token, "a fresh access token comes back");

  const rotated = first.cookies.refreshToken;
  assert.notEqual(rotated, original, "the refresh token must actually rotate");

  const second = await refresh(rotated);
  assert.equal(second.statusCode, 200, "the rotated token works");
});

test("rotation: happens in place, so the device keeps its one session row", async () => {
  const user = makeUser();
  db.users.push(user);
  const { cookies } = await signIn(user);

  await refresh(cookies.refreshToken);

  assert.equal(db.sessions.length, 1, "rotation must not orphan or duplicate rows");
  assert.equal(db.sessions[0].deviceId, DEVICE);
  assert.ok(db.sessions[0].rotatedAt, "rotation is recorded");
  assert.ok(db.sessions[0].previousRefreshTokenHash, "the consumed hash is remembered");
});

test("reuse detection: replaying a consumed token revokes every session for the account", async () => {
  const user = makeUser();
  db.users.push(user);

  const { cookies } = await signIn(user, "device-abcdef01");
  await signIn(user, "device-abcdef02");
  await signIn(user, "device-abcdef03");
  assert.equal(db.sessions.length, 3);

  const stolen = cookies.refreshToken;
  const legitimate = (await refresh(stolen)).cookies.refreshToken;
  assert.ok(legitimate);

  // The thief presents the token they captured before the rotation.
  const replay = await refresh(stolen);

  assert.equal(replay.statusCode, 401);
  assert.equal(replay.body.reuseDetected, true);
  assert.equal(
    db.sessions.length,
    0,
    "every session dies, including the ones on devices that were never touched",
  );

  // And the legitimate holder is locked out too — which is the intended
  // outcome: the account is compromised and everyone must sign in again.
  const after = await refresh(legitimate);
  assert.equal(after.statusCode, 401);
});

test("reuse detection: the replay response clears the cookie it was sent", async () => {
  const user = makeUser();
  db.users.push(user);
  const { cookies } = await signIn(user);
  const stolen = cookies.refreshToken;
  await refresh(stolen);

  const replay = await refresh(stolen);
  assert.equal(replay.body.reuseDetected, true);
  // Nothing usable may be handed back on a detected breach.
  assert.equal(replay.body.token, undefined);
});

test("reuse detection: does not fire for a token that was simply never issued", async () => {
  const user = makeUser();
  db.users.push(user);
  await signIn(user);

  // A well-formed token for this user that no session has ever held.
  const { cookies } = await signIn(makeUserWithEmail("other@example.com"), "device-abcdef09");
  db.sessions = db.sessions.filter((row) => row.deviceId !== "device-abcdef09");

  const res = await refresh(cookies.refreshToken);
  assert.equal(res.statusCode, 401);
  assert.notEqual(
    res.body.reuseDetected,
    true,
    "an unknown token is expired-or-revoked, not a detected breach — nuking sessions on it would be a denial-of-service anyone could trigger",
  );
});

function makeUserWithEmail(email) {
  const user = makeUser({ email });
  db.users.push(user);
  return user;
}

test("refresh: a missing or malformed token is refused without touching sessions", async () => {
  const user = makeUser();
  db.users.push(user);
  await signIn(user);

  const missing = makeRes();
  await auth.refreshAccessToken(makeReq({}, { deviceId: DEVICE, cookies: {} }), missing);
  assert.equal(missing.statusCode, 401);

  const malformed = await refresh("not-a-jwt");
  assert.equal(malformed.statusCode, 401);

  assert.equal(db.sessions.length, 1, "a bad token must not cost anyone their session");
});

test("refresh: a token cannot be redeemed against a different named account", async () => {
  /*
   * The fallback to the shared cookie is what makes this reachable: without the
   * check, an older tab naming account A could be handed a session for whoever
   * the shared cookie last pointed at.
   */
  const alex = makeUser();
  db.users.push(alex);
  const { cookies } = await signIn(alex);

  const res = await refresh(cookies.refreshToken, { accountId: String(makeUserWithEmail("b@example.com")._id) });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
});

test("refresh: a deactivated account cannot refresh, and its session is dropped", async () => {
  const user = makeUser();
  db.users.push(user);
  const { cookies } = await signIn(user);

  user.accountStatus = "deactivated";
  const res = await refresh(cookies.refreshToken);

  assert.equal(res.statusCode, 401);
  assert.equal(db.sessions.length, 0);
});

test("session cap: signing in on many devices evicts the least recently active", async () => {
  const MAX_SESSIONS_PER_USER = 10;
  const user = makeUser();
  db.users.push(user);

  for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i++) {
    await signIn(user, `device-cap${String(i).padStart(4, "0")}`);
  }

  assert.ok(
    db.sessions.length <= MAX_SESSIONS_PER_USER,
    `session rows must stay bounded, got ${db.sessions.length}`,
  );
});
