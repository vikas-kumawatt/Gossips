import test from "node:test";
import assert from "node:assert/strict";

import { OTP_LENGTH, OTP_RE, generateOtp, hashOtp, otpMatches } from "../utils/otp.js";

const SECRET = "test-secret-not-a-real-one";
const OTHER_SECRET = "a-different-secret";
const ROW = "68b0f3c1a2d4e5f60718293a";

test("generateOtp always produces exactly OTP_LENGTH digits", () => {
  for (let i = 0; i < 2000; i += 1) {
    const code = generateOtp();
    assert.equal(code.length, OTP_LENGTH, `got ${JSON.stringify(code)}`);
    assert.ok(OTP_RE.test(code), `got ${JSON.stringify(code)}`);
  }
});

/*
 * The padding is the whole point of this one. `String(randomInt(0, 1e6))` drops
 * leading zeros, so without `padStart` roughly one code in ten is short — "042931"
 * arrives as "42931", fails the six-digit check on the way in, and the user is told
 * their correct code is wrong. That is a bug you only see 10% of the time, which is
 * exactly the kind that reaches production.
 */
test("generateOtp pads codes that would otherwise be short", () => {
  const codes = Array.from({ length: 20000 }, generateOtp);
  const padded = codes.filter((code) => code.startsWith("0"));
  assert.ok(padded.length > 0, "20k draws produced no code below 100000 — suspicious");
  for (const code of padded) assert.equal(code.length, OTP_LENGTH);
});

test("generateOtp covers the range rather than clustering", () => {
  // A generator biased by `% 1e6` or truncated to five digits would fail this.
  const seen = new Set(Array.from({ length: 5000 }, generateOtp));
  assert.ok(seen.size > 4500, `only ${seen.size} distinct codes in 5000 draws`);

  const buckets = new Array(10).fill(0);
  for (const code of seen) buckets[Number(code[0])] += 1;
  for (const [digit, count] of buckets.entries()) {
    assert.ok(count > 0, `no code ever started with ${digit}`);
  }
});

test("hashOtp is deterministic and does not reveal the code", () => {
  const hash = hashOtp(SECRET, ROW, "123456");
  assert.equal(hash, hashOtp(SECRET, ROW, "123456"));
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(!hash.includes("123456"));
});

test("hashOtp separates codes, rows and secrets", () => {
  const base = hashOtp(SECRET, ROW, "123456");

  // A different code must not collide.
  assert.notEqual(base, hashOtp(SECRET, ROW, "123457"));

  /*
   * The binding that matters: a hash read out of one pending signup must not
   * verify against another. Without the row id in the message, every row that
   * happened to draw the same code would share a hash, and an attacker who
   * learned one code would know it for every signup in flight.
   */
  assert.notEqual(base, hashOtp(SECRET, "68b0f3c1a2d4e5f60718293b", "123456"));

  // And rotating the secret must invalidate it.
  assert.notEqual(base, hashOtp(OTHER_SECRET, ROW, "123456"));
});

/*
 * Domain separation. `otp:v1:<row>:<code>` must not be forgeable by choosing a row
 * id that swallows the delimiter — if the prefix were just `<row><code>`, then row
 * "abc" with code "123456" and row "abc123" with code "456" would hash identically.
 */
test("hashOtp cannot be confused by a row id containing the delimiter", () => {
  assert.notEqual(hashOtp(SECRET, "abc", "123456"), hashOtp(SECRET, "abc:123", "456"));
});

test("otpMatches accepts an identical hash and rejects anything else", () => {
  const hash = hashOtp(SECRET, ROW, "123456");

  assert.equal(otpMatches(hash, hash), true);
  assert.equal(otpMatches(hash, hashOtp(SECRET, ROW, "123456")), true);
  assert.equal(otpMatches(hash, hashOtp(SECRET, ROW, "654321")), false);
});

/*
 * `crypto.timingSafeEqual` throws on a length mismatch rather than returning false.
 * An unhandled throw here would surface as a 500 from the verify endpoint — which
 * is both an availability bug and an oracle, since a wrong-length stored hash would
 * be distinguishable from a wrong code.
 */
test("otpMatches returns false rather than throwing on a length mismatch", () => {
  const hash = hashOtp(SECRET, ROW, "123456");

  assert.equal(otpMatches(hash, "short"), false);
  assert.equal(otpMatches("", hash), false);
  assert.equal(otpMatches(hash, `${hash}extra`), false);
});

test("otpMatches tolerates non-string stored values without throwing", () => {
  // A legacy or hand-edited row could hold anything; this must fail closed.
  assert.equal(otpMatches(undefined, hashOtp(SECRET, ROW, "123456")), false);
  assert.equal(otpMatches(null, hashOtp(SECRET, ROW, "123456")), false);
});

test("OTP_RE accepts only a bare six-digit string", () => {
  assert.ok(OTP_RE.test("000000"));
  assert.ok(OTP_RE.test("947213"));

  for (const bad of ["12345", "1234567", "12345a", "", " 123456", "123456 ", "12 3456", "-12345"]) {
    assert.equal(OTP_RE.test(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});
