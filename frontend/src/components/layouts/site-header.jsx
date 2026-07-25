import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icons } from "../icons";
import Navigation from "../navigations";
import useWindow from "../../hooks/UseWindow";
import { cn } from "../../lib/utils";
import NavigationMenu from "../../menus/NavigationMenu";
import { useNavigate } from "react-router-dom";

export default function SiteHeader({ layoutContext }) {
  const { isMobile } = useWindow();
  const [isScrolled, setIsScrolled] = useState(false);
  const refetchPosts =
    layoutContext?.refetchPosts ||
    (() => {
      console.warn("refetchPosts function not provided to SiteHeader");
    });
  const navigate = useNavigate();

  useEffect(() => {
    const changeBgColor = () => {
      window.scrollY > 0 ? setIsScrolled(true) : setIsScrolled(false);
    };
    window.addEventListener("scroll", changeBgColor);
    return () => window.removeEventListener("scroll", changeBgColor);
  }, [isScrolled]);

  const handleLogoClick = (e) => {
    e.preventDefault();
    if (location.pathname !== "/") {
      navigate("/");
    }
    refetchPosts();
    window.scrollTo(0, 0);
  };

  return (
    <header
      aria-label="Header"
      className={cn(
        "sticky top-0 z-[100] w-full",
        isScrolled
          ? "bg-[#101010D9] bg-background backdrop-blur-2xl"
          : "bg-transparent"
      )}
    >
      <nav className="sm:container sm:max-w-[1200px] px-4 mx-auto">
        <div className="relative py-1 flex w-full items-center z-50 max-h-[60px] sm:max-h-full h-full">
          <Link
            to="/"
            onClick={handleLogoClick}
            className="text-2xl font-semibold tracking-wide flex gap-2.5 items-center cursor-pointer active:scale-95 transform transition-all duration-150 ease-out hover:scale-105 z-[50] w-full sm:w-fit py-3 justify-center"
          >
            <Icons.logo className="h-[47px] w-[47px]" />
          </Link>

          <div className="flex-1 hidden sm:flex  md:justify-center justify-start">
            <div className="flex justify-between items-center max-w-[400px]">
              <Navigation layoutContext={layoutContext} />
            </div>
          </div>

          {isMobile ? (
            <div className="absolute right-0 -translate-y-2/4 top-2/4 z-[999]">
              <NavigationMenu />
            </div>
          ) : (
            <NavigationMenu />
          )}
        </div>
      </nav>
    </header>
  );
}
