import React, { useRef, useState } from "react";
import EmojiPicker from "emoji-picker-react";
import { Icons } from "../icons";
import GifPicker from "../GifPicker";
import VoiceComposerBar from "./VoiceComposerBar";
import { messagePreviewLabel } from "../../lib/chatMessage";
import { COMPOSER_ACCEPT, MAX_MESSAGE_LENGTH } from "../../lib/composerMedia";

/**
 * The bottom of a conversation: reply strip, edit strip, attachment tray, voice bars,
 * input row, emoji and GIF pickers.
 *
 * The group thread had a much cruder version of this — a single-line `<input>`, no
 * attachment tray, no GIF picker, no edit strip, no character counter, a reply strip
 * that printed `replyingTo.content` raw (so replying to a photo showed an empty line),
 * and a `+` button that opened a one-file-at-a-time modal. Everything the DM composer
 * had learned, from the HEIC fix to `readOnly` instead of `disabled`, had to be learned
 * again over there or not at all. It was not.
 *
 * Presentational: every piece of state and every side effect belongs to the page. The
 * two threads send differently enough — optimistic bubbles, upload endpoints, group
 * permissions — that sharing the *sending* would mean a component full of branches.
 * This shares the part that should genuinely be identical, which is all of the chrome.
 *
 * `onPickDocument` and `onPoll` are the two slots. Both render only when passed, and
 * both are currently group-only: a poll between two people collapses into a question you
 * could just ask, and documents were reachable only from the group's old modal.
 */
