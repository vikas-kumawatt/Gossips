import React, { useContext, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Icons } from "./icons";
import { UserContext } from "../contexts/UserContext";
import { useNavigate } from "react-router-dom";
import AccountSwitcherSheet from "./AccountSwitcherSheet";
import { useLongPress } from "../hooks/useLongPress";

export default function Navigation({ layoutContext }) {
  const location = useLocation();
  const path = location.pathname;
  const { userAuth, unreadNotificationCount } = useContext(UserContext);
  const navigate = useNavigate();
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);

  /*
   * Long press on your own avatar opens the switcher — the Instagram gesture.
   * The hook also swallows the click that ends the press, so the nav doesn't
   * navigate to the profile behind the sheet that just opened.
   */
  const { handlers: longPressHandlers, consumeClick } = useLongPress(() =>
    setIsSwitcherOpen(true)
  );

  const profilePath = `/${userAuth?.username || "profile"}`;
  const isOwnProfile = path === profilePath;

  const openCreateModal =
    layoutContext?.openCreateModal ||
    (() => {
      console.warn(
        "openCreateModal function not provided to Navigation component"
      );
    });

  const refetchPosts =
    layoutContext?.refetchPosts || (() => {});

  const handleHomeClick = (e) => {
    e.preventDefault();
    if (path !== "/") {
      navigate("/");
    }
    refetchPosts();
    window.scrollTo(0, 0);
  };

  const handleActivityClick = (e) => {
    e.preventDefault();
    if (path !== "/activity") {
      navigate("/activity");
    }
  };

  return (
    <>
      <Link
        to="/"
        onClick={handleHomeClick}
        className="hover:bg-zinc-800 p-4 sm:py-5 sm:px-8 rounded-lg transform transition-all duration-150 ease-out hover:scale-100 active:scale-90 flex items-center justify-center w-full"
      >
        <Icons.home
          className="h-[26px] w-[26px] text-lg"
          strokeColor={path === "/" ? "white" : "#4d4d4d"}
          fill={path === "/" ? "White" : "transparent"}
        />
      </Link>

      <Link
        to="/search"
        className="hover:bg-zinc-800 p-4 sm:py-5 sm:px-8 rounded-lg transform transition-all duration-150 ease-out hover:scale-100 active:scale-90 flex items-center justify-center w-full"
      >
        <Icons.search
          className="h-6 w-6 text-lg"
          strokeColor={path === "/search" ? "white" : "#4d4d4d"}
        />
      </Link>

      <button
        onClick={openCreateModal}
        className="hover:bg-zinc-800 p-4 sm:py-5 sm:px-8 rounded-lg transform transition-all duration-150 ease-out hover:scale-100 active:scale-90 flex items-center justify-center w-full"
      >
        <Icons.create
          className="h-6 w-6 text-lg"
          strokeColor={path === "/create" ? "white" : "#4d4d4d"}
          fill={path === "/create" ? "White" : "transparent"}
        />
      </button>

      <Link
        to="/activity"
        onClick={handleActivityClick}
        className="hover:bg-zinc-800 p-4 sm:py-5 sm:px-8 rounded-lg transform transition-all duration-150 ease-out hover:scale-100 active:scale-90 flex items-center justify-center w-full"
      >
        <span className="relative flex items-center justify-center">
          {unreadNotificationCount > 0 ? (
            <Icons.unread
              className="h-[28px] w-[28px] text-lg"
              strokeColor={path === "/activity" ? "white" : "#4d4d4d"}
              fill={path === "/activity" ? "white" : "transparent"}
            />
          ) : (
            <Icons.activity
              className="h-[26px] w-[26px] text-lg"
              strokeColor={path === "/activity" ? "white" : "#4d4d4d"}
              fill={path === "/activity" ? "white" : "transparent"}
            />
          )}
          {/* The count-swapped icon alone is too subtle — both states are a
              bell of the same weight. The dot is the part people look for. */}
          {unreadNotificationCount > 0 && (
            <span
              role="status"
              aria-label={`${unreadNotificationCount} unread notifications`}
              className="absolute -right-1 -top-0.5 min-w-[9px] h-[9px] rounded-full bg-rose-500 ring-2 ring-neutral-950"
            />
          )}
        </span>
      </Link>

      <Link
        to={profilePath}
        {...longPressHandlers}
        onClick={consumeClick}
        aria-label="Your profile. Press and hold to switch account."
        className="hover:bg-zinc-800 p-4 sm:py-5 sm:px-8 rounded-lg transform transition-all duration-150 ease-out hover:scale-100 active:scale-90 flex items-center justify-center w-full"
      >
        {/*
          Your own face on phones, where this doubles as the account switcher —
          a generic glyph gives no hint that which account you're in is a thing
          you can change. Desktop keeps the outline icon: it sits in a row of
          line icons and an avatar there just looks misaligned.
        */}
        {userAuth?.profilePic ? (
          <img
            src={userAuth.profilePic}
            alt=""
            referrerPolicy="no-referrer"
            draggable={false}
            className={`sm:hidden h-[26px] w-[26px] rounded-full object-cover transition-all ${
              isOwnProfile
                ? "ring-2 ring-white"
                : "ring-1 ring-neutral-700 opacity-80"
            }`}
          />
        ) : (
          <Icons.profile
            className="sm:hidden h-[26px] w-[26px] text-lg"
            strokeColor={isOwnProfile ? "white" : "#4d4d4d"}
            fill={isOwnProfile ? "white" : "transparent"}
          />
        )}

        <Icons.profile
          className="hidden sm:block h-[26px] w-[26px] text-lg"
          strokeColor={isOwnProfile ? "white" : "#4d4d4d"}
          fill={isOwnProfile ? "white" : "transparent"}
        />
      </Link>

      {isSwitcherOpen && (
        <AccountSwitcherSheet onClose={() => setIsSwitcherOpen(false)} />
      )}

      <Link
        to="/chat"
        className="hover:bg-zinc-800 p-4 sm:py-5 sm:px-8 rounded-lg transform transition-all duration-150 ease-out hover:scale-100 active:scale-90 flex items-center justify-center w-full"
      >
        {path === "/chat" ? (
          <Icons.chat2 className="h-7 w-7 text-lg" />
        ) : (
          <Icons.chat className="h-7 w-7 text-lg" />
        )}
      </Link>
    </>
  );
}
