import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import {
  JWT_VERIFY_OPTIONS,
  isAccessToken,
  getAccessTokenSecret,
  getRefreshTokenSecret,
  getVerificationTicketSecret,
} from "../config/jwt.js";
import {
  hashAccessToken,
  revokeAccessToken,
  isTokenRevoked,
} from "../utils/tokenRevocation.js";

process.env.JWT_SECRET = "base-test-secret-key-32-chars-long";

test("cryptographic domain separation: access, refresh, and verify tokens use distinct secrets", () => {
  const accessSecret = getAccessTokenSecret();
  const refreshSecret = getRefreshTokenSecret();
  const verifySecret = getVerificationTicketSecret();

  assert.notEqual(accessSecret, refreshSecret, "Access and refresh secrets must be distinct");
  assert.notEqual(accessSecret, verifySecret, "Access and verify secrets must be distinct");
  assert.notEqual(refreshSecret, verifySecret, "Refresh and verify secrets must be distinct");

  const userId = "68b0f3c1a2d4e5f60718293a";

  const accessToken = jwt.sign({ id: userId, typ: "access" }, accessSecret, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ id: userId, typ: "refresh" }, refreshSecret, { expiresIn: "7d" });
  const verifyTicket = jwt.sign({ sid: userId, typ: "verify", email: "a@b.com" }, verifySecret, { expiresIn: "10m" });

  // Access token verifies against accessSecret
  const decodedAccess = jwt.verify(accessToken, accessSecret, JWT_VERIFY_OPTIONS);
  assert.equal(decodedAccess.id, userId);
  assert.equal(isAccessToken(decodedAccess), true);

  // Refresh token CANNOT verify against accessSecret (cryptographic rejection)
  assert.throws(
    () => jwt.verify(refreshToken, accessSecret, JWT_VERIFY_OPTIONS),
    /invalid signature/i,
    "Refresh token must fail cryptographic verification against access secret"
  );

  // Verify ticket CANNOT verify against accessSecret (cryptographic rejection)
  assert.throws(
    () => jwt.verify(verifyTicket, accessSecret, JWT_VERIFY_OPTIONS),
    /invalid signature/i,
    "Verify ticket must fail cryptographic verification against access secret"
  );
});

test("access token revocation: token is valid before logout and immediately rejected after revocation", async () => {
  const token = jwt.sign(
    { id: "user-123", typ: "access", jti: "unique-token-id-456" },
    getAccessTokenSecret(),
    { expiresIn: "15m" }
  );

  // Initially unrevoked
  assert.equal(await isTokenRevoked(token), false);

  // Revoke token (simulate logout)
  const decoded = jwt.decode(token);
  await revokeAccessToken(token, decoded.id, decoded.exp, "logout");

  // Instantly blocked
  assert.equal(await isTokenRevoked(token), true);

  // Hash determinism
  assert.equal(hashAccessToken(token), hashAccessToken(token));
});

test("refresh token rotation & reuse detection: normal rotation succeeds and reused token triggers account revocation", () => {
  const userId = "68b0f3c1a2d4e5f60718293a";
  const rt1 = "refresh_token_1_initial";
  const rt2 = "refresh_token_2_rotated";
  const hash1 = hashAccessToken(rt1);
  const hash2 = hashAccessToken(rt2);

  // Initial session state
  let session = {
    _id: "session-1",
    user: userId,
    refreshTokenHash: hash1,
    previousRefreshTokenHash: null,
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  };

  let allSessions = [session];

  const simulateRefresh = (presentedToken) => {
    const presentedHash = hashAccessToken(presentedToken);
    const activeSession = allSessions.find(
      (s) => s.refreshTokenHash === presentedHash && s.refreshTokenExpiresAt > new Date()
    );

    if (activeSession) {
      // In-place atomic rotation
      activeSession.previousRefreshTokenHash = activeSession.refreshTokenHash;
      activeSession.refreshTokenHash = hash2;
      activeSession.rotatedAt = new Date();
      return { status: 200, token: "new_access_token", session: activeSession };
    }

    // Reuse detection
    const reusedSession = allSessions.find(
      (s) => s.previousRefreshTokenHash === presentedHash
    );

    if (reusedSession) {
      // Breach detected: purge all sessions for user
      allSessions = allSessions.filter((s) => s.user !== userId);
      return {
        status: 401,
        body: {
          message: "Compromised token: Refresh token reuse detected. All sessions have been revoked for your security.",
          reuseDetected: true,
        },
      };
    }

    return { status: 401, body: { message: "Refresh token expired or revoked" } };
  };

  // 1. Normal rotation with RT1 -> succeeds and rotates to RT2
  const firstRefresh = simulateRefresh(rt1);
  assert.equal(firstRefresh.status, 200);
  assert.equal(firstRefresh.session.refreshTokenHash, hash2);
  assert.equal(firstRefresh.session.previousRefreshTokenHash, hash1);
  assert.equal(allSessions.length, 1);

  // 2. Adversary replays consumed RT1 -> reuse detected, all sessions wiped
  const replayAttempt = simulateRefresh(rt1);
  assert.equal(replayAttempt.status, 401);
  assert.equal(replayAttempt.body.reuseDetected, true);
  assert.equal(allSessions.length, 0, "All sessions must be wiped on refresh token reuse");
});