const ChatComposer = ({
  value,
  onChange,
  onKeyDown,
  inputRef,
  sending = false,
  placeholder = "Message...",

  replyingTo,
  onCancelReply,
  editingMessage,
  onCancelEdit,

  media = [],
  onFilesSelected,
  onRemoveMedia,
  onPreviewMedia,

  voice,
  idleWaveform,
  onSendVoice,

  onSend,
  onEmoji,
  onGifSelect,

  onPickDocument,
  onPoll,
}) => {
  const fileInputRef = useRef(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);

  const openPicker = () => fileInputRef.current?.click();

  /* While a clip is being recorded or reviewed the voice bar *replaces* the input row
   * rather than sitting above it, so everything else in here stands down. */
  const voiceActive = !!(voice?.isRecording || voice?.preview);

  /*
   * Escape closes the pickers, then the page's own handler runs.
   *
   * The open/closed state moved in here with the pickers, so the page can no longer
   * close them itself — and Escape clearing a reply or an edit while leaving a
   * full-height emoji panel open would be worse than not handling it at all.
   */
  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      setShowEmojiPicker(false);
      setShowGifPicker(false);
    }
    onKeyDown?.(event);
  };

  const handleFiles = (event) => {
    onFilesSelected?.(event.target.files);
    // Cleared unconditionally: without this, picking the same file twice in a row fires
    // no change event the second time, and the second pick silently does nothing.
    event.target.value = "";
  };

  const canSend = value.trim() || editingMessage || media.length > 0;

  return (
    <div className="bg-black border-t border-neutral-800">
      {/*
        The reply and edit strips live inside the composer rather than above it, so a
        thread you can't post in doesn't offer a reply box you can't submit.
      */}
      {replyingTo && !voiceActive && (
        <div className="flex items-center justify-between bg-neutral-800 px-4 py-2 border-l-4 border-violet-600 mx-2 mt-2 rounded-lg">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-neutral-400">
              Replying to{" "}
              {replyingTo.isOwn
                ? "yourself"
                : replyingTo.senderUsername ||
                  replyingTo.sender?.username ||
                  "someone"}
            </div>
            {/*
              `messagePreviewLabel`, not `replyingTo.content` (which is what the group
              composer printed). A photo, a voice note, a poll and a call log all have an
              empty `content`, so replying to any of them showed a blank line.
            */}
            <div className="text-sm truncate">{messagePreviewLabel(replyingTo)}</div>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="text-neutral-400 hover:text-white ml-2 shrink-0"
          >
            <Icons.close className="w-4 h-4" />
          </button>
        </div>
      )}

      {editingMessage && !voiceActive && (
        <div className="flex items-center justify-between bg-blue-900/30 px-4 py-2 border-l-4 border-blue-600 mx-2 mt-2 rounded-lg">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-blue-400 mb-1">Editing message</div>
            <div className="text-sm truncate">{editingMessage.content}</div>
          </div>
          <button
            type="button"
            onClick={onCancelEdit}
            aria-label="Cancel editing"
            className="text-neutral-400 hover:text-white ml-2 shrink-0"
          >
            <Icons.close className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* The tray. Hidden while a voice clip is in hand — they compete for the row. */}
      {media.length > 0 && !voiceActive && (
        <div className="px-3 pt-2 pb-1 border-t border-neutral-800">
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pt-2 pb-1">
            {media.map((item, idx) => (
              <div key={item.url || idx} className="relative shrink-0">
                <button
                  type="button"
                  className="block w-16 h-16 rounded-xl overflow-hidden focus:outline-none"
                  onClick={() => onPreviewMedia?.(item)}
                  aria-label="Preview attachment"
                >
                  {item.type === "image" ? (
                    <img src={item.url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    /*
                     * The video's first frame, not a grey box with an icon in it. A strip
                     * of placeholder tiles is indistinguishable from itself, so you
                     * couldn't tell which clip you had picked. `preload="metadata"` is
                     * what paints the frame and `muted` is required for iOS to render one
                     * at all; the background stays as the fallback for a codec the
                     * browser won't decode.
                     */
                    <div className="relative w-full h-full bg-neutral-800">
                      <video
                        src={item.url}
                        preload="metadata"
                        muted
                        playsInline
                        tabIndex={-1}
                        className="w-full h-full object-cover"
                      />
                      {/* Marks it as a video, since a still frame reads as a photo. */}
                      <span
                        aria-hidden="true"
                        className="absolute bottom-0.5 right-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-black/60 pointer-events-none"
                      >
                        <Icons.videocam className="w-2.5 h-2.5 text-white" />
                      </span>
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveMedia?.(idx)}
                  aria-label="Remove attachment"
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-neutral-600 rounded-full flex items-center justify-center hover:bg-red-500 transition-colors z-10"
                >
                  <Icons.close className="w-3 h-3 text-white" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={openPicker}
              className="w-16 h-16 shrink-0 rounded-xl border-2 border-dashed border-neutral-700 flex items-center justify-center text-neutral-500 hover:text-white hover:border-neutral-500 transition-colors"
              title="Add more"
              aria-label="Add more attachments"
            >
              <Icons.image className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      <div className="py-3">
        {voice && (
          <VoiceComposerBar
            isRecording={voice.isRecording}
            recordingTime={voice.recordingTime}
            liveWaveform={voice.liveWaveform}
            preview={voice.preview}
            previewTime={voice.previewTime}
            previewProgress={voice.previewProgress}
            isPreviewPlaying={voice.isPreviewPlaying}
            idleWaveform={idleWaveform}
            sending={sending}
            onCancelRecording={voice.cancelRecording}
            onStopRecording={voice.stopRecording}
            onTogglePlay={voice.togglePreviewPlay}
            onDiscardPreview={voice.discardPreview}
            onSend={onSendVoice}
          />
        )}

        {!voiceActive && (
          <>
            <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 relative">
              {/*
                `onClick`, not `onPointerDown` (CF17).

                `pointerdown` doesn't fire for Enter or Space on a `<button>`, so
                recording was unreachable from the keyboard entirely — and it fired on
                *any* pointer button, so a right-click meant to open the browser menu
                started the microphone instead. `click` is synthesised for both keys and
                only for the primary button, which is both fixes at once.
              */}
              {voice && (
                <button
                  type="button"
                  onClick={voice.startRecording}
                  className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors"
                  aria-label="Record a voice message"
                >
                  <Icons.mic className="w-6 h-6" />
                </button>
              )}

              {/* Desktop only: phone keyboards have their own emoji panel, and this one
                  is a fixed-width popover that doesn't fit beside it. */}
              <button
                type="button"
                onClick={() => setShowEmojiPicker((v) => !v)}
                className="hidden md:inline-flex text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                disabled={sending}
                aria-label="Emoji"
              >
                <Icons.smile className="w-6 h-6" />
              </button>

              {showEmojiPicker && (
                <div className="absolute bottom-16 left-2 z-50 hidden md:block">
                  <EmojiPicker
                    theme="dark"
                    onEmojiClick={(emojiObject) => onEmoji?.(emojiObject)}
                  />
                </div>
              )}

              {/*
                A textarea, and never disabled.

                Two bugs in one element. It was `<input type="text">` on both pages while
                bubbles render `whitespace-pre-wrap` and the key handler explicitly
                supports Shift+Enter — a single-line input cannot contain a newline, so
                the one combination the code went out of its way to support could never do
                anything (#118). It grows to five lines and then scrolls.

                And `disabled={sending}` blurs a focused field, which closes the phone's
                on-screen keyboard: you had to tap the input again after every single
                message (#46). `readOnly` keeps focus and the caret while still refusing
                input, and the send button is already disabled, so nothing can be
                submitted twice.
              */}
              <textarea
                ref={inputRef}
                rows={1}
                value={value}
                onChange={onChange}
                onKeyDown={handleKeyDown}
                placeholder={editingMessage ? "Edit message..." : placeholder}
                aria-label={editingMessage ? "Edit message" : "Message"}
                className="flex-1 min-w-0 resize-none bg-neutral-800 text-sm text-white placeholder-neutral-400 focus:outline-none py-2 sm:py-2.5 px-3 sm:px-4 rounded-2xl max-h-32 overflow-y-auto"
                readOnly={sending}
                maxLength={MAX_MESSAGE_LENGTH}
              />

              <div className="hidden sm:block text-xs text-neutral-500 min-w-[60px] text-right">
                {value.length}/{MAX_MESSAGE_LENGTH}
              </div>

              <input
                type="file"
                accept={COMPOSER_ACCEPT}
                ref={fileInputRef}
                onChange={handleFiles}
                className="hidden"
                multiple
              />

              {canSend ? (
                <button
                  type="button"
                  onClick={onSend}
                  disabled={sending}
                  className="text-white px-3 sm:px-4 py-2 rounded-full bg-violet-600 hover:bg-violet-700 transition-colors disabled:opacity-50 font-medium text-sm shrink-0"
                >
                  {sending ? (
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
                    type="button"
                    onClick={openPicker}
                    className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                    disabled={sending}
                    aria-label="Media"
                  >
                    <Icons.image className="w-6 h-6" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowGifPicker((v) => !v)}
                    className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                    disabled={sending}
                    aria-label="GIF"
                  >
                    <Icons.gif className="w-6 h-6" />
                  </button>
                  {onPickDocument && (
                    <button
                      type="button"
                      onClick={onPickDocument}
                      className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                      disabled={sending}
                      aria-label="Document"
                    >
                      <Icons.file className="w-6 h-6" />
                    </button>
                  )}
                  {onPoll && (
                    <button
                      type="button"
                      onClick={onPoll}
                      className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                      disabled={sending}
                      aria-label="Poll"
                    >
                      <Icons.poll className="w-6 h-6" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {showGifPicker && (
              <GifPicker
                onSelect={(gif) => {
                  onGifSelect?.(gif);
                  setShowGifPicker(false);
                }}
                onClose={() => setShowGifPicker(false)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ChatComposer;
