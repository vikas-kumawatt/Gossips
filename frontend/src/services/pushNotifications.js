import { getMessaging, getToken, deleteToken, isSupported } from "firebase/messaging";
import { firebaseApp, isFirebaseConfigured } from "../common/Firebase";
import { userAPI } from "./api";

/**
 * The client half of push notifications.
 *
 * The server has been able to deliver since 8b and had nowhere to deliver *to*:
 * `UserSession.push.token` is what delivery reads, and nothing wrote it because there
 * was no route and no client (CF30b). `PUT /user/push-token` is the route; this is the
 * client.
 *
 * **Inert until configured**, deliberately and by the same rule the server half
 * follows: no `VITE_FIREBASE_MESSAGING_SENDER_ID` and no `VITE_FIREBASE_VAPID_KEY`
 * means every function here returns without doing anything. Registration must not
 * produce a console error on every login on a deployment that hasn't set up Firebase
 * — an inert feature is fine, a noisy one gets ignored and then missed when it breaks
 * for real.
 *
 * `firebase` was already a dependency and already initialised for Google sign-in, so
 * this adds no package. `firebase/messaging` is a separate entry point, so it only
 * enters the bundle because this module imports it.
 */

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

/*
 * The worker file lives at the root, but it is registered on a *narrow* scope.
 *
 * `public/` and an absolute path, because a worker served from Vite's hashed
 * `/assets/` directory could only ever control `/assets/`.
 *
 * The scope is the part that matters. This app already has a service worker:
 * `vite-plugin-pwa` generates one and `main.jsx` registers it at `/` with
 * `clientsClaim: true`. Two workers cannot both control one scope — the later
 * registration replaces the earlier for that scope — so registering this one at `/`
 * meant the two fought over it, workbox won, and FCM was left delivering to a
 * registration that no longer existed. `getToken` still succeeded, because it was
 * handed this registration explicitly, so every layer reported success and no
 * notification appeared. Latent locally — `vite-plugin-pwa` only generates its worker
 * in a production build — which is the worst shape for a bug to have.
 *
 * `/firebase-cloud-messaging-push-scope` is the scope the FCM SDK uses by default when
 * you *don't* pass a registration, and it exists precisely to avoid this collision. A
 * worker receives push events for any subscription it owns whether or not it controls a
 * page, so a narrow scope costs nothing — and `notificationclick` in the worker already
 * passes `includeUncontrolled: true`, which is what lets it still find and focus the
 * app's windows from outside its own scope.
 */
const SERVICE_WORKER_PATH = "/firebase-messaging-sw.js";
const SERVICE_WORKER_SCOPE = "/firebase-cloud-messaging-push-scope";

/**
 * Whether push can work here at all — exported so a settings screen can hide the
 * control rather than offer one that cannot do anything.
 */
export const isPushAvailable = () => available();

/** Everything that has to be true before a token can be asked for. */
const available = async () => {
  if (!isFirebaseConfigured || !VAPID_KEY) return false;
  // Safari before 16.4, and any browser in a context without a secure origin.
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return false;
  try {
    return await isSupported();
  } catch {
    return false;
  }
};

/**
 * Register this device, if the user has already granted permission.
 *
 * Deliberately does *not* prompt. A permission prompt fired on login is the pattern
 * every browser now penalises and every user dismisses — and a dismissed prompt is
 * permanent for the origin, so asking at the wrong moment costs the feature
 * outright. `enablePushNotifications` below is the version that asks, for a settings
 * toggle to call.
 *
 * Safe to call on every login: FCM returns the existing token rather than minting a
 * new one, and the server upsert is idempotent.
 */
export const syncPushRegistration = async () => {
  try {
    if (!(await available())) return { registered: false, reason: "unsupported" };
    if (Notification.permission !== "granted") {
      return { registered: false, reason: "permission" };
    }
    return await register();
  } catch (error) {
    // Never throws at the caller: this runs during login, and a notification problem
    // must not be able to fail a sign-in.
    console.error("Push registration failed:", error);
    return { registered: false, reason: "error" };
  }
};

/**
 * Ask for permission and register. For a user-initiated action only.
 *
 * @returns `{ registered, reason }` — `reason` is "denied" when the user said no,
 *   which the caller should treat as final rather than retrying.
 */
