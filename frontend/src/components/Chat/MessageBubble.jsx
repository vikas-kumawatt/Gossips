import React from "react";
import { Icons } from "../components/icons";

const MessageBubble = ({ 
  message, 
  isOwn, 
  // selectedUser, 
  onContextMenu, 
  onMediaClick,
  onReaction,
  isReacting,
  // onReply,
  // onForward,
  // onPin,
  // onEdit,
  // onDelete
}) => {
  const hasMedia = message.media?.length > 0;
  const hasContent = message.content?.trim();
  const isMediaOnly = hasMedia && !hasContent;

  const getMessageContent = () => {
    if (message.isDeleted) {
      return <span className="italic text-neutral-400">This message was deleted</span>;
    }

    switch (message.messageType) {
      case 'media':
        return '📷 Media';
      case 'voice':
        return '🎤 Voice message';
      case 'poll':
        return '📊 Poll';
      case 'sticker':
        return '🎨 Sticker';
      case 'gif':
        return 'GIF';
      case 'file':
        return '📎 File';
      case 'call':
        return `📞 ${message.call?.type === 'video' ? 'Video' : 'Voice'} call (${message.call?.duration}s)`;
      default:
        return message.content;
    }
  };

  const renderMedia = (media) => {
    switch (media.type) {
      case 'image':
        return (
          <img
            src={media.url}
            alt="Shared media"
            className="max-w-[min(100%,240px)] max-h-52 w-auto h-auto rounded-lg object-contain cursor-pointer"
            loading="lazy"
            onClick={() => onMediaClick(media.url)}
          />
        );
      case 'video':
        return (
          <video
            src={media.url}
            controls
            className="max-w-[min(100%,240px)] max-h-52 w-auto h-auto rounded-lg object-contain"
          >
            Your browser does not support video.
          </video>
        );
      case 'audio':
        return (
          <div className="flex items-center gap-3 p-3 bg-black bg-opacity-50 rounded-lg">
            <button className="w-8 h-8 bg-violet-600 rounded-full flex items-center justify-center">
              <Icons.play className="w-4 h-4 text-white" />
            </button>
            <div className="flex-1">
              <div className="w-full bg-neutral-600 rounded-full h-1">
                <div className="bg-violet-600 h-1 rounded-full" style={{ width: '30%' }}></div>
              </div>
              <p className="text-xs text-neutral-400 mt-1">
                {media.duration ? `${Math.floor(media.duration)}s` : 'Voice message'}
              </p>
            </div>
          </div>
        );
      case 'document':
        return (
          <div className="flex items-center gap-3 p-3 bg-black bg-opacity-50 rounded-lg">
            <Icons.file className="w-8 h-8 text-violet-400" />
            <div className="flex-1">
              <p className="text-sm font-medium truncate">{media.filename}</p>
              <p className="text-xs text-neutral-400">
                {(media.fileSize / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
            <a
              href={media.url}
              download={media.filename}
              className="text-violet-400 hover:text-violet-300"
            >
              <Icons.download className="w-5 h-5" />
            </a>
          </div>
        );
      case 'gif':
        return (
          <img
            src={media.url}
            alt="GIF"
            className="max-w-[min(100%,240px)] max-h-52 w-auto h-auto rounded-lg object-contain"
            loading="lazy"
          />
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`relative ${isMediaOnly ? '' : 'px-4 py-2'} ${
        isOwn ? "bg-violet-600 text-white" : "bg-neutral-800 text-white"
      } rounded-2xl transition-all duration-200 ${
        message.isPinned ? "ring-2 ring-yellow-500" : ""
      }`}
      onContextMenu={(e) => onContextMenu(message, e)}
    >
      {message.isPinned && (
        <div className="absolute -top-5 right-0 text-xs text-yellow-500 flex items-center gap-1">
          <Icons.pin className="w-3 h-3" />
          <span>Pinned</span>
        </div>
      )}

      {message.isForwarded && (
        <div className="text-xs text-neutral-400 mb-1 flex items-center gap-1">
          <Icons.forward className="w-3 h-3" />
          <span>Forwarded</span>
        </div>
      )}

      {message.replyTo && (
        <div className="mb-2 p-2 bg-black bg-opacity-30 rounded-lg border-l-2 border-violet-400">
          <div className="text-xs text-neutral-300 mb-1">
            {message.replyTo.senderUsername}
          </div>
          <div className="text-xs truncate opacity-75">
            {getMessageContent(message.replyTo)}
          </div>
        </div>
      )}

      {hasContent && (
        <p className={`text-sm whitespace-pre-wrap break-words ${hasMedia ? "mb-2" : ""}`}>
          {getMessageContent()}
          {message.isEdited && !message.isDeleted && (
            <span className="text-xs text-neutral-400 ml-2">(edited)</span>
          )}
        </p>
      )}
      
      {hasMedia && !message.isDeleted && (
        <div className="relative">
          {message.media.map((item, idx) => (
            <div key={idx} className="rounded-lg overflow-hidden">
              {renderMedia(item)}
            </div>
          ))}
        </div>
      )}
      
      {message.reactions && Object.keys(message.reactions).length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {Object.entries(message.reactions).map(([userId, reactionData]) => {
            const emoji = typeof reactionData === 'string' ? reactionData : reactionData.emoji;
            return (
              <span 
                key={userId} 
                className="text-sm bg-black bg-opacity-50 rounded-full px-2 py-0.5 cursor-pointer hover:bg-opacity-70"
                onClick={() => onReaction(message._id, emoji)}
              >
                {emoji}
              </span>
            );
          })}
        </div>
      )}

      {isReacting === message._id && (
        <div className="absolute -top-12 left-0 bg-neutral-800 rounded-full px-2 py-2 flex gap-2 shadow-xl border border-neutral-700 z-10">
          {['👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🔥'].map(emoji => (
            <button
              key={emoji}
              onClick={() => onReaction(message._id, emoji)}
              className="text-xl hover:scale-125 transition-transform w-8 h-8 flex items-center justify-center hover:bg-neutral-700 rounded-full"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      
      {message.isUploading && (
        <div className="absolute inset-0 bg-black bg-opacity-70 rounded-lg flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin" />
            <span className="text-white text-xs font-medium">Uploading...</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageBubble;