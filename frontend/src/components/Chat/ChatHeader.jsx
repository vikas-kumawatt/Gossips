import React, { useState } from "react";
import { Icons } from "../components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const ChatHeader = ({ 
  selectedUser, 
  isOnline, 
  lastSeen, 
  navigate, 
  onSearchToggle,
  onRestrict,
  onBlock,
  onReport,
  onDeleteChat,
  isBlocked,
  isRestricted 
}) => {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const formatLastSeen = (lastSeen) => {
    if (!lastSeen) return "Never";
    const lastSeenDate = new Date(lastSeen);
    const now = new Date();
    const diffMs = now - lastSeenDate;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return lastSeenDate.toLocaleDateString();
  };

  const UserStatusIndicator = () => (
    <div className="flex items-center gap-2 text-xs">
      {isOnline ? (
        <span className="text-green-500">Online</span>
      ) : (
        <span className="text-neutral-400">Last seen {formatLastSeen(lastSeen)}</span>
      )}
    </div>
  );

  const handleSearchToggle = () => {
    const newShowSearch = !showSearch;
    setShowSearch(newShowSearch);
    onSearchToggle(newShowSearch);
    if (!newShowSearch) {
      setSearchQuery('');
    }
  };

  return (
    <header className="fixed top-0 w-full max-w-2xl z-10 bg-black border-b border-neutral-800 py-4 px-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate(-1)}
          className="text-neutral-400 hover:text-white transition-colors"
          aria-label="Go back"
        >
          <Icons.back className="w-5 h-5" />
        </button>

        <div
          className="flex items-center gap-3 flex-1 cursor-pointer"
          onClick={() => navigate(`/${selectedUser?.username}`)}
        >
          <div className="relative">
            <img
              src={selectedUser?.profilePic || "/default-avatar.png"}
              alt={selectedUser?.username}
              className="w-9 h-9 rounded-full object-cover border border-neutral-700"
            />
            <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-black ${
              isOnline ? 'bg-green-500' : 'bg-neutral-500'
            }`} />
          </div>
          <div className="flex-1">
            <h2 className="font-medium text-base">
              {selectedUser?.name || "User"}
            </h2>
            <UserStatusIndicator />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSearchToggle}
            className="hover:text-white transition-colors cursor-pointer"
            aria-label="Search"
          >
            <Icons.search className="w-5 h-5" strokeColor="#ffffff" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="text-white cursor-pointer" aria-label="Menu">
                <Icons.about className="w-6 h-6" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="bg-neutral-900 border-neutral-700 rounded-2xl w-56 p-2"
            >
              <DropdownMenuItem
                onClick={onRestrict}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                disabled={isRestricted}
              >
                <span>{isRestricted ? "Restricted" : "Restrict"}</span>
                <Icons.restrict className="w-5 h-5" />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onBlock}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                disabled={isBlocked}
              >
                <span>{isBlocked ? "Blocked" : "Block"}</span>
                <Icons.block className="w-5 h-5" />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onReport}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
              >
                <span>Report</span>
                <Icons.report className="w-5 h-5" />
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-neutral-700 my-2" />
              <DropdownMenuItem
                onClick={onDeleteChat}
                className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
              >
                <span>Delete Chat</span>
                <Icons.delete className="w-5 h-5" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {showSearch && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-neutral-800 text-white placeholder-neutral-400 rounded-full px-4 py-2 text-sm focus:outline-none"
          />
          <button
            onClick={handleSearchToggle}
            className="text-neutral-400 hover:text-white p-2"
          >
            <Icons.close className="w-4 h-4" />
          </button>
        </div>
      )}
    </header>
  );
};

export default ChatHeader;