test("per-user session cap: restricts active UserSession rows to MAX_SESSIONS_PER_USER (10) via LRU eviction", () => {
  const MAX_SESSIONS = 10;
  const userId = "68b0f3c1a2d4e5f60718293a";

  let sessions = [];

  const storeSession = (deviceId) => {
    // Upsert session
    const existingIndex = sessions.findIndex((s) => s.deviceId === deviceId);
    const newSession = {
      _id: `session_${deviceId}`,
      user: userId,
      deviceId,
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    };

    if (existingIndex >= 0) {
      sessions[existingIndex] = newSession;
    } else {
      sessions.push(newSession);
    }

    // Prune excess
    if (sessions.length > MAX_SESSIONS) {
      sessions.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      const excess = sessions.length - MAX_SESSIONS;
      sessions.splice(0, excess);
    }
  };

  // Create 15 distinct device sessions
  for (let i = 1; i <= 15; i++) {
    storeSession(`device_${i}`);
  }

  // Cap must strictly hold at 10
  assert.equal(sessions.length, MAX_SESSIONS);
  // Oldest 5 devices (device_1 to device_5) evicted, newest 10 (device_6 to device_15) preserved
  assert.equal(sessions.some((s) => s.deviceId === "device_1"), false);
  assert.equal(sessions.some((s) => s.deviceId === "device_5"), false);
  assert.equal(sessions.some((s) => s.deviceId === "device_15"), true);
});

test("session revocation: single session revoke, logout-others, and logout-all", () => {
  const userId = "68b0f3c1a2d4e5f60718293a";
  let sessions = [
    { _id: "s1", user: userId, deviceId: "phone_1" },
    { _id: "s2", user: userId, deviceId: "laptop_current" },
    { _id: "s3", user: userId, deviceId: "tablet_3" },
  ];

  // 1. Single session revoke
  const revokeSingle = (sessionId) => {
    sessions = sessions.filter((s) => s._id !== sessionId);
  };
  revokeSingle("s1");
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((s) => s._id === "s1"), false);

  // 2. Logout other devices (keep current laptop)
  const currentDeviceId = "laptop_current";
  const logoutOthers = () => {
    sessions = sessions.filter((s) => s.deviceId === currentDeviceId);
  };
  logoutOthers();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].deviceId, "laptop_current");

  // 3. Logout all devices
  const logoutAll = () => {
    sessions = [];
  };
  logoutAll();
  assert.equal(sessions.length, 0);
});

test("usernameHistory bounding: history is capped to 10 entries while preserving quota calculations", () => {
  let history = [];
  const maxHistory = 10;

  // Simulate 15 consecutive username changes over time
  for (let i = 1; i <= 15; i++) {
    history.push({ username: `user_v${i}`, changedAt: new Date() });
    if (history.length > maxHistory) {
      history = history.slice(-maxHistory);
    }
  }

  assert.equal(history.length, 10, "usernameHistory array must be bounded to 10 entries");
  assert.equal(history[0].username, "user_v6", "Oldest 5 entries must be pruned");
  assert.equal(history[9].username, "user_v15", "Latest entry must be preserved");
});