export const enablePushNotifications = async () => {
  try {
    if (!(await available())) return { registered: false, reason: "unsupported" };

    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    if (permission !== "granted") return { registered: false, reason: "denied" };

    /*
     * Deliberately re-subscribing from scratch.
     *
     * This is the *user asking for it*, which is exactly the moment to distrust
     * whatever is cached: they are usually here because it isn't working. Dropping the
     * existing subscription first makes `getToken` mint a genuinely new one instead of
     * handing back a token bound to a worker registration that may no longer exist.
     * `syncPushRegistration` on login does not do this — it runs on every load and
     * churning the subscription there would be gratuitous.
     */
    await dropSubscription();
    return await register();
  } catch (error) {
    console.error("Enabling push failed:", error);
    return { registered: false, reason: "error" };
  }
};

/**
 * Resolve once *this* registration's worker is active.
 *
 * Not `navigator.serviceWorker.ready`: that resolves for the registration controlling
 * the current page, which here is the workbox worker at `/` — so it would return
 * immediately and tell us nothing about ours.
 *
 * `register()` resolves as soon as the registration exists, which can be while the
 * worker is still installing, and a push subscription created against an installing
 * worker is a race. It usually wins; when it doesn't, the symptom is a token FCM accepts
 * and nothing receives — indistinguishable from the scope bug above and just as slow to
 * track down.
 */
const whenActive = (registration) =>
  new Promise((resolve) => {
    if (registration.active) return resolve();
    const worker = registration.installing || registration.waiting;
    if (!worker) return resolve();
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
    });
    // Don't hang the registration on a worker that never activates — a token attempt
    // that fails is recoverable, a promise that never settles is not.
    setTimeout(resolve, 5000);
  });

const register = async () => {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH, {
    scope: SERVICE_WORKER_SCOPE,
  });
  await whenActive(registration);
  const messaging = getMessaging(firebaseApp);
  const token = await getToken(messaging, {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: registration,
  });
  if (!token) return { registered: false, reason: "no-token" };

  const result = await userAPI.setPushToken(token, "web");
  return { registered: Boolean(result?.registered), reason: result?.reason ?? null };
};

/**
 * Stop delivering to this device.
 *
 * Both halves: the token is deleted at FCM *and* cleared on the server. Doing only
 * the second leaves FCM sending to a token nothing will read; doing only the first
 * leaves the server delivering to a dead address until FCM reports it as such, which
 * can take days.
 *
 * Called on sign-out, so the next person to use this browser doesn't receive the
 * previous account's message notifications.
 */
/**
 * Throw away the browser's own push subscription, not just the token record.
 *
 * `deleteToken` alone is not enough, and this is why toggling the setting off and on
 * could not recover a broken registration: `getToken` returns a *cached* token when one
 * exists for the (app, VAPID key, worker) tuple, and `deleteToken` looks that tuple up
 * through the default registration — so after the worker's scope changed it could no
 * longer find the token bound to the old one. Off-then-on handed back the same dead
 * token indefinitely, while FCM reported every send as successful because a stale
 * subscription is dropped by the push service, not by FCM.
 *
 * Unsubscribing at the PushManager is the part that cannot be cached around. Best
 * effort throughout: this runs on sign-out and on the way to a fresh registration, and
 * a failure to tidy up must not block either.
 */
const dropSubscription = async () => {
  try {
    const registration = await navigator.serviceWorker.getRegistration(
      SERVICE_WORKER_SCOPE
    );
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch (error) {
    console.error("Push: could not drop the existing subscription:", error);
  }
};

export const disablePushNotifications = async () => {
  try {
    // The server first, and unconditionally — it is the half that matters for
    // privacy, and it must happen even if the FCM call fails.
    await userAPI.clearPushToken().catch(() => {});
    if (!(await available())) return;
    const messaging = getMessaging(firebaseApp);
    await deleteToken(messaging).catch(() => {});
    // The subscription too — see dropSubscription for why deleteToken isn't enough.
    await dropSubscription();
  } catch (error) {
    console.error("Disabling push failed:", error);
  }
};
