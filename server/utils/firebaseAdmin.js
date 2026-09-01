import { readFileSync } from "node:fs";

/**
 * Firebase Admin credentials — one answer to "is Firebase available", for
 * everything in the process that needs one.
 *
 * There are two consumers: Google sign-in (`controllers/authController.js`,
 * which verifies ID tokens) and push notifications
 * (`utils/pushNotifications.js`). They used to decide this separately and
 * disagree. Push accepted three env shapes; auth accepted one, so a deployment
 * credentialed with `FIREBASE_SERVICE_ACCOUNT` got working push and a Google
 * sign-in that answered 503 "not configured on this server" forever, next to a
 * startup warning announcing Firebase was disabled while push was using it in
 * the same process. That is the same bug the comment in `pushNotifications.js`
 * describes having fixed, pointing the other way.
 *
 * Any one of the three shapes is enough:
 *
 *   1. **`FIREBASE_PROJECT_ID` / `FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL`** —
 *      the decomposed form, which is the three fields `cert()` actually consumes
 *      and what every platform's env-var UI recommends, because a one-line JSON
 *      blob's `\n` escapes get mangled in transit.
 *   2. **`FIREBASE_SERVICE_ACCOUNT`** holding the whole JSON.
 *   3. **`FIREBASE_SERVICE_ACCOUNT`** holding a path to a file with that JSON.
 */

/**
 * Read the JSON from a path.
 *
 * `readFileSync` rather than a dynamic `import(… { type: "json" })`: the import
 * assertion form needs a file URL, breaks on a Windows path, and would make
 * this async for one of its three branches.
 */
const readCredentialFile = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * The credential object, from whichever env shape is present, or null.
 *
 * @returns {{projectId: string, privateKey: string, clientEmail: string}|object|null}
 */
export const resolveFirebaseCredential = () => {
  const { FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL } = process.env;

  if (FIREBASE_PROJECT_ID && FIREBASE_PRIVATE_KEY && FIREBASE_CLIENT_EMAIL) {
    return {
      projectId: FIREBASE_PROJECT_ID,
      /*
       * `\n` un-escaped. A private key stored in an env var almost always
       * arrives with literal backslash-n rather than real newlines, and
       * `cert()` rejects it with an opaque PEM error.
       */
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      clientEmail: FIREBASE_CLIENT_EMAIL,
    };
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;

  try {
    return raw.trim().startsWith("{") ? JSON.parse(raw) : readCredentialFile(raw);
  } catch (error) {
    console.error("Firebase: FIREBASE_SERVICE_ACCOUNT could not be read:", error.message);
    return null;
  }
};

/**
 * Why Firebase is unavailable, phrased for a startup log.
 *
 * Names all the ways it could have been configured rather than only the one the
 * operator didn't use — a warning listing three missing variables, on a box
 * where the fourth acceptable variable is set, sends people to fix the wrong
 * thing.
 */
export const describeMissingFirebaseConfig = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return "FIREBASE_SERVICE_ACCOUNT is set but could not be parsed as JSON or read as a file path";
  }
  return "set FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL, or FIREBASE_SERVICE_ACCOUNT";
};
