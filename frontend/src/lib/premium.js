/**
 * Gossip Premium capability checks.
 *
 * Subscriptions don't exist yet. This layer exists now so that when they do,
 * turning a feature into a paid one is a one-line change here rather than a
 * hunt through components — and so nothing has to be re-plumbed at that point.
 *
 * Every gated feature starts `false` (available to everyone). Flip it to
 * `true` once billing ships and the feature becomes subscriber-only.
 */

export const PREMIUM_FEATURES = {
  /**
   * The "Follows you" badge in follower lists and on profiles — knowing who
   * follows you back, at a glance. Planned as a Premium perk; free for now.
   */
  followsYouBadge: false,
};

/**
 * Whether an account currently holds Premium.
 *
 * Written defensively against a shape that doesn't exist yet: it reads several
 * plausible fields and returns false when none are present, so it can't throw
 * or accidentally grant access before the backend has anything to say.
 */
export const isPremium = (user) => {
  if (!user) return false;
  if (user.isPremium === true) return true;
  const status = user.subscription?.status || user.premium?.status;
  return status === "active" || status === "trialing";
};

/**
 * Can this viewer use this feature right now?
 *
 * Ungated features return true for everyone, which is why call sites can adopt
 * this today without changing behaviour.
 */
export const canUsePremiumFeature = (feature, user) =>
  PREMIUM_FEATURES[feature] !== true || isPremium(user);
