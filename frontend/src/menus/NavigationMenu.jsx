import React, { useContext, useState } from "react";
import { Icons } from "../components/icons";
import { UserPlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { removeFromSession } from "../common/Session";
import { UserContext } from "../contexts/UserContext";
import { useNavigate } from "react-router-dom";
import ReportProblemModal from "../components/ReportProblemModal";
import AboutProfileSheet from "../components/AboutProfileSheet";
import AccountSwitcherSheet from "../components/AccountSwitcherSheet";
import { authAPI } from "../services/api";
import { getAccounts, removeAccount } from "../lib/accounts";
import { clearCachedRequestsByPrefix } from "../utils/requestCache";
import { deleteFeedCacheForUser } from "../utils/feedCache";
import { clearAllUnlockGrants } from "../services/chatUnlock";
import { disablePushNotifications } from "../services/pushNotifications";

export default function NavigationMenu() {
  const { userAuth, setUserAuth } = useContext(UserContext);
  const navigate = useNavigate();
  const [isProblemOpen, setIsProblemOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  // Only affects whether the entry is shown. The panel itself is gated by the
  // server, so a tampered role here gets a "nothing here" screen.
  const isStaff = ["admin", "super_admin"].includes(userAuth?.role);

  /**
   * Signs this account out of the device, and *forgets* it.
   *
   * The distinction matters with several accounts signed in: the others keep
   * their sessions, but this one has to become un-switchable rather than just
   * hidden — so the server drops its session row and clears its cookie, and
   * the local list drops the row. Logging back in is a password away, as it
   * should be.
   */
  const handleLogOut = async () => {
    const accountId = userAuth?.id || userAuth?._id || null;

    /*
     * Before the session is revoked, not after.
     *
     * Clearing the token needs an authenticated request, and `authAPI.logout` is what
     * takes that away. Without this the token stays registered against the revoked
     * session, so the next person to use this browser would receive the previous
     * account's message notifications — on a shared computer that is the whole of the
     * privacy problem. Best effort: a failure here must not block the sign-out.
     */
    await disablePushNotifications().catch(() => {});

    try {
      await authAPI.logout(accountId);
    } catch {
      // The cookie may already be gone. Clearing the client side regardless is
      // the safer failure: never leave someone looking signed in when they
      // asked not to be.
    }

    if (accountId) {
      removeAccount(accountId);
      /*
       * And take this account's content off the device. Caches are keyed by
       * user so nothing leaks *between* accounts, but leaving a signed-out
       * account's feed and conversations in IndexedDB on a shared computer
       * makes "logged out" a half-truth. Best effort — a failure here must not
       * stop the sign-out.
       */
      await Promise.allSettled([
        clearCachedRequestsByPrefix(`v1::${accountId}::`),
        deleteFeedCacheForUser(accountId),
      ]);
    }
    /*
     * Chat-lock grants too. They're held in sessionStorage and are not keyed by
     * account, so an unlock proved by one account would otherwise still be sitting
     * there for the next one to sign in on the same tab.
     */
    clearAllUnlockGrants();
    removeFromSession("user");
    setUserAuth({ token: null, savedPosts: [] });

    /*
     * Straight to login rather than silently becoming whoever is next in the
     * list — being signed in as an account you didn't choose is worse than an
     * extra tap.
     */
    navigate("/login");
  };

  const handleSavedPosts = () => {
    navigate("/saved");
  };

  const handleLikedPosts = () => {
    navigate("/liked");
  };

  const handleSettings = () => {
    navigate("/settings");
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div>
            <Icons.menu
              className="h-[22px] w-[22px] 
                   [stroke:#4d4d4d] 
                   hover:[stroke:#ffffff] 
                   active:[stroke:#ffffff] 
                   transform transition-all duration-150 ease-out 
                   hover:scale-100 active:scale-90 cursor-pointer"
            />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="Menu"
          align="end"
          className="shadow-xl bg-[#181818] z-[999] rounded-2xl w-[220px] mt-1 p-0 border border-neutral-700"
        >
          <DropdownMenuItem className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mt-2 cursor-pointer text-[15px] active:bg-neutral-950  text-white hover:bg-neutral-800 focus:rounded-xl outline-none">
            <span>Switch appearance</span>
            <Icons.dark />
          </DropdownMenuItem>

          <DropdownMenuItem
            className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950  text-white hover:bg-neutral-800 focus:rounded-xl outline-none"
            onClick={handleSavedPosts}
          >
            <span>Saved</span>
            <Icons.save />
          </DropdownMenuItem>

          <DropdownMenuItem
            className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950  text-white hover:bg-neutral-800 focus:rounded-xl outline-none"
            onClick={handleLikedPosts}
          >
            <span>Liked</span>
            <Icons.like className="w-5 h-5 " />
          </DropdownMenuItem>

          <DropdownMenuItem
            className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950  text-white hover:bg-neutral-800 focus:rounded-xl outline-none"
            onClick={handleSettings}
          >
            <span>Settings</span>
            <Icons.settings />
          </DropdownMenuItem>

          {/* The same panel other people see when they open "About this
              profile" on you — which is the point of it being here rather than
              somewhere private. */}
          <DropdownMenuItem
            className="flex justify-between items-center p-3 mx-2 mb-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950  text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
            onClick={() => setIsAboutOpen(true)}
          >
            <span>About</span>
            <Icons.about />
          </DropdownMenuItem>

          {isStaff && (
            <>
              <DropdownMenuSeparator className="h-[1.4px] my-0" />
              <DropdownMenuItem
                onClick={() => navigate("/admin")}
                className="flex justify-between items-center p-3 mx-2 my-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
              >
                <span>Admin panel</span>
                <Icons.shield />
              </DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator className="h-[1.4px] my-0" />

          {/* The long press on the nav avatar is the phone gesture; this is how
              you find the same thing with a mouse. */}
          <DropdownMenuItem
            onClick={() => setIsSwitcherOpen(true)}
            className="flex justify-between items-center p-3 mx-2 mt-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
          >
            <span>
              Switch account
              {getAccounts().length > 1 ? ` (${getAccounts().length})` : ""}
            </span>
            <UserPlus className="h-[18px] w-[18px]" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => setIsProblemOpen(true)}
            className="flex justify-between items-center p-3 mx-2 mt-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950   hover:bg-neutral-800 hover:rounded-xl outline-none"
          >
            <span>Report a problem</span>
            <Icons.report />
          </DropdownMenuItem>

          <DropdownMenuItem
            className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950  hover:bg-neutral-800 hover:rounded-xl outline-none text-red-500"
            onClick={handleLogOut}
          >
            <span>Log out</span>
            <Icons.logout />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ReportProblemModal
        isOpen={isProblemOpen}
        onClose={() => setIsProblemOpen(false)}
      />

      {isAboutOpen && userAuth?.username && (
        <AboutProfileSheet
          username={userAuth.username}
          onClose={() => setIsAboutOpen(false)}
        />
      )}

      {isSwitcherOpen && (
        <AccountSwitcherSheet onClose={() => setIsSwitcherOpen(false)} />
      )}
    </>
  );
}
