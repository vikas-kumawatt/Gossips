import React from "react";
import { Icons } from "./icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@radix-ui/react-dropdown-menu";

const PostActions = ({
  handleIconClick,
  isLiked,
  isLiking,
  likeCount,
  replyCount,
  repostCount,
  isReposted,
  isReposting,
  hideLikeShareCount = false,
  canReplyQuote = true,
}) => {
  return (
    <div className="flex flex-row justify-start gap-2 items-center">
      <button
        onClick={(e) => handleIconClick(e, "like")}
        className={`flex flex-row items-center -ml-2 gap-2 p-2 rounded-full hover:bg-neutral-800 transform transition-all duration-150 ease-out cursor-pointer ${
          isLiked ? "text-red-500" : ""
        }`}
        disabled={isLiking}
      >
        {!isLiked ? <Icons.like /> : <Icons.unlike />}
        {!hideLikeShareCount && likeCount > 0 && <p>{likeCount}</p>}
      </button>

      <button
        onClick={(e) => handleIconClick(e, "reply")}
        className={`flex flex-row items-center gap-2 p-2 rounded-full hover:bg-neutral-800 transform transition-all duration-150 ease-out cursor-pointer ${
          !canReplyQuote ? "opacity-40" : ""
        }`}
        aria-label="Reply to post"
        title={!canReplyQuote ? "Replies are limited on this post" : undefined}
      >
        <Icons.reply className="text-[#CCCCCC]" />
        {replyCount > 0 && <p>{replyCount}</p>}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex flex-row items-center gap-2 p-2 rounded-full hover:bg-neutral-800 transform transition-all duration-150 ease-out cursor-pointer text-neutral-400"
            disabled={isReposting}
            aria-label="Repost or Quote"
          >
            {isReposted ? <Icons.reposted /> : <Icons.repost />}
            {!hideLikeShareCount && repostCount > 0 && <p>{repostCount}</p>}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="shadow-xl bg-[#181818] z-[999] rounded-2xl w-[250px] mt-1 p-0 border border-neutral-700"
        >
          <DropdownMenuItem
            onClick={(e) => {
              handleIconClick(e, isReposted ? "unrepost" : "repost");
            }}
            className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mt-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
          >
            <span>{isReposted ? "Remove" : "Repost"}</span>
            {isReposted ? <Icons.remove /> : <Icons.repost />}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => handleIconClick(e, "quote")}
            className={`flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none ${
              !canReplyQuote ? "opacity-40" : ""
            }`}
          >
            <span>Quote</span>
            <Icons.quote />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        onClick={(e) => handleIconClick(e, "share")}
        className="flex flex-row items-center gap-2 hover:bg-neutral-800 transform transition-all duration-150 ease-out cursor-pointer p-2 rounded-full"
      >
        <Icons.share className="text-[#CCCCCC]" />
      </button>
    </div>
  );
};

export default PostActions;