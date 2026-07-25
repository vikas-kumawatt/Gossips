import React from "react";
import { Icons } from "./icons";

const StarOnGithubCard = () => {
  return (
    <a href="https://github.com/itsoksonu/Gossips-a-Threads-clone-app" target="_blank">
      <div className="hidden xl:flex min-w-[8rem] border border-neutral-700 bg-transparent p-1 rounded-full text-[14px] py-4 px-6 shadow-lg font-medium tracking-wide hover:scale-105 active:scale-95 cursor-pointer select-none transform transition-all duration-150 ease-out">
        <span className="flex justify-center items-center text-neutral-400">
          <Icons.github className="mr-2 w-4 h-4" />
          Star on Github
        </span>
      </div>
    </a>
  );
};

export default StarOnGithubCard;
