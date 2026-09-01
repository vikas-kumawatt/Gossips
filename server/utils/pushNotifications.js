import UserSession from "../models/UserSession.js";
import { resolveFirebaseCredential } from "./firebaseAdmin.js";

/**
 * Push delivery.
 *
 * `sendPushNotification` was a `console.log` — so muting a chat, which is
 * checked immediately before it, had no observable effect whatsoever, and
 * group messages never reached it at all because the group send path didn't
 * call it. Both halves of "mute" were therefore untestable.
 *
 * This is the real path: resolve the recipient's registered device tokens from
 * UserSession, hand them to FCM, and prune the ones FCM reports as dead.
 *
 * **Inert until credentials are configured**, and it says which are missing rather
 * than failing quietly.
 *
 * The message body is deliberately *not* logged. The old stub logged the whole
 * notification, which meant every DM to an offline user was written in
 * plaintext to stdout — a searchable copy of private messages outside the
 * database, on a model that goes out of its way to drop IP addresses as PII.
 */

let messaging = null;
let initialised = false;
let warned = false;

/**
 * Get the Messaging client, initialising firebase-admin if nobody else has.
 *
 * Two sources, in this order, because the app already had credentials in the second
 * form and this used to ignore them:
 *
 *   1. **An app somebody else already initialised.** `controllers/authController.js`
 *      calls `admin.initializeApp()` at module scope to verify Google sign-in tokens,
 *      using the same service account. This function used to `return null` on a
 *      missing `FIREBASE_SERVICE_ACCOUNT` *before* looking — so push reported itself
 *      disabled while a fully credentialed default app sat in the same process.
 *   2. **`resolveFirebaseCredential()`**, which understands every env shape the
 *      project accepts. It lives in utils/firebaseAdmin.js rather than here
 *      because auth needs the same answer, and the copy it kept instead
 *      recognised fewer shapes — reproducing the bug in (1) in reverse.
 *
 * Either is enough.
 */
const init = async () => {
  if (initialised) return messaging;
  initialised = true;

  try {
    const admin = (await import("firebase-admin")).default;

    /*
     * `admin.app()` throws when there is no default app, which is the documented way
     * to ask — and it's stable across firebase-admin majors, unlike `admin.apps`.
     */
    let existing = null;
    try {
      existing = admin.app();
    } catch {
      existing = null;
    }
    if (existing) {
      messaging = admin.messaging();
      return messaging;
    }

    const credential = resolveFirebaseCredential();
    if (!credential) return null;

    admin.initializeApp({ credential: admin.credential.cert(credential) });
    messaging = admin.messaging();
  } catch (error) {
    console.error("Push: failed to initialise firebase-admin:", error.message);
    messaging = null;
  }
  return messaging;
};

/*
 * `resolveCredential` used to live here, and was the only place that understood
 * all three env shapes — `authController` had its own narrower copy, so the two
 * disagreed about whether Firebase was configured. Both now read the shared
 * resolver in utils/firebaseAdmin.js.
 */

/**
 * Live push tokens for a user, split by platform.
 *
 * The split matters because web and native need *different payloads*, not just
 * different formatting. On the web, a message carrying a `notification` key is
 * displayed by the FCM SDK itself — and the service worker's
 * `onBackgroundMessage` also fires, so the user gets the same message twice, once
 * from the browser and once from our own `showNotification`. Native platforms are
 * the opposite: they need `notification` for the OS to draw anything at all when the
 * app isn't running.
 *
 * So web tokens get data-only and let `public/firebase-messaging-sw.js` draw it —
 * which is also what gives collapse-per-conversation and tap-to-the-right-thread —
 * and native tokens get both.
 */
const tokensFor = async (userId) => {
  const sessions = await UserSession.find({
    user: userId,
    revokedAt: null,
    "push.token": { $exists: true, $ne: null },
  })
    .select("push.token push.platform")
    .lean();

  const web = new Set();
  const native = new Set();
  for (const session of sessions) {
    const token = session.push?.token;
    if (!token) continue;
    // Unknown platform is treated as native: it gets a `notification` key, so the
    // worst case is the platform's own banner rather than silence.
    if (session.push?.platform === "web") web.add(token);
    else native.add(token);
  }
  return { web: [...web], native: [...native] };
};

/**
 * @param recipient    a user document or id
 * @param notification { title, body, data }
 */
