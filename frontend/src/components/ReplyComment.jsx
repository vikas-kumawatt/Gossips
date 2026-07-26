import React, { useContext, useState, useRef, useEffect } from "react";
import { Icons } from "./icons";
import { UserContext } from "../contexts/UserContext";
import axios from "axios";
import { Toaster, toast } from "react-hot-toast";
import { REPLY_RESTRICTED_TEXT } from "../lib/replyAudience";
import {
  ComposerPreviews,
  ComposerSheets,
  ComposerToolbar,
} from "./ComposerAttachments";
import useComposerAttachments from "../hooks/useComposerAttachments";

const ReplyComment = ({ isOpen, onClose, commentId, parentId = null }) => {
  const { userAuth, userAuth: {token} } = useContext(UserContext);
  const [content, setContent] = useState("");
  const [mediaFiles, setMediaFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const cardRef = useRef(null);

  // GIF, audio, poll and location — shared with the other two composers.
  const attachments = useComposerAttachments({
    mediaCount: mediaFiles.length,
    clearMedia: () => setMediaFiles([]),
  });

  useEffect(() => {
    const handleOutsideClick = (event) => {
      // Attachment sheets are portals at document.body, so a click inside one
      // looks "outside" this card and would otherwise close the composer.
      if (attachments.openSheet) return;
      if (cardRef.current && !cardRef.current.contains(event.target)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [onClose, attachments.openSheet]);

  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  const resetForm = () => {
    setContent("");
    setMediaFiles([]);
    setError("");
  };

  if (!isOpen) return null;

  const handleContentChange = (e) => {
    setContent(e.target.value);

    const textarea = textareaRef.current;
    textarea.style.height = 'auto'; 
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
    const newFiles = [...mediaFiles];
    newFiles.splice(index, 1);
    setMediaFiles(newFiles);
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
      formData.append("commentId", commentId);
      attachments.appendTo(formData);
      
      if (parentId) {
        formData.append("parentId", parentId);
      }
      
      mediaFiles.forEach(file => {
        formData.append("media", file);
      });

      const response = await axios.post(
        import.meta.env.VITE_SERVER + "/reply/nested-comment", 
        formData, 
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data",
          },
        }
      );

      if (response.status === 201) {
        toast.success("Reply posted");
   
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
      <Toaster />
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
            <button className="text-gray-400 hover:text-white transition-colors">
              <Icons.more className="h-6 w-6" />
            </button>
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
                style={{ overflow: 'hidden' }}
              />
              
              {/* Display selected media files */}
              {mediaFiles.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {mediaFiles.map((file, index) => (
                    <div key={index} className="relative">
                      <div className="w-24 h-24 rounded-lg bg-neutral-800 overflow-hidden">
                        {file.type.startsWith("image/") ? (
                          <img 
                            src={URL.createObjectURL(file)} 
                            alt="Preview" 
                            className="w-full h-full object-cover" 
                          />
                        ) : file.type.startsWith("video/") ? (
                            <video
                              src={URL.createObjectURL(file)}
                              controls
                              className="w-full h-full object-cover"
                            />
                          ) : (
                          <div className="flex items-center justify-center h-full">
                            <Icons.image className="h-8 w-8 text-gray-400" />
                          </div>
                        )}
                      </div>
                      <button 
                        className="absolute -top-2 -right-2 bg-red-500 rounded-full p-1 text-white"
                        onClick={() => removeFile(index)}
                      >
                        <Icons.close className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <ComposerPreviews attachments={attachments} />
              {error && (
                <p className="text-red-500 text-sm mt-2">{error}</p>
              )}

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
                <button className="text-gray-500">
                  <Icons.hashtag className="h-5 w-5" />
                </button>
                {content.length > 0 && (
                  <span className="text-sm text-gray-500 ml-auto">
                    {content.length}/500
                  </span>
                )}
              </div>
              <div className="flex justify-between items-center mt-6">
                <p className="text-sm text-gray-500">
                  Anyone can reply & quote
                </p>
                <button 
                  className={`px-4 py-2 rounded-full font-medium ${
                    isLoading || (!content.trim() && mediaFiles.length === 0 && !attachments.hasAttachment)
                      ? "bg-gray-600 text-gray-400 cursor-not-allowed" 
                      : "bg-white text-black hover:bg-gray-200 transition-colors"
                  }`}
                  onClick={handleSubmit}
                  disabled={isLoading || (!content.trim() && mediaFiles.length === 0 && !attachments.hasAttachment)}
                >
                  {isLoading ? "Posting..." : "Post"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ComposerSheets attachments={attachments} />
    </div>
  );
};

export default ReplyComment;