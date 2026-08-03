import React, { useContext, useState } from "react";
import { Check } from "lucide-react";
import { Icons } from "./icons";
import AiLabel from "./AiLabel";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import { UserContext } from "../contexts/UserContext";
import ProfileCard from "./ProfileCard";
import { REPLY_AUDIENCE_OPTIONS } from "../lib/replyAudience";
import { useMute } from "../contexts/MuteContext";
import { useBlock } from "../contexts/BlockContext";

const formatCreatedAt = (createdAt) => {
  const postDate = new Date(createdAt);
  const now = new Date();

  const diffInSeconds = Math.floor((now - postDate) / 1000);

  if (diffInSeconds < 60) {
    return `${diffInSeconds}s`;
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}h`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays <= 7) {
    return `${diffInDays}d`;
  }

  return postDate.toLocaleDateString("en-IN");
};

const PostHeader = ({
  author,
  createdAt,
  handleProfileClick,
  handleIconClick,
  hideActions = false,
  isSaved: propIsSaved,
  isSaving,
  isDraft = false,
  currentUserFollowing,
  isPrivate,
  hideLikeShareCount = false,
  showHideCountOption = true,
  showFavoriteChatOption = false,
  isAuthorFavorite = false,
  isTogglingFavorite = false,
  whoCanReply = "anyone",
  onWhoCanReplyChange,
  isEdited = false,
  onViewEditHistory,
  isAiGenerated = false,
}) => {
  const {
    userAuth: { username },
  } = useContext(UserContext);
  const [isUsernameHovered, setIsUsernameHovered] = useState(false);
  const [isReplyPrivacyOpen, setIsReplyPrivacyOpen] = useState(false);
  const { isMuted } = useMute();
  const { isBlocked } = useBlock();
  const authorMuted = isMuted(author?.username);
  const authorBlocked = isBlocked(author?.username);

  return (
    <div className="flex flex-row justify-start items-center relative">
      <div
        onClick={handleProfileClick}
        className="cursor-pointer flex items-center"
      >
        <div
          className="relative inline-block"
          onMouseEnter={() => setIsUsernameHovered(true)}
          onMouseLeave={() => setIsUsernameHovered(false)}
        >
          <p className="text-white font-medium line-clamp-1 flex items-center hover:underline">
            {author.username}
          </p>
          {isUsernameHovered && (
            <div
              className="absolute z-50 top-full left-0 mt-2 w-[300px] transition-opacity duration-200 ease-out"
              style={{ opacity: isUsernameHovered ? 1 : 0 }}
              onMouseEnter={() => setIsUsernameHovered(true)}
              onMouseLeave={() => setIsUsernameHovered(false)}
            >
              <ProfileCard
                name={author.name || author.username}
                username={author.username}
                bio={author.bio || ""}
                followers={author.followers?.length || 0}
                following={currentUserFollowing || []}
                profilePic={
                  author.profilePic || "/default-avatar.png"
                }
                isPrivate={isPrivate || false}
                isVerified={author.isVerified || false}
                isModal={false} 
                onClose={() => setIsUsernameHovered(false)}
              />
            </div>
          )}
        </div>
      </div>
      {author.isVerified && (
        <span className="pl-1 pt-0.5 inline-flex items-center">
          <Icons.verified />
        </span>
      )}
      <p className="min-w-fit text-neutral-500 ml-2 flex items-center">
        {formatCreatedAt(createdAt)}
      </p>
      {isAiGenerated && <AiLabel className="ml-2" authorUsername={author?.username} />}

      {!hideActions && (
        <div className="absolute right-0 flex items-center h-full">
          {/* Sits next to the overflow menu rather than inline with the
              timestamp, so it doesn't push the username/time line around.
              Not shown on quoted embeds — those render a frozen version, so
              linking to the live history would contradict what's displayed. */}
          {isEdited && (
            <button
              type="button"
              title="Edited · View edit history"
              aria-label="Edited. View edit history"
              onClick={(e) => {
                e.stopPropagation();
                onViewEditHistory?.();
              }}
              className="p-1 rounded-full hover:bg-neutral-800 transform transition-all duration-150 ease-out cursor-pointer"
            >
              <Icons.edited />
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className="p-1 rounded-full hover:bg-neutral-800 transform transition-all duration-150 ease-out cursor-pointer"
              >
                <Icons.more2 />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent sheetTitle="Post options"
              align="end"
              className="shadow-xl bg-[#181818] z-[999] rounded-2xl w-[250px] mt-1 p-0 border border-neutral-700"
            >
              {isDraft && author.username === username ? (
                <DropdownMenuItem
                  onClick={(e) => handleIconClick(e, "delete-draft")}
                  className="flex justify-between items-center text-red-500 p-3 mx-2 tracking-normal select-none font-semibold m-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                >
                  <span>Delete draft</span>
                  <Icons.delete />
                </DropdownMenuItem>
              ) : author.username === username ? (
                <>
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "save")}
                    disabled={isSaving}
                    className="flex justify-between items-center cursor-pointer p-3 mx-2 tracking-normal select-none font-semibold mt-2 text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>{propIsSaved ? "Unsave" : "Save"}</span>
                    {propIsSaved ? <Icons.unsave /> : <Icons.save />}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "edit")}
                    className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>Edit</span>
                    <Icons.editPost />
                  </DropdownMenuItem>
                  {showHideCountOption && (
                    <DropdownMenuItem
                      onClick={(e) => handleIconClick(e, "hide-count")}
                      className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                    >
                      <span>
                        {hideLikeShareCount
                          ? "Unhide like and share counts"
                          : "Hide like and share counts"}
                      </span>
                      <Icons.hidelike />
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    /*
                     * Scheduled from onClick, not onSelect+preventDefault.
                     * preventDefault means "keep this menu open", which on
                     * desktop Radix papered over by closing it anyway when the
                     * second menu took focus — but on mobile it left both
                     * sheets stacked, the audience one over a menu the user
                     * then had to dismiss separately. Letting this menu close
                     * normally gives one sheet at a time on both.
                     */
                    onClick={(e) => {
                      e.stopPropagation();
                      // The timeout lets the first menu finish closing.
                      setTimeout(() => setIsReplyPrivacyOpen(true), 0);
                    }}
                    className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>Who can reply & quote</span>
                    <Icons.chevronRight />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "delete")}
                    className="flex justify-between items-center text-red-500 p-3 mx-2 tracking-normal select-none font-semibold m-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>Delete</span>
                    <Icons.delete />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "copy-link")}
                    className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold m-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>Copy link</span>
                    <Icons.copy />
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  {showFavoriteChatOption && (
                    <>
                      <DropdownMenuItem
                        onClick={(e) =>
                          handleIconClick(e, "toggle-favorite-chat")
                        }
                        disabled={isTogglingFavorite}
                        className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold m-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none disabled:opacity-50"
                      >
                        <span>
                          {isAuthorFavorite
                            ? "Remove from favorites"
                            : "Add to favorites"}
                        </span>
                        {isAuthorFavorite ? (
                          <Icons.starFilled className="flex-shrink-0" />
                        ) : (
                          <Icons.star className="flex-shrink-0" />
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "save")}
                    disabled={isSaving}
                    className="flex justify-between items-center cursor-pointer p-3 mx-2 tracking-normal select-none font-semibold mt-2 text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>{propIsSaved ? "Unsave" : "Save"}</span>
                    {propIsSaved ? <Icons.unsave /> : <Icons.save />}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "not-interested")}
                    className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>Not interested</span>
                    <Icons.notinterested />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) =>
                      handleIconClick(e, authorMuted ? "unmute" : "mute")
                    }
                    className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] mt-2 active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>{authorMuted ? "Unmute" : "Mute"}</span>
                    {authorMuted ? <Icons.unmute /> : <Icons.mute />}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) =>
                      handleIconClick(e, authorBlocked ? "unblock-user" : "block")
                    }
                    className="flex justify-between items-center text-red-500 p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>{authorBlocked ? "Unblock" : "Block"}</span>
                    <Icons.block />
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "report")}
                    className="flex justify-between items-center text-red-500 p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>Report</span>
                    <Icons.report />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => handleIconClick(e, "copy-link")}
                    className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold m-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>Copy link</span>
                    <Icons.copy />
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Separate "Who can reply & quote" audience dropdown (author only) */}
          {author.username === username && (
            <DropdownMenu
              open={isReplyPrivacyOpen}
              onOpenChange={setIsReplyPrivacyOpen}
            >
              <DropdownMenuTrigger asChild>
                <span className="absolute right-0 top-0 h-0 w-0" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent sheetTitle="Who can reply & quote"
                align="end"
                onClick={(e) => e.stopPropagation()}
                className="shadow-xl bg-[#181818] z-[999] rounded-2xl w-[260px] mt-1 p-2 border border-neutral-700"
              >
                <p className="px-3 pt-1 pb-2 text-neutral-400 text-[13px] font-semibold">
                  Who can reply & quote
                </p>
                {REPLY_AUDIENCE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={(e) => e.stopPropagation()}
                    onSelect={(e) => {
                      e.preventDefault();
                      onWhoCanReplyChange?.(option.value);
                      setIsReplyPrivacyOpen(false);
                    }}
                    className="flex justify-between items-center p-3 mx-1 tracking-normal select-none font-semibold cursor-pointer text-[15px] text-white active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                  >
                    <span>{option.label}</span>
                    {whoCanReply === option.value && (
                      <Check className="h-4 w-4 text-white" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
};

export default PostHeader;