export const sendPushNotification = async (recipient, notification) => {
  const userId = recipient?._id ?? recipient;
  if (!userId) {
    console.warn("Push: called with no recipient");
    return { sent: 0 };
  }

  const client = await init();
  if (!client) {
    if (!warned) {
      warned = true;
      // Names every accepted shape, not just one: the old message named only
      // FIREBASE_SERVICE_ACCOUNT, which sent people looking for a variable they
      // didn't need while the three they *did* have were being ignored.
      console.warn(
        "Push: no Firebase credentials — notifications are disabled. Set either " +
          "FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL, or " +
          "FIREBASE_SERVICE_ACCOUNT (the JSON, or a path to it)."
      );
    }
    return { sent: 0, disabled: true };
  }

  /*
   * Every outcome below is logged, including the boring ones.
   *
   * This function had four exits and only one of them said anything, so a
   * configured-but-not-delivering setup was undebuggable: no log meant "no tokens",
   * "sent successfully" or "recipient had none" and there was no way to tell which.
   * It only runs when the recipient has no live socket, so it is not a hot path and one
   * line per notification is worth the certainty. Ids only — never the body.
   */
  const { web, native } = await tokensFor(userId);
  if (!web.length && !native.length) {
    console.log("Push: no registered devices", { to: userId.toString() });
    return { sent: 0 };
  }

  try {
    // Everything the client needs to draw the banner and route the tap. FCM requires
    // every data value to be a string; the web worker reads title and body from here
    // because its payload carries no `notification` key.
    const data = Object.fromEntries(
      Object.entries({
        ...(notification.data ?? {}),
        title: notification.title ?? "",
        body: notification.body ?? "",
      }).map(([k, v]) => [k, String(v)])
    );

    /*
     * Urgency, which nothing here previously expressed.
     *
     * Every push went out at default priority, and a *data-only* message at default
     * priority is explicitly deferrable — Android holds it for Doze and App Standby,
     * and browsers batch it. That is fine for a chat message and useless for a ringing
     * call, which is worthless the moment it stops ringing.
     *
     * So `urgent` raises the priority on all three transports and `ttlSeconds` tells
     * the network to *drop* rather than deliver late: a call notification arriving
     * after the caller has given up is worse than no notification at all.
     */
    const { urgent = false, ttlSeconds } = notification;
    const ttlMs = Number.isFinite(ttlSeconds) ? Math.max(0, ttlSeconds) * 1000 : undefined;

    const priority = urgent
      ? {
          android: {
            priority: "high",
            ...(ttlMs !== undefined ? { ttl: ttlMs } : {}),
          },
          apns: {
            headers: {
              "apns-priority": "10",
              ...(Number.isFinite(ttlSeconds)
                ? { "apns-expiration": String(Math.floor(Date.now() / 1000) + ttlSeconds) }
                : {}),
            },
          },
          webpush: {
            headers: {
              Urgency: "high",
              ...(Number.isFinite(ttlSeconds) ? { TTL: String(ttlSeconds) } : {}),
            },
          },
        }
      : {};

    const sends = [];
    if (web.length) {
      sends.push(
        client.sendEachForMulticast({
          tokens: web,
          data,
          ...(priority.webpush ? { webpush: priority.webpush } : {}),
        })
      );
    }
    if (native.length) {
      sends.push(
        client.sendEachForMulticast({
          tokens: native,
          notification: { title: notification.title, body: notification.body },
          data,
          ...(priority.android ? { android: priority.android } : {}),
          ...(priority.apns ? { apns: priority.apns } : {}),
        })
      );
    }

    const responses = await Promise.all(sends);
    const batches = [
      ...(web.length ? [{ tokens: web, response: responses.shift() }] : []),
      ...(native.length ? [{ tokens: native, response: responses.shift() }] : []),
    ];

    const failures = batches.flatMap(({ tokens, response }) =>
      response.responses
        .map((r, i) => (r.success ? null : { token: tokens[i], code: r.error?.code }))
        .filter(Boolean)
    );

    /*
     * Per-token failures are logged, because they don't throw.
     *
     * `sendEachForMulticast` reports them in its *return value* — a rejected token is a
     * successful call with `successCount: 0`. Only the `catch` below logged anything, so
     * every delivery failure was silent, and the pruning below then removed the evidence:
     * the token vanished from the session and there was no record of why. Debugging a
     * configured-but-not-delivering setup meant guessing.
     *
     * Codes and a token prefix only. A whole token is a routable address for that
     * device and the body is the private message — neither belongs in a log, which is
     * the same rule the catch block follows.
     */
    if (failures.length) {
      console.warn("Push: delivery failed for some tokens", {
        to: userId.toString(),
        failures: failures.map((f) => ({
          code: f.code ?? "unknown",
          token: `${String(f.token).slice(0, 12)}…`,
        })),
      });
    }

    /*
     * A token that FCM reports as unregistered belongs to an app that has been
     * uninstalled or had its data cleared. Left in place it is retried on every
     * message forever, so it's cleared from the session it came from.
     *
     * Deliberately only these two codes. `mismatched-credential` and `invalid-argument`
     * mean the *server* is misconfigured, not that the device is gone, and pruning on
     * those would delete every user's token across the fleet on a bad deploy.
     */
    const dead = failures
      .filter(
        (f) =>
          f.code === "messaging/registration-token-not-registered" ||
          f.code === "messaging/invalid-registration-token"
      )
      .map((f) => f.token);

    if (dead.length) {
      await UserSession.updateMany(
        { "push.token": { $in: dead } },
        { $unset: { "push.token": "" } }
      );
    }

    /*
     * "accepted", not "sent", and the distinction cost a day of debugging.
     *
     * `successCount` means FCM took the message — it says nothing about whether the
     * browser's push service delivered it. A subscription that has gone stale is
     * dropped downstream of FCM, silently, and FCM keeps reporting success until the
     * push service eventually reports the token as unregistered, which can lag by days.
     * So a log line reading "sent" invites the reader to rule out the server and go
     * looking at the client, when the truth is that this layer cannot know.
     */
    const accepted = batches.reduce((sum, { response }) => sum + response.successCount, 0);
    console.log("Push: accepted by FCM (not proof of delivery)", {
      to: userId.toString(),
      accepted,
      web: web.length,
      native: native.length,
    });
    return { sent: accepted };
  } catch (error) {
    // Ids only — never the notification body.
    console.error("Push: send failed", {
      to: userId.toString(),
      messageId: notification?.data?.messageId,
      error: error.message,
    });
    return { sent: 0 };
  }
};

