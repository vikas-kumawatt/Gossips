import React, {
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
} from "react";
import { Icons } from "./icons";
import { Check, Clock, MapPin, Mic } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { UserContext } from "../contexts/UserContext";
import axios from "axios";
import { toast } from "react-hot-toast";
import PostCard from "./PostCard";
import SchedulePickerSheet from "./SchedulePickerSheet";
import ResponsivePanel from "./ui/responsive-panel";
import { formatScheduleLabel } from "../lib/schedule";
import { formatDuration, normalizeMedia } from "../lib/mediaTypes";
import {
  ComposerPreviews,
  ComposerSheets,
  ComposerToolbar,
} from "./ComposerAttachments";
import useComposerAttachments from "../hooks/useComposerAttachments";
import ResponsiveMenu from "./ui/ResponsiveMenu";
import {
  REPLY_AUDIENCE_OPTIONS,
  getReplyTriggerText,
  REPLY_RESTRICTED_TEXT,
} from "../lib/replyAudience";

/**
 * What you're quoting, as shown while composing.
 *
 * Previously this was two copy-pasted blocks that rendered only text and
 * images, so quoting a poll, a voice clip or a verified account showed a
 * blank-looking card that didn't match what would be posted.
 */
const QuotedPreview = ({ content, author }) => {
  const media = normalizeMedia(content.media);
  const audio = media.find((m) => m.type === "audio");
  const visuals = media.filter((m) => m.type !== "audio");

  return (
    <div className="mt-4 p-3 border border-neutral-700 rounded-lg">
      <div className="flex gap-2">
        <img
          className="w-6 h-6 rounded-full object-cover shrink-0"
          src={author.profilePic}
          alt=""
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <p className="text-white font-medium text-sm truncate">
              {author.username}
            </p>
            {(author.isVerified ||
              (author.verificationBadge &&
                author.verificationBadge !== "none")) && (
              <span className="inline-flex shrink-0 items-center">
                <Icons.verified />
              </span>
            )}
            {content.isAiGenerated && (
              <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-800/60 px-1.5 py-[1px] text-[10px] text-neutral-300">
                <Icons.ai className="h-3 w-3" />
                AI
              </span>
            )}
          </div>

          {content.location?.name && (
            <p className="mt-0.5 flex items-center gap-1 text-[12px] text-neutral-500">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{content.location.name}</span>
            </p>
          )}

          {content.content && (
            <p className="text-gray-300 text-sm break-words">
              {content.content}
            </p>
          )}

          {/* A poll can't be voted on from here, so it's shown as a summary
              rather than a live ballot. */}
          {content.poll?.question && (
            <div className="mt-2 rounded-lg border border-neutral-700 p-2">
              <p className="text-[13px] font-medium text-white break-words">
                {content.poll.question}
              </p>
              <p className="mt-1 text-[12px] text-neutral-500">
                Poll · {content.poll.options?.length || 0} options
              </p>
            </div>
          )}

          {/* A summary, not a player: the composer isn't the place to listen,
              and an embedded player here would fight the one on the post. */}
          {audio && (
            <p className="mt-2 flex items-center gap-2 rounded-lg border border-neutral-700 px-2 py-1.5 text-[13px] text-neutral-300">
              <Mic className="h-3.5 w-3.5 shrink-0" />
              Audio clip
              {Number.isFinite(audio.duration) && (
                <span className="text-neutral-500">
                  {formatDuration(audio.duration)}
                </span>
              )}
            </p>
          )}

          {visuals.length > 0 && (
            <div className="mt-2 flex flex-row gap-2 overflow-x-auto scrollbar-hide">
              {visuals.map((item) => (
                <div key={item.url} className="relative flex-shrink-0">
                  {item.type === "video" ? (
                    <video
                      src={item.url}
                      className="w-24 h-24 rounded-lg object-cover"
                    />
                  ) : (
                    <img
                      src={item.url}
                      alt=""
                      className="w-24 h-24 rounded-lg object-cover"
                    />
                  )}
                  {item.type === "gif" && (
                    <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-1 py-[1px] text-[9px] font-bold text-white">
                      GIF
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const CreatePost = ({
  isOpen,
  onClose,
  onPostCreated,
  quotedPost: quotedPostProp,
  quotedComment: quotedCommentProp,
  quotedAuthor: quotedAuthorProp,
}) => {
  const {
    userAuth,
    userAuth: { token },
  } = useContext(UserContext);
  const navigate = useNavigate();

  // A quote restored from a saved draft. Loading a draft used to drop its
  // quote, so publishing turned a quote post into a plain one.
  const [draftQuote, setDraftQuote] = useState(null);
  const quotedPost = quotedPostProp || draftQuote?.quotedPost || null;
  const quotedComment = quotedCommentProp || draftQuote?.quotedComment || null;
  const quotedAuthor = quotedAuthorProp || draftQuote?.author || null;
  const [content, setContent] = useState("");
  const [mediaFiles, setMediaFiles] = useState([]);
  // Saved uploads are remote assets, not File objects. Keep their draft and
  // URL selection separately so publishing can reuse only media we own.
  const [sourceDraftMedia, setSourceDraftMedia] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSaveDraftDialog, setShowSaveDraftDialog] = useState(false);
  const [showDraftPostsDialog, setShowDraftPostsDialog] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [draftsCursor, setDraftsCursor] = useState(null);
  const [hasMoreDrafts, setHasMoreDrafts] = useState(true);
  const [isDraftsLoading, setIsDraftsLoading] = useState(false);
  const [draftsLoadTrigger, setDraftsLoadTrigger] = useState(0);
  const [isMoreDropdownOpen, setIsMoreDropdownOpen] = useState(false);
  const [isReplyDropdownOpen, setIsReplyDropdownOpen] = useState(false);
  const [whoCanReply, setWhoCanReply] = useState("anyone");
  // Author-declared AI disclosure, sent with the post and shown to everyone.
  const [isAiGenerated, setIsAiGenerated] = useState(false);
  // When set, the post is queued instead of published. A Date in local time.
  const [scheduledFor, setScheduledFor] = useState(null);
  const [isSchedulePickerOpen, setIsSchedulePickerOpen] = useState(false);
  // GIF, audio, poll and location — one implementation shared by all three
  // composers. Photos stay in this component's own mediaFiles state.
  const attachments = useComposerAttachments({
    mediaCount: mediaFiles.length,
    clearMedia: () => {
      setMediaFiles([]);
      setSourceDraftMedia(null);
    },
  });
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const cardRef = useRef(null);
  const moreDropdownRef = useRef(null);
  const replyDropdownRef = useRef(null);
  const observer = useRef();

  useEffect(() => {
    const handleOutsideClick = (event) => {
      // The picker is a portal at document.body, so every click inside it
      // looks "outside" the card and would otherwise close the composer.
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
        if (
          content.trim() ||
          mediaFiles.length > 0 ||
          attachments.hasAttachment
        ) {
          setShowSaveDraftDialog(true);
        } else {
          onClose();
        }
        setIsMoreDropdownOpen(false);
        setIsReplyDropdownOpen(false);
      } else {
        if (
          moreDropdownRef.current &&
          !moreDropdownRef.current.contains(event.target)
        ) {
          setIsMoreDropdownOpen(false);
        }
        if (
          replyDropdownRef.current &&
          !replyDropdownRef.current.contains(event.target)
        ) {
          setIsReplyDropdownOpen(false);
        }
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [
    onClose,
    content,
    mediaFiles,
    isSchedulePickerOpen,
    attachments.hasAttachment,
    attachments.openSheet,
    isMoreDropdownOpen,
    isReplyDropdownOpen,
  ]);

  useEffect(() => {
    if (isOpen) {
      resetForm();
    }
    // Resetting on every `resetForm` identity change would discard an open
    // composition. This effect intentionally reacts only to opening the modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (showDraftPostsDialog) {
      fetchDrafts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDraftPostsDialog, draftsLoadTrigger]);

  useEffect(() => {
    const isAnyModalOpen =
      isOpen || showSaveDraftDialog || showDraftPostsDialog;
    document.body.style.overflow = isAnyModalOpen ? "hidden" : "unset";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen, showSaveDraftDialog, showDraftPostsDialog]);

  const resetForm = () => {
    setContent("");
    setMediaFiles([]);
    setSourceDraftMedia(null);
    setError("");
    setDrafts([]);
    setDraftsCursor(null);
    setDraftsLoadTrigger(0);
    setHasMoreDrafts(true);
    setIsMoreDropdownOpen(false);
    setIsReplyDropdownOpen(false);
    setWhoCanReply("anyone");
    setDraftQuote(null);
    setIsAiGenerated(false);
    setScheduledFor(null);
    setIsSchedulePickerOpen(false);
    attachments.reset();
  };

  const fetchDrafts = async () => {
    if (!token || isDraftsLoading || !hasMoreDrafts) return;

    setIsDraftsLoading(true);
    try {
      const response = await axios.get(
        import.meta.env.VITE_SERVER + "/posts/drafts",
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            cursor: draftsCursor,
            limit: 10,
          },
        },
      );

      const newDrafts = response.data.drafts.filter(
        (draft) => !drafts.some((d) => d._id === draft._id),
      );

      setDrafts((prevDrafts) => [...prevDrafts, ...newDrafts]);
      setDraftsCursor(response.data.pageInfo?.nextCursor || null);
      setHasMoreDrafts(response.data.pageInfo?.hasNextPage ?? false);
    } catch (err) {
      console.error("Failed to fetch drafts:", err);
    } finally {
      setIsDraftsLoading(false);
    }
  };

  const lastDraftRef = useCallback(
    (node) => {
      if (isDraftsLoading) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasMoreDrafts) {
            setDraftsLoadTrigger((prev) => prev + 1);
          }
        },
        { threshold: 0.5 },
      );

      if (node) observer.current.observe(node);
    },
    [isDraftsLoading, hasMoreDrafts],
  );

  if (!isOpen && !showDraftPostsDialog) return null;

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
    const validFiles = files.filter(
      (file) =>
        file.type.startsWith("image/") || file.type.startsWith("video/"),
    );
    if (validFiles.length !== files.length) {
      setError("Only images and videos are allowed");
    }
    if (!validFiles.length) return;
    // A fresh upload replaces restored draft media. The server cannot safely
    // merge an arbitrary client-selected subset with a remote draft asset.
    setSourceDraftMedia(null);
    setMediaFiles(validFiles);
    setError("");
  };

  const removeFile = (index) => {
    const newFiles = [...mediaFiles];
    const [removed] = newFiles.splice(index, 1);
    setMediaFiles(newFiles);
    if (removed?.existing) {
      setSourceDraftMedia((current) => {
        if (!current) return null;
        const urls = current.urls.filter((url) => url !== removed.url);
        return urls.length ? { ...current, urls } : null;
      });
    }
  };

  const handleSubmit = async () => {
    if (
      !content.trim() &&
      mediaFiles.length === 0 &&
      !attachments.hasAttachment &&
      !quotedPost &&
      !quotedComment
    ) {
      setError("Post must have content, media, a poll or a quote");
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("content", content);
      formData.append("isDraft", "false");
      formData.append("whoCanReply", whoCanReply);
      formData.append("isAiGenerated", String(isAiGenerated));
      attachments.appendTo(formData);
      if (sourceDraftMedia) {
        formData.append("sourceDraftId", sourceDraftMedia.id);
        formData.append(
          "sourceDraftMedia",
          JSON.stringify(sourceDraftMedia.urls),
        );
      }
      if (scheduledFor) {
        formData.append("scheduledFor", scheduledFor.toISOString());
      }
      if (quotedPost) {
        formData.append("quotedPost", quotedPost._id);
        formData.append("isQuoteRepost", true);
      }
      if (quotedComment) {
        formData.append("quotedComment", quotedComment._id);
        formData.append("isQuoteComment", true);
      }
      mediaFiles
        .filter((file) => !file.existing)
        .forEach((file) => {
          formData.append("media", file);
        });
      const response = await axios.post(
        import.meta.env.VITE_SERVER + "/posts/create",
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data",
          },
        },
      );
      if (response.status === 201) {
        if (response.data.scheduled) {
          // Nothing to add to the feed — it isn't public yet.
          toast.success(`Scheduled for ${formatScheduleLabel(scheduledFor)}`);
        } else {
          toast.success("Posted");
          if (typeof onPostCreated === "function") {
            onPostCreated(response.data.post);
          }
        }
        resetForm();
        setTimeout(onClose, 800);
      }
    } catch (err) {
      if (err.response?.status === 403) {
        toast.error(REPLY_RESTRICTED_TEXT);
      } else {
        setError(err.response?.data?.message || "Failed to create post");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveToDraft = async () => {
    if (
      !content.trim() &&
      mediaFiles.length === 0 &&
      !attachments.hasAttachment &&
      !quotedPost &&
      !quotedComment
    ) {
      setError("Draft must have content, media, a poll or a quote");
      return;
    }
    setIsSavingDraft(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("content", content);
      formData.append("isDraft", "true");
      formData.append("whoCanReply", whoCanReply);
      formData.append("isAiGenerated", String(isAiGenerated));
      attachments.appendTo(formData);
      if (sourceDraftMedia) {
        formData.append("sourceDraftId", sourceDraftMedia.id);
        formData.append(
          "sourceDraftMedia",
          JSON.stringify(sourceDraftMedia.urls),
        );
      }
      if (quotedPost) {
        formData.append("quotedPost", quotedPost._id);
        formData.append("isQuoteRepost", true);
      }
      if (quotedComment) {
        formData.append("quotedComment", quotedComment._id);
        formData.append("isQuoteComment", true);
      }
      mediaFiles
        .filter((file) => !file.existing)
        .forEach((file) => {
          formData.append("media", file);
        });
      await axios.post(
        import.meta.env.VITE_SERVER + "/posts/save-draft",
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data",
          },
        },
      );
      toast.success("Saved to drafts");
      resetForm();
      setShowSaveDraftDialog(false);
      onClose();
    } catch {
      setError("Failed to save draft");
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleLoadDraft = (draftId) => {
    const draft = drafts.find((d) => d._id === draftId);
    setContent(draft.content || "");
    // Carry the draft's quote through, so publishing keeps it.
    const restoredQuote = draft.quotedPost || draft.quotedComment;
    setDraftQuote(
      restoredQuote
        ? {
            quotedPost: draft.quotedPost || null,
            quotedComment: draft.quotedComment || null,
            author: restoredQuote.author || null,
          }
        : null,
    );
    attachments.reset();
    const restoredMedia = normalizeMedia(draft.media);
    const audio = restoredMedia.find((item) => item.type === "audio");
    if (audio) {
      attachments.chooseAudio({ ...audio, existing: true });
    } else {
      setMediaFiles(restoredMedia.map((item) => ({ ...item, existing: true })));
    }
    if (restoredMedia.length) {
      setSourceDraftMedia({
        id: draft._id,
        urls: restoredMedia.map((item) => item.url),
      });
    }
    if (draft.poll?.question) {
      attachments.choosePoll({
        question: draft.poll.question,
        options: draft.poll.options.map((option) => option.text ?? option),
        durationMinutes: draft.poll.durationMinutes,
      });
    }
    if (draft.location) attachments.setLocation(draft.location);
    setShowDraftPostsDialog(false);
  };

  const handleImageButtonClick = () => {
    fileInputRef.current.click();
  };

  if (showSaveDraftDialog) {
    return (
      <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center px-4">
        <div className="bg-neutral-900 w-full max-w-[300px] rounded-2xl border border-neutral-600 text-center">
          <h2 className="text-lg font-medium text-white px-6 py-4">
            Save to drafts?
          </h2>
          <p className="text-gray-400 border-b pb-4 border-neutral-700 px-6">
            Save to drafts to edit and post at a later time.
            {/* Drafts have no schedule, so say so rather than dropping the
                time the user picked without a word. */}
            {scheduledFor && (
              <span className="mt-2 block text-[13px] text-neutral-500">
                The time you picked won't be kept — schedule it again from
                drafts.
              </span>
            )}
          </p>
          <div className="flex flex-col justify-center items-center">
            <button
              className={`py-4 w-full cursor-pointer font-bold border-b border-neutral-700 ${isSavingDraft ? "cursor-not-allowed opacity-50" : ""}`}
              onClick={handleSaveToDraft}
              disabled={isSavingDraft}
            >
              {isSavingDraft ? "Saving..." : "Save"}
            </button>
            <button
              className="py-4 w-full border-b border-neutral-700 text-red-500 cursor-pointer"
              onClick={() => {
                resetForm();
                setShowSaveDraftDialog(false);
                onClose();
              }}
            >
              Don't save
            </button>
            <button
              className="w-full py-4 cursor-pointer"
              onClick={() => setShowSaveDraftDialog(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (showDraftPostsDialog) {
    return (
      <ResponsivePanel
        title="Drafts"
        onClose={() => {
          setShowDraftPostsDialog(false);
          if (!isOpen) onClose();
        }}
      >
        <div className="pt-4">
          {drafts.length > 0 ? (
            drafts.map((draft, index) => {
              const isLastDraft = index === drafts.length - 1;
              return (
                <div
                  key={draft._id}
                  ref={isLastDraft ? lastDraftRef : null}
                  onClick={() => handleLoadDraft(draft._id)}
                  className="cursor-pointer mb-4 border-b border-neutral-700 px-4"
                >
                  <PostCard
                    item={draft}
                    author={userAuth}
                    hideActionsHeader={false}
                    hideActions={true}
                    isDraft={true}
                    onDelete={(id) => {
                      setDrafts(drafts.filter((d) => d._id !== id));
                      fetchDrafts();
                    }}
                    onCancel={() => {
                      setShowDraftPostsDialog(true);
                    }}
                  />
                </div>
              );
            })
          ) : (
            <div className="text-center py-10 text-neutral-400">
              {isDraftsLoading ? (
                <Icons.spinner className="animate-spin mx-auto h-8 w-8" />
              ) : (
                <div>
                  <Icons.draft className="h-16 w-16 mx-auto mb-2" />
                  <p className="font-medium">No drafts yet</p>
                  <p className="text-sm">Your drafts will appear here.</p>
                </div>
              )}
            </div>
          )}
          {isDraftsLoading && drafts.length > 0 && (
            <div className="flex justify-center py-4">
              <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
            </div>
          )}
        </div>
      </ResponsivePanel>
    );
  }

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center px-4">
      <div
        ref={cardRef}
        className="bg-neutral-900 w-full max-w-[600px] rounded-2xl border border-neutral-600 overflow-hidden"
      >
        <div className="flex items-center justify-between p-4">
          <button
            onClick={() => {
              if (
                content.trim() ||
                mediaFiles.length > 0 ||
                attachments.hasAttachment
              ) {
                setShowSaveDraftDialog(true);
              } else {
                onClose();
              }
            }}
            className="text-md hover:text-red-500 transition-colors cursor-pointer"
            disabled={isLoading}
          >
            Cancel
          </button>
          <p className="font-medium text-lg">
            {quotedPost
              ? "Quote Post"
              : quotedComment
                ? "Quote Comment"
                : "New gossip"}
          </p>
          <div className="flex gap-4">
            <button
              className="text-gray-400 hover:text-white transition-colors cursor-pointer"
              onClick={() => setShowDraftPostsDialog(true)}
            >
              <Icons.draft className="h-6 w-6" />
            </button>

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
                    <span>
                      {isAiGenerated ? "Remove AI label" : "Add AI label"}
                    </span>
                    {isAiGenerated ? (
                      <Check className="w-5 h-5" />
                    ) : (
                      <Icons.ai />
                    )}
                  </button>
                  <hr className="my-1 -mx-2 border-neutral-800" />
                  <button
                    className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                    onClick={() => {
                      setIsMoreDropdownOpen(false);
                      setIsSchedulePickerOpen(true);
                    }}
                  >
                    <span>
                      {scheduledFor ? "Change schedule" : "Schedule..."}
                    </span>
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
              className="w-10 h-10 rounded-full flex items-center justify-center border border-neutral-500"
              src={userAuth.profilePic}
              alt="Profile"
            />
            <div className="flex-1">
              <p className="text-white font-medium">{userAuth.username}</p>
              <textarea
                ref={textareaRef}
                placeholder={
                  quotedPost || quotedComment
                    ? "Add your comment..."
                    : "What's new?"
                }
                className="w-full bg-transparent text-gray-300 placeholder-gray-500 outline-none resize-none mt-1"
                value={content}
                onChange={handleContentChange}
                maxLength={500}
                rows={1}
                style={{ overflow: "hidden" }}
              />
              {(quotedPost || quotedComment) && quotedAuthor && (
                <QuotedPreview
                  content={quotedPost || quotedComment}
                  author={quotedAuthor}
                />
              )}
              {mediaFiles.length > 0 && (
                <div className="mt-3 flex flex-row gap-2 overflow-x-auto scrollbar-hide">
                  {mediaFiles.map((file, index) => (
                    <div key={index} className="relative flex-shrink-0 group">
                      {file.type && file.type.startsWith("image/") ? (
                        <img
                          src={file.url ? file.url : URL.createObjectURL(file)}
                          alt="Preview"
                          className="w-24 h-24 object-cover rounded-lg"
                        />
                      ) : file.type && file.type.startsWith("video/") ? (
                        <video
                          src={file.url ? file.url : URL.createObjectURL(file)}
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
                {content.length > 0 && (
                  <span className="text-sm text-neutral-500 ml-auto">
                    {content.length}/500
                  </span>
                )}
              </div>
              <div className="mt-6 flex justify-between items-center">
                <div className="relative" ref={replyDropdownRef}>
                  <p
                    className="text-neutral-500 cursor-pointer"
                    onClick={() => setIsReplyDropdownOpen(!isReplyDropdownOpen)}
                  >
                    {getReplyTriggerText(whoCanReply)}
                  </p>
                  <ResponsiveMenu
                    open={isReplyDropdownOpen}
                    onClose={() => setIsReplyDropdownOpen(false)}
                    title="Who can reply & quote"
                    className="absolute left-0 bottom-[100%] mb-1 w-[250px] bg-[#181818] rounded-2xl border border-neutral-700 shadow-xl z-[999]"
                  >
                    <div className="p-2">
                      {REPLY_AUDIENCE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          className="w-full flex justify-between items-center p-3 tracking-normal select-none font-semibold text-[15px] text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                          onClick={() => {
                            setWhoCanReply(option.value);
                            setIsReplyDropdownOpen(false);
                          }}
                        >
                          <span>{option.label}</span>
                          {whoCanReply === option.value && (
                            <Check className="h-4 w-4 text-white" />
                          )}
                        </button>
                      ))}
                    </div>
                  </ResponsiveMenu>
                </div>
                <button
                  className={`px-4 py-1.5 rounded-2xl font-medium ${
                    isLoading ||
                    (!content.trim() &&
                      mediaFiles.length === 0 &&
                      !attachments.hasAttachment &&
                      !quotedPost &&
                      !quotedComment)
                      ? "border text-neutral-600 cursor-not-allowed"
                      : "bg-white text-black hover:bg-gray-200 transition-colors"
                  }`}
                  onClick={handleSubmit}
                  disabled={
                    isLoading ||
                    (!content.trim() &&
                      mediaFiles.length === 0 &&
                      !attachments.hasAttachment &&
                      !quotedPost &&
                      !quotedComment)
                  }
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
          kind="Post"
          onDone={setScheduledFor}
          onClose={() => setIsSchedulePickerOpen(false)}
        />
      )}
    </div>
  );
};

export default CreatePost;
