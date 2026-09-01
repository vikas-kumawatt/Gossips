import UserSession from "../models/UserSession.js";

/**
 * Trusted devices — the one place trust is granted, read and withdrawn.
 *
 * A trusted device is one that has passed a two-factor challenge and been
 * explicitly remembered, and so is not challenged again until `trustedUntil`.
 * Nothing else grants it. Lives here rather than in `authController` because
 * the 2FA settings endpoints in `userController` have to withdraw it, and a
 * controller importing another controller is how import cycles start.
 *
 * The fields it manages used to default to `true` and be re-set on every token
 * issue, so every session was "trusted", nothing could be untrusted, and
 * `trustedAt` recorded the last refresh. Keeping the reads and writes together
 * in one module is what stops that drifting apart again.
 */

/*
 * How long a device stays trusted after a passed challenge.
 *
 * This is the length of the hole a trusted device opens in 2FA, so it is a
 * security parameter, not a convenience one: for the whole window, the password
 * plus this device's session is sufficient on its own. 30 days matches what the
 * large social apps offer and is short enough that a forgotten device ages out
 * without anyone having to remember it.
 */
export const TRUSTED_DEVICE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * May this device skip the second factor?
 *
 * Both halves matter: `isTrusted` can only have been set by a passed challenge,
 * and `trustedUntil` is what stops that lasting forever. Callers pass only live
 * sessions, so logging a device out — from Active Sessions, "log out other
 * devices", or a password reset, all of which delete the row — withdraws trust
 * as a side effect of ending the session.
 *
 * @param {{isTrusted?: boolean, trustedUntil?: Date|null}|null|undefined} session
 */
export const deviceIsTrusted = (session, now = new Date()) =>
  Boolean(session?.isTrusted && session.trustedUntil && new Date(session.trustedUntil) > now);

/**
 * Remember this device so the next sign-in skips the second factor.
 *
 * Only ever called once `passesTwoFactor` has returned true for this request
 * and the person asked for it. Neither condition is visible from here, so both
 * are the caller's to establish.
 */
export const trustDevice = async (userId, deviceId) => {
  if (!deviceId) return;
  const now = new Date();
  await UserSession.updateOne(
    { user: userId, deviceId, revokedAt: null },
    {
      $set: {
        isTrusted: true,
        trustedAt: now,
        trustedUntil: new Date(now.getTime() + TRUSTED_DEVICE_DURATION_MS),
      },
    },
  );
};

/**
 * Withdraw trust from every one of an account's devices.
 *
 * Called when the second factor itself changes. Without it, turning 2FA off and
 * back on — the obvious move after a suspected compromise — would leave devices
 * trusted under the *old* secret still skipping the challenge, protecting
 * nothing on exactly the devices an attacker had already used.
 *
 * Sessions are left alone: this withdraws the right to skip the second factor,
 * not the right to stay signed in.
 */
export const untrustAllDevices = (userId) =>
  UserSession.updateMany(
    { user: userId },
    { $set: { isTrusted: false, trustedAt: null, trustedUntil: null } },
  );
