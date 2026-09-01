import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFirebaseCredential,
  describeMissingFirebaseConfig,
} from "../utils/firebaseAdmin.js";

/**
 * The real resolver, driven through every env shape the project accepts.
 *
 * This is the whole point of the module: auth and push each used to decide
 * "is Firebase configured" for themselves, and auth's answer recognised fewer
 * shapes. A deployment credentialed with `FIREBASE_SERVICE_ACCOUNT` therefore
 * had working push notifications and a Google sign-in permanently answering
 * 503 "not configured on this server".
 */

const FIREBASE_ENV = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_SERVICE_ACCOUNT",
];

/** Run `fn` with exactly `env` set, restoring whatever was there before. */
const withEnv = (env, fn) => {
  const saved = Object.fromEntries(FIREBASE_ENV.map((key) => [key, process.env[key]]));
  try {
    for (const key of FIREBASE_ENV) delete process.env[key];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const key of FIREBASE_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const SERVICE_ACCOUNT = {
  project_id: "gossips-test",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  client_email: "sa@gossips-test.iam.gserviceaccount.com",
};

test("credentials: the decomposed env shape resolves", () => {
  const credential = withEnv(
    {
      FIREBASE_PROJECT_ID: "gossips-test",
      FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
      FIREBASE_CLIENT_EMAIL: "sa@gossips-test.iam.gserviceaccount.com",
    },
    resolveFirebaseCredential,
  );

  assert.ok(credential);
  assert.equal(credential.projectId, "gossips-test");
  assert.equal(credential.clientEmail, "sa@gossips-test.iam.gserviceaccount.com");
});

test("credentials: escaped newlines in the private key are un-escaped", () => {
  // `cert()` rejects a key with literal backslash-n with an opaque PEM error,
  // and that is how nearly every platform's env-var UI stores it.
  const credential = withEnv(
    {
      FIREBASE_PROJECT_ID: "p",
      FIREBASE_PRIVATE_KEY: "line1\\nline2",
      FIREBASE_CLIENT_EMAIL: "e@example.com",
    },
    resolveFirebaseCredential,
  );

  assert.equal(credential.privateKey, "line1\nline2");
  assert.ok(!credential.privateKey.includes("\\n"));
});

test("credentials: FIREBASE_SERVICE_ACCOUNT as inline JSON resolves", () => {
  const credential = withEnv(
    { FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SERVICE_ACCOUNT) },
    resolveFirebaseCredential,
  );

  assert.ok(credential, "this shape used to leave Google sign-in reporting 503 forever");
  assert.equal(credential.project_id, "gossips-test");
});

test("credentials: FIREBASE_SERVICE_ACCOUNT as a file path resolves", () => {
  const dir = mkdtempSync(join(tmpdir(), "gossips-fb-"));
  const path = join(dir, "service-account.json");
  writeFileSync(path, JSON.stringify(SERVICE_ACCOUNT));

  const credential = withEnv({ FIREBASE_SERVICE_ACCOUNT: path }, resolveFirebaseCredential);

  assert.ok(credential);
  assert.equal(credential.client_email, SERVICE_ACCOUNT.client_email);
});

test("credentials: the decomposed shape wins when both are present", () => {
  const credential = withEnv(
    {
      FIREBASE_PROJECT_ID: "decomposed",
      FIREBASE_PRIVATE_KEY: "k",
      FIREBASE_CLIENT_EMAIL: "e@example.com",
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SERVICE_ACCOUNT),
    },
    resolveFirebaseCredential,
  );

  assert.equal(credential.projectId, "decomposed");
});

test("credentials: a partial decomposed shape does not resolve", () => {
  const credential = withEnv(
    { FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "e@example.com" },
    resolveFirebaseCredential,
  );
  assert.equal(credential, null);
});

test("credentials: nothing configured resolves to null rather than throwing", () => {
  assert.equal(withEnv({}, resolveFirebaseCredential), null);
});

test("credentials: unreadable FIREBASE_SERVICE_ACCOUNT returns null rather than throwing", () => {
  // Startup must not crash on a malformed value — the rest of auth works fine
  // without Firebase, and only Google sign-in should be lost.
  assert.equal(
    withEnv({ FIREBASE_SERVICE_ACCOUNT: "{not json" }, resolveFirebaseCredential),
    null,
  );
  assert.equal(
    withEnv({ FIREBASE_SERVICE_ACCOUNT: "/no/such/file.json" }, resolveFirebaseCredential),
    null,
  );
});

test("credentials: the startup warning names every accepted shape", () => {
  const message = withEnv({}, describeMissingFirebaseConfig);

  for (const shape of [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_SERVICE_ACCOUNT",
  ]) {
    assert.match(message, new RegExp(shape));
  }
});

test("credentials: a set-but-broken FIREBASE_SERVICE_ACCOUNT is diagnosed as such", () => {
  // Listing three missing variables on a box where the fourth acceptable one is
  // set sends the operator to fix the wrong thing.
  const message = withEnv({ FIREBASE_SERVICE_ACCOUNT: "{not json" }, describeMissingFirebaseConfig);
  assert.match(message, /could not be parsed/i);
});
