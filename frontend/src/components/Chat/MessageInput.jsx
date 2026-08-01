import React, { useState } from "react";
import { Icons } from "../components/icons";
import EmojiPicker from "emoji-picker-react";
import GifPicker from "../GifPicker";

const MessageInput = ({
  newMessage,
  onMessageChange,
  onKeyDown,
  onSendMessage,
  // onMediaSelect,
  isSending,
  editingMessage,
  replyingTo,
  onCancelReply,
  onCancelEdit,
  isBlocked,
  isRestricted,
  fileInputRef,
  onVoiceRecordStart,
  onVoiceRecordStop,
  isRecording,
  recordingTime
}) => {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const MAX_MESSAGE_LENGTH = 10000;

  const handleEmojiClick = (emojiObject) => {
    if (newMessage.length + emojiObject.emoji.length <= MAX_MESSAGE_LENGTH) {
      onMessageChange(newMessage + emojiObject.emoji);
    }
  };

  /** Shape from the shared GifPicker: { url, width, height }. */
  const handleGifSelect = (gif) => {
    if (isBlocked || isRestricted) return;
    onSendMessage([{ type: "gif", url: gif.url, thumbnail: gif.url }], "gif");
    setShowGifPicker(false);
  };

  const ReplyPreview = () => (
    <div className="flex items-center justify-between bg-neutral-800 px-4 py-2 border-l-4 border-violet-600 mx-2 mb-2 rounded-lg">
      <div className="flex-1">
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span>Replying to {replyingTo?.isOwn ? 'yourself' : replyingTo?.senderUsername}</span>
        </div>
        <div className="text-sm truncate">
          {replyingTo?.content || (replyingTo?.media?.length ? 'Media' : 'Message')}
        </div>
      </div>
      <button
        onClick={onCancelReply}
        className="text-neutral-400 hover:text-white ml-2"
      >
        <Icons.close className="w-4 h-4" />
      </button>
    </div>
  );

  const EditingPreview = () => (
    <div className="flex items-center justify-between bg-blue-900 bg-opacity-30 px-4 py-2 border-l-4 border-blue-600 mx-2 mb-2 rounded-lg">
      <div className="flex-1">
        <div className="text-xs text-blue-400 mb-1">Editing message</div>
        <div className="text-sm truncate">{editingMessage?.content}</div>
      </div>
      <button
        onClick={onCancelEdit}
        className="text-neutral-400 hover:text-white ml-2"
      >
        <Icons.close className="w-4 h-4" />
      </button>
    </div>
  );

  const MoreOptionsMenu = () => (
    <div className="absolute bottom-16 right-2 bg-neutral-900 border border-neutral-700 rounded-lg p-2 shadow-xl z-50">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex flex-col items-center p-3 hover:bg-neutral-800 rounded-lg transition-colors"
        >
          <Icons.image className="w-6 h-6 mb-1" />
          <span className="text-xs">Photo/Video</span>
        </button>
        <button
          onClick={() => {/* Implement document upload */}}
          className="flex flex-col items-center p-3 hover:bg-neutral-800 rounded-lg transition-colors"
        >
          <Icons.file className="w-6 h-6 mb-1" />
          <span className="text-xs">Document</span>
        </button>
        <button
          onClick={() => {/* Implement poll creation */}}
          className="flex flex-col items-center p-3 hover:bg-neutral-800 rounded-lg transition-colors"
        >
          <Icons.poll className="w-6 h-6 mb-1" />
          <span className="text-xs">Poll</span>
        </button>
        <button
          onClick={() => {/* Implement contact sharing */}}
          className="flex flex-col items-center p-3 hover:bg-neutral-800 rounded-lg transition-colors"
        >
          <Icons.contact className="w-6 h-6 mb-1" />
          <span className="text-xs">Contact</span>
        </button>
        <button
          onClick={() => {/* Implement location sharing */}}
          className="flex flex-col items-center p-3 hover:bg-neutral-800 rounded-lg transition-colors"
        >
          <Icons.location className="w-6 h-6 mb-1" />
          <span className="text-xs">Location</span>
        </button>
        <button
          onClick={() => setShowGifPicker(true)}
          className="flex flex-col items-center p-3 hover:bg-neutral-800 rounded-lg transition-colors"
        >
          <Icons.gif className="w-6 h-6 mb-1" />
          <span className="text-xs">GIF</span>
        </button>
      </div>
    </div>
  );

  if (isBlocked || isRestricted) {
    return (
      <div className="fixed bottom-0 w-full max-w-2xl py-4 bg-black border-t border-neutral-800 text-center text-neutral-400 text-sm">
        {isBlocked ? "You cannot message this user" : "You cannot message restricted users"}
      </div>
    );
  }

  return (
    <>
      {replyingTo && <ReplyPreview />}
      {editingMessage && <EditingPreview />}

      <div className="fixed bottom-0 w-full max-w-2xl py-3 bg-black border-t border-neutral-800">
        <div className="flex items-center gap-2 px-3 relative">
          {/* Voice Recording Button */}
          {isRecording ? (
            <button
              onClick={onVoiceRecordStop}
              className="text-red-500 p-2 transition-colors relative"
              aria-label="Stop recording"
            >
              <div className="w-6 h-6 bg-red-500 rounded-full"></div>
              <span className="text-xs absolute -top-6 left-0 bg-red-500 text-white px-2 py-1 rounded">
                {recordingTime}s
              </span>
            </button>
          ) : (
            <button
              onMouseDown={onVoiceRecordStart}
              onTouchStart={onVoiceRecordStart}
              onMouseUp={onVoiceRecordStop}
              onTouchEnd={onVoiceRecordStop}
              className="text-neutral-400 hover:text-white p-2 transition-colors"
              aria-label="Voice message"
            >
              <Icons.mic className="w-6 h-6" />
            </button>
          )}

          {/* Desktop only: phone keyboards have their own emoji panel, and
              this one is a fixed-width popover that doesn't fit beside it. */}
          <button
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="hidden md:inline-flex text-neutral-400 hover:text-white p-2 transition-colors disabled:opacity-50"
            disabled={isSending}
            aria-label="Emoji"
          >
            <Icons.smile className="w-6 h-6" />
          </button>

          {showEmojiPicker && (
            <div className="absolute bottom-16 left-2 z-50 hidden md:block">
              <EmojiPicker onEmojiClick={handleEmojiClick} theme="dark" />
            </div>
          )}

          <input
            type="text"
            value={newMessage}
            onChange={(e) => onMessageChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={editingMessage ? "Edit message..." : "Message..."}
            className="flex-1 bg-neutral-800 text-sm text-white placeholder-neutral-400 focus:outline-none py-2.5 px-4 rounded-full disabled:opacity-50"
            disabled={isSending}
            maxLength={MAX_MESSAGE_LENGTH}
          />

          <div className="text-xs text-neutral-500 min-w-[60px] text-right">
            {newMessage.length}/{MAX_MESSAGE_LENGTH}
          </div>

          {newMessage.trim() || editingMessage ? (
            <button
              onClick={() => onSendMessage()}
              disabled={isSending}
              className="text-white px-4 py-2 rounded-full bg-violet-600 hover:bg-violet-700 transition-colors disabled:opacity-50 font-medium text-sm"
            >
              {isSending ? (
                <Icons.spinner className="w-4 h-4 animate-spin" />
              ) : editingMessage ? (
                "Save"
              ) : (
                "Send"
              )}
            </button>
          ) : (
            <div className="flex gap-1">
              <button
                onClick={() => setShowMoreOptions(!showMoreOptions)}
                className="text-neutral-400 hover:text-white p-2 transition-colors disabled:opacity-50"
                disabled={isSending}
                aria-label="More options"
              >
                <Icons.plus className="w-6 h-6" />
              </button>
            </div>
          )}
        </div>

        {showMoreOptions && <MoreOptionsMenu />}

        {showGifPicker && (
          <GifPicker
            onSelect={handleGifSelect}
            onClose={() => setShowGifPicker(false)}
          />
        )}
      </div>
    </>
  );
};

export default MessageInput;