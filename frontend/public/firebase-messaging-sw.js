/* eslint-env serviceworker */
/* global importScripts, firebase */

/**
 * The service worker that receives push notifications while the app is closed.
 *
 * In `public/` rather than `src/`, and that is a requirement rather than a
 * preference: a service worker can only control pages at or below its own path, so
 * one served from Vite's hashed `/assets/` directory could never receive a
 * notification for the app. Vite copies `public/` to the root verbatim.
 *
 * The compat SDK loaded over `importScripts`, not the modular one, for the same kind
 * of reason: a service worker is not a module in every browser that supports push,
 * and bundling it would put it back under `/assets/`. This is the shape Firebase's
 * own documentation uses and the only one that works from a static file.
 *
 * ── Configuration ────────────────────────────────────────────────────────────
 *
 * A service worker cannot read Vite's `import.meta.env`, so these four values used
 * to be typed in here as literals — which meant one specific Firebase project was
 * baked into the source, and pointing a deployment at a different one was a code
 * change to a file most people would never think to look in.
 *
 * The placeholders below are substituted from the environment by the
 * `publicFileEnv` plugin in vite.config.js: at build time it rewrites the
 * emitted file, and in dev it serves the substituted version. So this file stays
 * a plain static worker — no bundling, no module semantics — while still being
 * configured the same way as everything else.
 *
 * None of these are secrets; they are public identifiers already present in every
 * client bundle. The point is that they are configuration, not source.
 *
 * With the variables unset the placeholders survive verbatim, the guard below
 * fails, and the worker registers and receives nothing — the same
 * inert-until-configured state as the server's `FIREBASE_SERVICE_ACCOUNT` and the
 * client's `VITE_FIREBASE_VAPID_KEY`. Nothing breaks; push simply doesn't arrive.
 */
const FIREBASE_CONFIG = {
  messagingSenderId: "__VITE_FIREBASE_MESSAGING_SENDER_ID__",
  appId: "__VITE_FIREBASE_APP_ID__",
  projectId: "__VITE_FIREBASE_PROJECT_ID__",
  apiKey: "__VITE_FIREBASE_API_KEY__",
};

/*
 * An unsubstituted placeholder is not a configured value. Without this the guard
 * below would see two non-empty strings and try to initialise Firebase with
 * literal `__VITE_…__` text, which fails inside the SDK rather than here.
 */
for (const key of Object.keys(FIREBASE_CONFIG)) {
  if (/^__VITE_[A-Z0-9_]+__$/.test(FIREBASE_CONFIG[key])) FIREBASE_CONFIG[key] = "";
}

/*
 * No bare `push` listener here.
 *
 * `firebase-messaging-compat` installs its own, and that one owns display —
 * a second handler that called `showNotification` would double every banner. If you
 * need to know whether a push is arriving at all, add one temporarily that *only*
 * logs, and read it at `chrome://inspect/#service-workers` rather than in the page
 * console: a worker's logs never appear there, and when the app's window is closed the
 * worker is asleep and wakes only to handle the push.
 */
if (FIREBASE_CONFIG.messagingSenderId && FIREBASE_CONFIG.appId) {
  importScripts("https://www.gstatic.com/firebasejs/11.4.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/11.4.0/firebase-messaging-compat.js");

  firebase.initializeApp(FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  /**
   * A notification the app isn't open for.
   *
   * The server sends a `data`-only payload deliberately — see
   * `server/utils/pushNotifications.js`. A `notification` payload would make the
   * browser draw its own banner *as well* as this one, so every message would arrive
   * twice.
   */
  messaging.onBackgroundMessage((payload) => {
    const title = payload?.data?.title || "New message";
    const body = payload?.data?.body || "";
    const conversation = payload?.data?.conversation || "";
    const isCall = payload?.data?.kind === "call";

    /*
     * A ringing call is not a message.
     *
     * It is time-critical and it expires — the server gives the ring 45 seconds — so it
     * gets its own tag (never collapsed into a conversation's message thread),
     * `requireInteraction` so it stays on screen rather than auto-dismissing after a
     * few seconds, and a vibration pattern that reads as a ring rather than a ping.
     * Tapping it opens the caller's conversation, where the in-app ring UI takes over
     * if the call is still live.
     */
    const url = isCall
      ? `/chat/${payload?.data?.callerUsername || ""}`
      : payload?.data?.url || "/chat";

    self.registration.showNotification(title, {
      body,
      icon: "/pwa-192.png",
      badge: "/pwa-192.png",
      /*
       * Collapses per conversation: twenty messages from one person replace each
       * other rather than stacking twenty banners. `renotify` still buzzes for each,
       * so nothing is silently swallowed.
       */
      tag: isCall
        ? `gossips-call-${payload?.data?.callId || ""}`
        : conversation || "gossips-message",
      renotify: true,
      ...(isCall
        ? { requireInteraction: true, vibrate: [400, 200, 400, 200, 400] }
        : {}),
      data: { conversation, url },
    });
  });
}

/**
 * Focus an existing tab rather than opening another one.
 *
 * `clients.openWindow` unconditionally is the common mistake: tapping a notification
 * then leaves the user with two copies of the app, each with its own socket.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || "/chat";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if ("focus" in client) {
          // Navigating the focused tab, so the notification lands on the right
          // conversation rather than wherever the tab happened to be.
          if ("navigate" in client) await client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })()
  );
});
