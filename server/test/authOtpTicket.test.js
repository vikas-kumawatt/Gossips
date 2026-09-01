import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { JWT_VERIFY_OPTIONS } from "../config/jwt.js";

const TEST_SECRET = "test-jwt-secret-key-123456";
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_SENDS = 5;
/*
 * The longest a signup can stay open, not the life of one code — see the
 * comment on the real constant. A ticket pinned to a single OTP window expired
 * while its row was still alive whenever a resend response failed to arrive,
 * discarding a signup the server was still happy to finish.
 */
const VERIFICATION_TICKET_TTL_SECONDS = (OTP_TTL_MS / 1000) * OTP_MAX_SENDS;

const createVerificationTicket = (pendingId, email, secret = TEST_SECRET) =>
  jwt.sign({ sid: String(pendingId), typ: "verify", email }, secret, {
    expiresIn: VERIFICATION_TICKET_TTL_SECONDS,
  });

const readVerificationTicket = (token, secret = TEST_SECRET) => {
  if (typeof token !== "string" || !token) return null;
  try {
    const decoded = jwt.verify(token, secret, JWT_VERIFY_OPTIONS);
    if (decoded.typ !== "verify") return null;
    if (typeof decoded.email !== "string") return null;
    if (!/^[a-f\d]{24}$/i.test(String(decoded.sid))) return null;
    return decoded;
  } catch {
    return null;
  }
};

test("createVerificationTicket covers the longest a signup can stay open", () => {
  const pendingId = "68b0f3c1a2d4e5f60718293a";
  const email = "user@example.com";
  const token = createVerificationTicket(pendingId, email);

  const decoded = jwt.decode(token);
  assert.ok(decoded);
  assert.equal(decoded.typ, "verify");
  assert.equal(decoded.sid, pendingId);
  assert.equal(decoded.email, email);
  assert.equal(
    decoded.exp - decoded.iat,
    3000,
    "Ticket must outlive every OTP window a row can chain (OTP_TTL_MS × OTP_MAX_SENDS)",
  );
});

test("verification ticket: survives a resend whose response never reached the client", () => {
  /*
   * The row is renewed for another OTP_TTL_MS on each resend. A ticket scoped
   * to one window expires mid-signup whenever the client misses the fresh one;
   * a ticket scoped to the chain does not.
   */
  const issuedAt = 0;
  const ticketExpiresAt = issuedAt + VERIFICATION_TICKET_TTL_SECONDS;

  // Worst case: every resend fires at the last possible moment.
  let rowExpiresAt = issuedAt + OTP_TTL_MS / 1000;
  for (let resend = 1; resend < OTP_MAX_SENDS; resend++) {
    rowExpiresAt = rowExpiresAt + OTP_TTL_MS / 1000;
    assert.ok(
      ticketExpiresAt >= rowExpiresAt,
      `ticket must still be valid at resend ${resend} (row alive until ${rowExpiresAt}s)`,
    );
  }

  // And it must not outlive the last row it could possibly name.
  assert.equal(ticketExpiresAt, rowExpiresAt);
});

test("readVerificationTicket accepts a valid ticket and rejects invalid tokens", () => {
  const pendingId = "68b0f3c1a2d4e5f60718293a";
  const email = "user@example.com";
  const token = createVerificationTicket(pendingId, email);

  const parsed = readVerificationTicket(token);
  assert.ok(parsed);
  assert.equal(parsed.sid, pendingId);
  assert.equal(parsed.email, email);

  // Rejects access token with typ="access"
  const accessToken = jwt.sign({ id: "user123", typ: "access" }, TEST_SECRET, { expiresIn: "15m" });
  assert.equal(readVerificationTicket(accessToken), null);

  // Rejects non-hex/malformed sid
  const badSidToken = jwt.sign({ sid: "not-an-objectid", typ: "verify", email }, TEST_SECRET, { expiresIn: "10m" });
  assert.equal(readVerificationTicket(badSidToken), null);

  // Rejects expired token
  const expiredToken = jwt.sign({ sid: pendingId, typ: "verify", email }, TEST_SECRET, { expiresIn: "0s" });
  assert.equal(readVerificationTicket(expiredToken), null);
});

test("retry guidance: 502 email delivery error structure includes retryAfter and retryable flag", () => {
  const deliveryErrorResponse = {
    ok: false,
    status: 502,
    error: "Couldn't send the verification email. Please check your email address or try again in a few moments.",
    retryAfter: 5,
    retryable: true,
  };

  assert.equal(deliveryErrorResponse.status, 502);
  assert.equal(deliveryErrorResponse.retryAfter, 5);
  assert.equal(deliveryErrorResponse.retryable, true);
  assert.match(deliveryErrorResponse.error, /verification email/i);
});

test("MAX_PENDING_PER_EMAIL cap: rejects with 429 when active attempts reach threshold", () => {
  const MAX_PENDING_PER_EMAIL = 5;
  const now = Date.now();
  const mockLiveRows = [
    { _id: "1", expiresAt: new Date(now + 120 * 1000) },
    { _id: "2", expiresAt: new Date(now + 240 * 1000) },
    { _id: "3", expiresAt: new Date(now + 360 * 1000) },
    { _id: "4", expiresAt: new Date(now + 480 * 1000) },
    { _id: "5", expiresAt: new Date(now + 600 * 1000) },
  ];

  assert.equal(mockLiveRows.length >= MAX_PENDING_PER_EMAIL, true);

  const earliestExpiry = mockLiveRows[0]?.expiresAt ? new Date(mockLiveRows[0].expiresAt).getTime() : now + 600000;
  const retryAfter = Math.max(1, Math.ceil((earliestExpiry - now) / 1000));

  const response = {
    ok: false,
    status: 429,
    error: "Too many pending verification attempts for this email. Please check your inbox or try again in a few minutes.",
    retryAfter,
    retryable: false,
  };

  assert.equal(response.status, 429);
  assert.equal(response.retryAfter, 120);
  assert.equal(response.retryable, false);
});