/**
 * Register the device token for the session this request belongs to.
 *
 * `UserSession.push.token` has been in the schema the whole time with nothing
 * writing it, so even a configured FCM project would have had no addresses to
 * deliver to.
 */
export const registerPushToken = async (sessionId, token, platform) => {
  if (!sessionId || typeof token !== "string" || !token.trim()) return false;
  const allowed = ["ios", "android", "web"];
  await UserSession.updateOne(
    { _id: sessionId },
    {
      $set: {
        "push.token": token.trim(),
        ...(allowed.includes(platform) ? { "push.platform": platform } : {}),
      },
    }
  );
  return true;
};

/**
 * Register a token against the session the *request* belongs to.
 *
 * `registerPushToken` above takes a session id, and nothing anywhere could supply
 * one — there was no route, so the function had no callers and `UserSession.push.token`
 * stayed empty. Even a fully configured FCM project would have had no addresses to
 * deliver to (CF30b).
 *
 * The session is resolved from the device id rather than taken from the body: a
 * client-supplied session id would let anyone point somebody else's session at their
 * own device and receive that account's notifications. `X-Device-Id` names the
 * browser and the `{user, deviceId}` pair is what UserSession is keyed on, so this
 * can only ever write to a session belonging to the caller.
 *
 * Returns the number of sessions updated, so a caller can tell "registered" from
 * "there is no session for this device" — which happens on a token issued before
 * the device id header existed.
 */
export const registerPushTokenForRequest = async (req, token, platform) => {
  const deviceId = req?.headers?.["x-device-id"];
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
    return { ok: false, reason: "device" };
  }
  if (typeof token !== "string" || !token.trim() || token.length > 4096) {
    return { ok: false, reason: "token" };
  }

  const allowed = ["ios", "android", "web"];
  const result = await UserSession.updateOne(
    { user: req.user._id, deviceId, revokedAt: null },
    {
      $set: {
        "push.token": token.trim(),
        ...(allowed.includes(platform) ? { "push.platform": platform } : {}),
      },
    }
  );

  return { ok: result.matchedCount > 0, reason: result.matchedCount ? null : "session" };
};

/**
 * Forget a device's token — sign-out, or the user revoking notification permission.
 *
 * Without this a token stayed registered after sign-out, so the next person to use
 * that browser would receive the previous account's message notifications. Dead
 * tokens are also pruned on delivery failure, but that only fires once FCM notices,
 * which can take days.
 */
export const clearPushTokenForRequest = async (req) => {
  const deviceId = req?.headers?.["x-device-id"];
  if (typeof deviceId !== "string") return false;
  await UserSession.updateOne(
    { user: req.user._id, deviceId },
    { $unset: { "push.token": "", "push.platform": "" } }
  );
  return true;
};
