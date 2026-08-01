import React, { useContext, useState } from "react";
import axios from "axios";
import { Icons } from "../components/icons";
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

export default function NavigationMenu() {
  const { userAuth, setUserAuth } = useContext(UserContext);
  const navigate = useNavigate();
  const [isProblemOpen, setIsProblemOpen] = useState(false);
  // Only affects whether the entry is shown. The panel itself is gated by the
  // server, so a tampered role here gets a "nothing here" screen.
  const isStaff = ["admin", "super_admin"].includes(userAuth?.role);

  const handleLogOut = () => {
    axios
      .post(`${import.meta.env.VITE_SERVER}/auth/logout`, {}, { withCredentials: true })
      .catch(() => null)
      .finally(() => {
        removeFromSession("user");
        setUserAuth({ token: null, savedPosts: [] });
      });
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

          <DropdownMenuItem className="flex justify-between items-center p-3 mx-2 mb-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950  text-white hover:bg-neutral-800 hover:rounded-xl outline-none">
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
    </>
  );
}
