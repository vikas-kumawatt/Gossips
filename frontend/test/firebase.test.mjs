import assert from "node:assert/strict";
import test from "node:test";

/**
 * Importing this module must never throw, however the deployment is configured.
 *
 * `getAuth()` used to run at module scope, and it throws `auth/invalid-api-key`
 * when the key is absent. An exception during import is not caught by anything —
 * React never mounts and every route is a blank page. So one missing
 * `VITE_FIREBASE_*` variable took down the feed, chat, search and settings, for
 * a sign-in method most visitors never use.
 *
 * `test-support/jsx-hooks.mjs` defines `import.meta.env` without any
 * `VITE_FIREBASE_*` keys, so these tests run under exactly that condition.
 */

test("the module imports cleanly with no Firebase configuration", async () => {
  // The assertion is that this line does not throw.
  const firebase = await import("../src/common/Firebase.jsx");

  assert.equal(typeof firebase.authWithGoogle, "function");
  assert.equal(firebase.isFirebaseConfigured, false);
});

test("an unconfigured deployment refuses Google sign-in with a legible reason", async () => {
  const { authWithGoogle } = await import("../src/common/Firebase.jsx");

  await assert.rejects(
    () => authWithGoogle(),
    /isn't configured/,
    "should refuse before touching the SDK, rather than surfacing auth/invalid-api-key"
  );
});

test("isFirebaseConfigured governs push registration too", async () => {
  /*
   * `services/pushNotifications.js` reads the same flag rather than trying and
   * logging a failure per login, so it must also survive an unconfigured import.
   */
  const push = await import("../src/services/pushNotifications.js");
  assert.equal(typeof push.isPushAvailable, "function");
});
