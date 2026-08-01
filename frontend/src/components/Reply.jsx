import React, { useContext, useState, useRef, useEffect } from "react";
import { Check, Clock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Icons } from "./icons";
import { UserContext } from "../contexts/UserContext";
import axios from "axios";
import { Toaster, toast } from "react-hot-toast";
import SchedulePickerSheet from "./SchedulePickerSheet";
import { formatScheduleLabel } from "../lib/schedule";
import {
  ComposerPreviews,
  ComposerSheets,
  ComposerToolbar,
} from "./ComposerAttachments";
import useComposerAttachments from "../hooks/useComposerAttachments";
import { REPLY_RESTRICTED_TEXT } from "../lib/replyAudience";
import ResponsiveMenu from "./ui/ResponsiveMenu";

const Reply = ({ isOpen, onClose, postId, commentId, parentId = null, onReplyAdded }) => {
  const { userAuth, userAuth: { token } } = useContext(UserContext);
  const [content, setContent] = useState("");
  const [mediaFiles, setMediaFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isMoreDropdownOpen, setIsMoreDropdownOpen] = useState(false);
  // Author-declared AI disclosure, sent with the reply.
  const [isAiGenerated, setIsAiGenerated] = useState(false);
  const [isReplyDropdownOpen, setIsReplyDropdownOpen] = useState(false);
  const [replyText, setReplyText] = useState("Anyone can reply & quote");
  // When set, the reply is queued instead of posted. A Date in local time.
  const [scheduledFor, setScheduledFor] = useState(null);
  const [isSchedulePickerOpen, setIsSchedulePickerOpen] = useState(false);
  // GIF, audio, poll and location — one implementation shared by all three
  // composers. Photos stay in this component's own mediaFiles state.
  const attachments = useComposerAttachments({
    mediaCount: mediaFiles.length,
    clearMedia: () => setMediaFiles([]),
  });
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const cardRef = useRef(null);
  const moreDropdownRef = useRef(null);
  const replyDropdownRef = useRef(null);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      // The picker is a portal at document.body, so clicks inside it look
      // "outside" this card and would otherwise close the composer.
      // Every one of these is a portal at document.body, so a tap inside it
      // reads as "outside the card" and would close the composer underneath.
      if (
        isSchedulePickerOpen ||
        attachments.openSheet ||
        isMoreDropdownOpen ||
        isReplyDropdownOpen
      )
        return;
      if (cardRef.current && !cardRef.current.contains(event.target)) {
        onClose();
      } else {
        if (moreDropdownRef.current && !moreDropdownRef.current.contains(event.target)) {
          setIsMoreDropdownOpen(false);
        }
        if (replyDropdownRef.current && !replyDropdownRef.current.contains(event.target)) {
          setIsReplyDropdownOpen(false);
        }
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen, onClose, isSchedulePickerOpen, attachments.openSheet, isMoreDropdownOpen, isReplyDropdownOpen]);

  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  const resetForm = () => {
    setContent("");
    setMediaFiles([]);
    setError("");
    setIsMoreDropdownOpen(false);
    setIsReplyDropdownOpen(false);
    setReplyText("Anyone can reply & quote");
    setScheduledFor(null);
    setIsSchedulePickerOpen(false);
    attachments.reset();
  };

  if (!isOpen) return null;

  const handleContentChange = (e) => {
    setContent(e.target.value);
    const textarea = textareaRef.current;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files);
    if (files.length + mediaFiles.length > 5) {
      setError("You can only upload up to 5 files");
      return;
    }

    const validFiles = files.filter(file =>
      file.type.startsWith("image/") || file.type.startsWith("video/")
    );

    if (validFiles.length !== files.length) {
      setError("Only images and videos are allowed");
    }

    setMediaFiles([...mediaFiles, ...validFiles]);
    setError("");
  };

  const removeFile = (index) => {
    setMediaFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!content.trim() && mediaFiles.length === 0 && !attachments.hasAttachment) {
      setError("Comment must have content, media or a poll");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("content", content);
      if (postId) formData.append("postId", postId);
      if (commentId) formData.append("commentId", commentId);
      if (parentId) formData.append("parentId", parentId);
      formData.append("isAiGenerated", String(isAiGenerated));
      attachments.appendTo(formData);
      if (scheduledFor) formData.append("scheduledFor", scheduledFor.toISOString());
      mediaFiles.forEach(file => formData.append("media", file));

      const endpoint = commentId ? "/reply/nested-comment" : "/reply/comment";
      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}${endpoint}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data",
          },
        }
      );

      if (response.status === 201) {
        if (response.data.scheduled) {
          // It isn't in the thread yet, so don't hand it to the list.
          toast.success(`Scheduled for ${formatScheduleLabel(scheduledFor)}`);
        } else {
          toast.success("Reply posted");
          if (onReplyAdded) onReplyAdded(response.data.comment);
        }
        resetForm();
        setTimeout(onClose, 800);
      }
    } catch (err) {
      if (err.response?.status === 403) {
        toast.error(REPLY_RESTRICTED_TEXT);
        onClose?.();
      } else {
        setError(err.response?.data?.error || "Failed to post reply");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleImageButtonClick = () => {
    fileInputRef.current.click();
  };

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center px-4">
      <div ref={cardRef} className="bg-neutral-900 w-full max-w-[600px] rounded-2xl border border-neutral-600 overflow-hidden">
        <div className="flex items-center justify-between p-4">
          <button
            onClick={onClose}
            className="text-md hover:text-red-500 transition-colors cursor-pointer"
            disabled={isLoading}
          >
            Cancel
          </button>
          <p className="font-medium text-lg">Reply</p>
          <div className="flex gap-4">
            <div className="relative mt-1" ref={moreDropdownRef}>
              <button
                className="text-gray-400 hover:text-white transition-colors cursor-pointer"
                onClick={() => setIsMoreDropdownOpen(!isMoreDropdownOpen)}
              >
                <Icons.more className="h-6 w-6" />
              </button>
              <ResponsiveMenu
                  open={isMoreDropdownOpen}
                  onClose={() => setIsMoreDropdownOpen(false)}
                  title="Options"
                  className="absolute right-0 mt-1 w-[250px] bg-[#181818] rounded-2xl border border-neutral-700 shadow-xl z-[999]"
                >
                  <div className="p-2">
                    <button
                      className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                      onClick={() => {
                        setIsAiGenerated((v) => !v);
                        setIsMoreDropdownOpen(false);
                      }}
                    >
                      <span>{isAiGenerated ? "Remove AI label" : "Add AI label"}</span>
                      {isAiGenerated ? <Check className="w-5 h-5" /> : <Icons.ai />}
                    </button>
                    <hr className="my-1 -mx-2 border-neutral-800" />
                    <button
                      className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                      onClick={() => {
                        setIsMoreDropdownOpen(false);
                        setIsSchedulePickerOpen(true);
                      }}
                    >
                      <span>{scheduledFor ? "Change schedule" : "Schedule..."}</span>
                      <Icons.schedule />
                    </button>
                    <button
                      className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                      onClick={() => {
                        setIsMoreDropdownOpen(false);
                        navigate("/scheduled");
                      }}
                    >
                      <span>Scheduled posts</span>
                      <Icons.chevronRight />
                    </button>
                  </div>
                </ResponsiveMenu>
            </div>
          </div>
        </div>
        <hr className="border-neutral-600" />
        <div className="p-4">
          <div className="flex gap-3">
            <img
              className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center border border-neutral-500"
              src={userAuth.profilePic}
              alt="Profile"
            />
            <div className="flex-1">
              <p className="text-white font-medium">{userAuth.username}</p>
              <textarea
                ref={textareaRef}
                placeholder="Add to gossip"
                className="w-full bg-transparent text-gray-300 placeholder-gray-500 outline-none resize-none mt-1"
                value={content}
                onChange={handleContentChange}
                maxLength={500}
                rows={1}
                style={{ overflow: "hidden" }}
              />
              {mediaFiles.length > 0 && (
                <div className="mt-3 flex flex-row gap-2 overflow-x-auto scrollbar-hide">
                  {mediaFiles.map((file, index) => (
                    <div key={index} className="relative flex-shrink-0 group">
                      {file.type.startsWith("image/") ? (
                        <img
                          src={URL.createObjectURL(file)}
                          alt="Preview"
                          className="w-24 h-24 object-cover rounded-lg"
                        />
                      ) : file.type.startsWith("video/") ? (
                        <video
                          src={URL.createObjectURL(file)}
                          controls
                          className="w-24 h-24 object-cover rounded-lg"
                        />
                      ) : (
                        <div className="flex items-center justify-center w-24 h-24">
                          <Icons.image className="h-8 w-8 text-gray-400" />
                        </div>
                      )}
                      <button
                        className="absolute top-1 right-1 bg-black/80 rounded-full p-2 text-white z-20"
                        onClick={() => removeFile(index)}
                      >
                        <Icons.close className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <ComposerPreviews attachments={attachments} />
              {scheduledFor && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-800/60 px-3 py-2">
                  <Clock className="h-4 w-4 shrink-0 text-neutral-400" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-300">
                    Goes out {formatScheduleLabel(scheduledFor)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsSchedulePickerOpen(true)}
                    className="shrink-0 text-[13px] font-semibold text-white hover:underline cursor-pointer"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduledFor(null)}
                    className="shrink-0 rounded-full p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white cursor-pointer"
                    aria-label="Remove schedule"
                  >
                    <Icons.close className="h-3 w-3" />
                  </button>
                </div>
              )}
              {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*,video/*"
                multiple
                onChange={handleFileSelect}
              />
              <div className="flex items-center gap-4 mt-4">
                <ComposerToolbar
                  attachments={attachments}
                  onPickImage={handleImageButtonClick}
                  mediaCount={mediaFiles.length}
                />
                <button className="text-neutral-500">
                  <Icons.hashtag className="h-5 w-5" />
                </button>
                {content.length > 0 && (
                  <span className="text-sm text-gray-500 ml-auto">
                    {content.length}/500
                  </span>
                )}
              </div>
              <div className="flex justify-between items-center mt-6">
                <div className="relative" ref={replyDropdownRef}>
                  <p
                    className="text-neutral-500 cursor-pointer"
                    onClick={() => setIsReplyDropdownOpen(!isReplyDropdownOpen)}
                  >
                    {replyText}
                  </p>
                  <ResponsiveMenu
                      open={isReplyDropdownOpen}
                      onClose={() => setIsReplyDropdownOpen(false)}
                      title="Who can reply & quote"
                      className="absolute left-0 bottom-[100%] mb-1 w-[250px] bg-[#181818] rounded-2xl border border-neutral-700 shadow-xl z-[999]"
                    >
                      <div className="p-2">
                        <button
                          className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                          onClick={() => {
                            setReplyText("Anyone can reply & quote");
                            setIsReplyDropdownOpen(false);
                          }}
                        >
                          <span>Anyone</span>
                        </button>
                        <button
                          className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                          onClick={() => {
                            setReplyText("Profiles you follow can reply & quote");
                            setIsReplyDropdownOpen(false);
                          }}
                        >
                          <span>Profiles you follow</span>
                        </button>
                        <button
                          className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                          onClick={() => {
                            setReplyText("Profiles you mention can reply & quote");
                            setIsReplyDropdownOpen(false);
                          }}
                        >
                          <span>Mentioned only</span>
                        </button>
                      </div>
                    </ResponsiveMenu>
                </div>
                <button
                  className={`px-4 py-2 rounded-full font-medium ${
                    isLoading || (!content.trim() && mediaFiles.length === 0 && !attachments.hasAttachment)
                      ? "bg-gray-600 text-gray-400 cursor-not-allowed"
                      : "bg-white text-black hover:bg-gray-200 transition-colors"
                  }`}
                  onClick={handleSubmit}
                  disabled={isLoading || (!content.trim() && mediaFiles.length === 0 && !attachments.hasAttachment)}
                >
                  {isLoading
                    ? scheduledFor
                      ? "Scheduling..."
                      : "Posting..."
                    : scheduledFor
                      ? "Schedule"
                      : "Post"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ComposerSheets attachments={attachments} />

      {isSchedulePickerOpen && (
        <SchedulePickerSheet
          value={scheduledFor}
          kind="Comment"
          onDone={setScheduledFor}
          onClose={() => setIsSchedulePickerOpen(false)}
        />
      )}
    </div>
  );
};

export default Reply;