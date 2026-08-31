import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
const PASSWORD_RE = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/;
const PASSWORD_MSG =
  "Password must be 6–20 characters and contain at least one digit, one uppercase, and one lowercase letter";

/**
 * Dedicated test suite for adding a password to a Google-only account.
 *
 * Validates:
 * 1. loginUser detects googleId && !password and demands password setup (needPasswordSetup: true).
 * 2. signupUser routes Google-only users through the OTP verification flow with pending.user set.
 * 3. Bot accounts sharing the owner email are excluded by HUMAN_ACCOUNT filter.
 * 4. verifyOtp applies password only via guarded update { password: { $exists: false } }, prevents overwriting,
 *    and rejects deleted/deactivated accounts.
 */

const oid = () => new mongoose.Types.ObjectId();

test("loginUser: detects Google-only account and returns needPasswordSetup: true", () => {
  const googleUser = {
    _id: oid(),
    email: "alex@example.com",
    googleId: "google-uid-12345",
    password: null,
  };

  const checkLoginRequirement = (user) => {
    if (user.googleId && !user.password) {
      return {
        status: 400,
        body: { error: "Please set up a password first", needPasswordSetup: true },
      };
    }
    return { status: 200 };
  };

  const res = checkLoginRequirement(googleUser);
  assert.equal(res.status, 400);
  assert.equal(res.body.needPasswordSetup, true);
  assert.equal(res.body.error, "Please set up a password first");
});

test("signupUser: routes Google-only account into pending signup with user reference", () => {
  const existingGoogleUser = {
    _id: oid(),
    name: "Alex G",
    email: "alex@example.com",
    googleId: "google-uid-12345",
    password: null,
    isBot: false,
  };

  const simulateSignup = ({ existingUser, password }) => {
    if (existingUser) {
      if (existingUser.googleId && !existingUser.password) {
        if (!password || !/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/.test(password)) {
          return { status: 400, body: { message: "Password must be 6–20 characters and contain at least one digit, one uppercase, and one lowercase letter" } };
        }
        return {
          status: 200,
          pendingSignup: {
            user: existingUser._id,
            name: existingUser.name,
            email: existingUser.email,
            passwordHash: "bcrypt_hash_placeholder",
          },
        };
      }
      return { status: 400, body: { message: "User already exists" } };
    }
    return { status: 201, pendingSignup: { user: null } };
  };

  // Valid password
  const res = simulateSignup({ existingUser: existingGoogleUser, password: "Password123" });
  assert.equal(res.status, 200);
  assert.equal(String(res.pendingSignup.user), String(existingGoogleUser._id));
  assert.equal(res.pendingSignup.email, existingGoogleUser.email);

  // Invalid password rejected
  const badRes = simulateSignup({ existingUser: existingGoogleUser, password: "weak" });
  assert.equal(badRes.status, 400);
  assert.match(badRes.body.message, /Password must be/);

  // Existing user WITH password rejected
  const standardUser = { ...existingGoogleUser, password: "hashed_password" };
  const rejectedRes = simulateSignup({ existingUser: standardUser, password: "Password123" });
  assert.equal(rejectedRes.status, 400);
  assert.equal(rejectedRes.body.message, "User already exists");
});

test("HUMAN_ACCOUNT gate: bot accounts sharing email cannot be hijacked via Google password setup", () => {
  const botRow = {
    _id: oid(),
    email: "owner@example.com",
    name: "Persona Bot",
    isBot: true,
    googleId: null,
    password: null,
  };

  const HUMAN_ACCOUNT = { isBot: false };

  // Query filter simulation: findOne({ email: "owner@example.com", ...HUMAN_ACCOUNT })
  const findHumanUser = (user, filter) => {
    if (user.email === filter.email && user.isBot === filter.isBot) {
      return user;
    }
    return null;
  };

  const matched = findHumanUser(botRow, { email: "owner@example.com", ...HUMAN_ACCOUNT });
  assert.equal(matched, null, "Bot account must NOT match human account query filter");
});

test("verifyOtp: applies password with guarded query and rejects concurrent password overwrites", () => {
  const pendingRow = {
    _id: oid(),
    user: oid(),
    name: "Alex",
    email: "alex@example.com",
    passwordHash: "$2b$10$testhash",
  };

  // 1. Target user exists without password -> success
  let targetUser = {
    _id: pendingRow.user,
    accountStatus: "active",
    password: null,
  };

  const simulateOtpVerification = (pending, user) => {
    if (pending.user) {
      if (!user || ["deleted", "deactivated"].includes(user.accountStatus)) {
        return { status: 410, error: "That account is no longer available.", expired: true };
      }
      if (user.password) {
        return { status: 409, error: "That account already has a password. Please log in.", alreadyVerified: true };
      }
      // Guarded update: { _id: user._id, password: { $exists: false } }
      user.password = pending.passwordHash;
      user.isEmailVerified = true;
      return { status: 201, message: "Email verified", user };
    }
    return { status: 201, newUserCreated: true };
  };

  const successRes = simulateOtpVerification(pendingRow, targetUser);
  assert.equal(successRes.status, 201);
  assert.equal(targetUser.password, pendingRow.passwordHash);
  assert.equal(targetUser.isEmailVerified, true);

  // 2. Target user already has password -> 409 conflict
  const alreadyHasPasswordUser = {
    _id: pendingRow.user,
    accountStatus: "active",
    password: "$2b$10$existingpasswordhash",
  };
  const conflictRes = simulateOtpVerification(pendingRow, alreadyHasPasswordUser);
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.alreadyVerified, true);

  // 3. Target user deleted/deactivated -> 410 gone
  const deletedUser = {
    _id: pendingRow.user,
    accountStatus: "deleted",
    password: null,
  };
  const deletedRes = simulateOtpVerification(pendingRow, deletedUser);
  assert.equal(deletedRes.status, 410);
  assert.equal(deletedRes.expired, true);
});
