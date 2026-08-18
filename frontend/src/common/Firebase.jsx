
import { initializeApp } from "firebase/app";
import {getAuth, GoogleAuthProvider, signInWithPopup} from "firebase/auth"

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
  };

export const firebaseApp = initializeApp(firebaseConfig);

/**
 * Whether the project is actually configured.
 *
 * Google sign-in has always assumed it is, and the whole config comes from
 * `VITE_FIREBASE_*` — so on a deployment without them, `initializeApp` succeeds with
 * undefined values and every call fails later with an opaque error. Push registration
 * checks this instead of trying and logging a failure on every login.
 *
 * `messagingSenderId` and `appId` are the two Cloud Messaging needs.
 */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.messagingSenderId && firebaseConfig.appId && firebaseConfig.projectId
);

// google auth

/**
 * `getAuth()` is called on demand, not while this module loads.
 *
 * It used to run at module scope, and it throws `auth/invalid-api-key` when the
 * API key is missing — which is not a Google-sign-in failure, it is an exception
 * thrown during import. Nothing catches an error at that point, so React never
 * mounts and the entire app is a blank page. One absent `VITE_FIREBASE_*`
 * variable in a deploy took down the feed, chat and everything else, for a
 * feature most visitors never touch. The build smoke test is what caught it:
 * "the bundle threw while loading".
 *
 * Deferring it means an unconfigured build loads normally and only Google
 * sign-in is unavailable — which is the honest blast radius. The instances are
 * cached because `signInWithPopup` needs the same `auth` object each time.
 */
let auth = null;
let provider = null;

const googleAuth = () => {
  if (!auth) {
    auth = getAuth(firebaseApp);
    provider = new GoogleAuthProvider();
  }
  return { auth, provider };
};

export const authWithGoogle = async () => {
  /*
   * Refused before touching the SDK. Without this the caller gets
   * `auth/invalid-api-key` from inside a popup handler, which reads as "Google
   * rejected you" rather than "this deployment has no Firebase project".
   */
  if (!isFirebaseConfigured) {
    throw new Error("Google sign-in isn't configured on this deployment");
  }

  const { auth: instance, provider: googleProvider } = googleAuth();
  const result = await signInWithPopup(instance, googleProvider);
  return result.user;
};