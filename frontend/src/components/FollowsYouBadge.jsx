import { useContext } from "react";
import { UserContext } from "../contexts/UserContext";
import { canUsePremiumFeature } from "../lib/premium";

/**
 * "Follows you" — shown on someone who follows the signed-in account.
 *
 * Its own component for two reasons: it appears in more than one list, and it
 * is planned as a Gossip Premium perk. The gate is already wired through
 * `canUsePremiumFeature`, which returns true for everyone until the flag in
 * lib/premium.js is turned on — so nothing here changes when billing ships.
 *
 * The amber treatment is deliberate: it's the colour Premium will use
 * throughout, so the badge already reads as a paid touch rather than becoming
 * one abruptly later.
 */
const FollowsYouBadge = ({ className = "" }) => {
  const { userAuth } = useContext(UserContext);

  if (!canUsePremiumFeature("followsYouBadge", userAuth)) return null;

  return (
    <span
      // `shrink-0` so it never compresses when the username truncates beside it.
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/25 bg-gradient-to-r from-amber-400/20 via-amber-300/10 to-transparent px-2 py-[2px] text-[11px] font-semibold leading-none text-amber-200/90 ${className}`}
    >
      <span className="h-1 w-1 rounded-full bg-amber-300/80" />
      Follows you
    </span>
  );
};

export default FollowsYouBadge;
