import React from "react";
import MessageBubble from "./MessageBubble";

const MessageGroup = ({ 
  group, 
  isOwn, 
  selectedUser, 
  onContextMenu, 
  onMediaClick,
  onReaction,
  reactingTo,
  getMessageIndicator 
}) => {
  return (
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"} px-3 mb-3`}>
      {!isOwn && (
        <div className="mr-2 self-end mb-1">
          <img
            src={selectedUser?.profilePic || "/default-avatar.png"}
            alt={selectedUser?.username}
            className="w-8 h-8 rounded-full object-cover border border-neutral-800"
          />
        </div>
      )}
      
      <div className="max-w-[70%]">
        {group.map((message, msgIndex) => (
          <div
            key={message._id || message.tempId}
            className={`relative ${
              group.length === 1
                ? "rounded-2xl"
                : msgIndex === 0
                ? `rounded-2xl ${isOwn ? "rounded-br-md" : "rounded-bl-md"}`
                : msgIndex === group.length - 1
                ? `rounded-2xl ${isOwn ? "rounded-tr-md" : "rounded-tl-md"}`
                : `${isOwn ? "rounded-r-md" : "rounded-l-md"} rounded-md`
            } ${msgIndex !== 0 ? "mt-0.5" : ""}`}
          >
            <MessageBubble
              message={message}
              isOwn={isOwn}
              selectedUser={selectedUser}
              onContextMenu={onContextMenu}
              onMediaClick={onMediaClick}
              onReaction={onReaction}
              isReacting={reactingTo === message._id}
            />
          </div>
        ))}
      </div>

      {getMessageIndicator(group[group.length - 1], isOwn) && (
        <div className={`text-xs text-neutral-400 mt-1 px-3 ${isOwn ? "text-right" : "text-left ml-12"}`}>
          {getMessageIndicator(group[group.length - 1], isOwn)}
        </div>
      )}
    </div>
  );
};

export default MessageGroup;