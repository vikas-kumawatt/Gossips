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
