import React, {
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { UserContext } from "../contexts/UserContext";
import { useChat } from "../contexts/ChatContext";
import { useReport } from "../contexts/ReportContext";
import { useParams, useNavigate } from "react-router-dom";
import { Icons } from "../components/icons";
import SharedPostCard from "../components/Chat/SharedPostCard";
import { chatAPI } from "../services/api";
import PollBubble from "../components/Chat/PollBubble";
import CreatePollSheet from "../components/Chat/CreatePollSheet";
import ChatLockPrompt from "../components/Chat/ChatLockPrompt";
import ReconnectBanner from "../components/Chat/ReconnectBanner";
import VoiceNoteBubble from "../components/Chat/VoiceNoteBubble";
import ChatVideoBubble from "../components/Chat/ChatVideoBubble";
import LongPressArea from "../components/Chat/LongPressArea";
import { downloadMedia } from "../lib/downloadMedia";
import { lockedChatIdFromError } from "../services/chatUnlock";
import { canEditMessage } from "../utils/messageEditing";
import EmojiPicker from "emoji-picker-react";
import ResponsiveMenu from "../components/ui/ResponsiveMenu";

const MESSAGE_RATE_LIMIT = 1000;
const MAX_MESSAGE_LENGTH = 10000;
// Matches multer's limit on the server. It was 100MB here against 50MB there,
// so a 60MB file passed this check, uploaded, and then failed.
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const GroupChatPage = () => {
  const { userAuth } = useContext(UserContext);
  const currentUserId = userAuth?._id || userAuth?.id;
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { openReport } = useReport();

  const {
    messages,
    threadLoading: messagesLoading,
    threadError: messagesError,
    actions: {
      loadGroupMessages,
      sendGroupMessage,
      editMessage, // Context handles if it's group message via messageId?
      unsendMessage,
      deleteMessageForMe, // Context handles logic
      pinMessage,
      voteInPoll,
      setCurrentConversation,
      markConversationAsRead,
      hydrateThreadFromCache,
    },
  } = useChat();

  const [newMessage, setNewMessage] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [group, setGroup] = useState(null); // Group info
  const [loading, setLoading] = useState(true);
  const [isSending, setIsSending] = useState(false); // Corrected declaration
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [mediaPreview, setMediaPreview] = useState(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [error, setError] = useState(null); // Added missing error state
  const [showPollComposer, setShowPollComposer] = useState(false);
  // Groups had no pinned bar at all — the route existed and always returned
  // empty, because the handler built a DM key from the group id.
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [pinnedDismissed, setPinnedDismissed] = useState(false);
  const [hasMore, setHasMore] = useState(true); // Added missing hasMore state
  // The chat lock, enforced server-side — see UserConversationPage for the
  // reasoning; `lockedChats` holds `group_<id>` entries too.
  const [lockedChatId, setLockedChatId] = useState(null);
  const [unlockAttempt, setUnlockAttempt] = useState(0);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastMessageTime = useRef(0);
  const hasFetchedData = useRef(false);
  const topSentinelRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  const isInitialLoadRef = useRef(true);
  const isLoadingMoreRef = useRef(false);

  const loadPinned = useCallback(async () => {
    try {
      const res = await chatAPI.getGroupPinnedMessages(groupId);
      setPinnedMessages(res.pinnedMessages || []);
    } catch (err) {
      // A missing pinned bar isn't worth interrupting the thread over.
      console.error("Error fetching group pinned messages:", err);
    }
  }, [groupId]);

  useEffect(() => {
    setPinnedDismissed(false);
    if (groupId) loadPinned();
  }, [groupId, loadPinned]);

  // Voting is a socket emit, so the only failure it can report synchronously is
  // "no socket" — the result arrives later as a pollUpdated broadcast.
  const handleVote = useCallback(
    (messageId, optionIds) => {
      try {
        voteInPoll(messageId, optionIds);
      } catch (err) {
        console.error("Error voting in poll:", err);
        setError("Couldn't record your vote — check your connection.");
      }
    },
    [voteInPoll]
  );

  // Initialization Effect
  useEffect(() => {
    const initChat = async () => {
      // If we already fetched for this groupId, skip?
      // UserConversationPage resets hasFetchedData on params change.
      if (hasFetchedData.current === groupId) return;
      hasFetchedData.current = groupId;

      setLoading(true);
      setError(null);

      /*
       * The thread from its last snapshot, alongside the request rather than
       * before it — nothing here is awaited, so the network is never delayed, and
       * the provider declines if the fetch has already filled the thread. `loading`
       * is released as soon as something is painted so the spinner stops hiding it.
       */
      hydrateThreadFromCache("group", groupId)
        .then((painted) => {
          if (painted) setLoading(false);
        })
        .catch(() => {});

      try {
        /*
         * Set the conversation BEFORE loading, not after.
         *
         * SET_CURRENT_CONVERSATION clears the message array — that is how
         * switching chats avoids flashing the previous thread. Dispatching it
         * after loadGroupMessages threw away the page that had just been
         * fetched, so a group opened from the chat list showed its header and
         * an empty thread until a live message happened to arrive. The DM page
         * has always had the ordering the other way round.
         */
        setCurrentConversation(groupId);

        // response contains { messages, hasMore, groupInfo }
        const response = await loadGroupMessages(groupId);

        if (response && response.groupInfo) {
          setGroup(response.groupInfo);
          setHasMore(response.hasMore); // Update hasMore based on response
        }
      } catch (err) {
        // A locked group is a prompt, not a failure — see ChatLockPrompt.
        const locked = lockedChatIdFromError(err);
        if (locked) {
          setLockedChatId(locked);
          hasFetchedData.current = null;
          return;
        }
        console.error("Error in initChat:", err);
        setError("Failed to load group. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    if (groupId && userAuth.token) {
      initChat();
    }

    return () => {
      hasFetchedData.current = null;
      setCurrentConversation(null);
    };
  }, [
    groupId,
    userAuth.token,
    loadGroupMessages,
    setCurrentConversation,
    hydrateThreadFromCache,
    // Bumped once the PIN prompt has stored a grant, so the load retries.
    unlockAttempt,
  ]);

  const loadMoreMessages = useCallback(async () => {
    // A ref, not the `loadingMore` state: the observer is rebuilt whenever this
    // callback's identity changes and re-observing an already-intersecting
    // sentinel fires immediately, so two callbacks in one tick would both see
    // false and request the same cursor.
    if (isLoadingMoreRef.current) return;
    if (!hasMore || messagesLoading) return;
    isLoadingMoreRef.current = true;

    const container = messagesContainerRef.current;
    if (container) {
      scrollAnchorRef.current = {
        prevScrollHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
      };
    }

    setLoadingMore(true);
    try {
      const oldestMessage = messages[0];
      if (!oldestMessage) {
        scrollAnchorRef.current = null;
        return;
      }

      const cursor = oldestMessage
        ? btoa(
            JSON.stringify({
              createdAt: oldestMessage.createdAt,
              _id: oldestMessage._id,
            })
          )
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "")
        : null;
      await loadGroupMessages(groupId, cursor);
    } catch (err) {
      console.error("Error loading more messages:", err);
    } finally {
      isLoadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, messagesLoading, messages, loadGroupMessages, groupId]);

  /*
   * Group pagination, which has never worked.
   *
   * This observed `[data-first-message]` — an attribute that appears nowhere in
   * the app, so it observed nothing and older group messages could not be
   * loaded at all. It also ran before the list had mounted and had no
   * dependency that changed afterwards, the same dead-observer bug the DM page
   * had. Now: a real sentinel, gated on `loading`.
   */
  useEffect(() => {
    if (loading || !topSentinelRef.current || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreMessages();
      },
      { root: messagesContainerRef.current, rootMargin: "100px", threshold: 0 }
    );

    observer.observe(topSentinelRef.current);
    return () => observer.disconnect();
  }, [loading, hasMore, loadMoreMessages]);

  useEffect(() => {
    if (messagesError) {
      setError(messagesError);
    }
  }, [messagesError]);

  /*
   * This scrolled to the bottom on every change to the message array — so
   * loading older messages threw the user straight back to the newest one,
   * which made pagination useless even once the observer was attached.
   */
  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (loading || !container || messages.length === 0) return;

    if (scrollAnchorRef.current) {
      const { prevScrollHeight, prevScrollTop } = scrollAnchorRef.current;
      container.scrollTop = container.scrollHeight - prevScrollHeight + prevScrollTop;
      scrollAnchorRef.current = null;
      return;
    }

    if (isInitialLoadRef.current) {
      container.scrollTop = container.scrollHeight;
      isInitialLoadRef.current = false;
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 150) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading, loadingMore]);

  /*
   * Mark the group read.
   *
   * This page never did — so a group's badge counted up while you sat reading
   * it, no read watermark was ever written for the group, and every message you
   * had ever received there stayed unread until you happened to click the group
   * in the chat list. Mirrors the DM page: newest inbound message only, and only
   * while the tab is actually visible.
   */
  const newestInboundId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const senderId = messages[i]?.sender?._id || messages[i]?.sender;
      if (String(senderId) !== String(currentUserId)) return messages[i]._id;
    }
    return null;
  }, [messages, currentUserId]);

  useEffect(() => {
    if (!newestInboundId || !groupId) return;

    const markIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      markConversationAsRead(null, `group_${groupId}`, `g:${groupId}`);
    };

    markIfVisible();
    document.addEventListener("visibilitychange", markIfVisible);
    return () => document.removeEventListener("visibilitychange", markIfVisible);
  }, [newestInboundId, groupId, markConversationAsRead]);

  // No typing indicator for groups: the server's `typing` handler takes a
  // receiverId and emits to that one user, so there is nothing to broadcast to
  // a room yet.

  const handleInputChange = (e) => {
    const value = e.target.value;
    if (editingMessage) {
      setNewMessage(value);
      return;
    }
    setNewMessage(value);
  };

  const validateMessage = () => {
    if (
      !newMessage.trim() &&
      !fileInputRef.current?.files?.length &&
      !mediaPreview
    ) {
      return "Message cannot be empty";
    }
    if (newMessage.length > MAX_MESSAGE_LENGTH) {
      return `Message too long (${MAX_MESSAGE_LENGTH} characters maximum)`;
    }
    const now = Date.now();
    if (now - lastMessageTime.current < MESSAGE_RATE_LIMIT) {
      return "Please wait a moment before sending another message";
    }
    return null;
  };

  const sendMessage = async (media = [], messageType = "text") => {
    if (editingMessage) {
      await handleEditMessage();
      return;
    }
    const validationError = validateMessage();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSending(true);
    const tempId = `temp-${Date.now()}-${Math.random()}`;

    const messageData = {
      tempId,
      groupId,
      senderId: currentUserId,
      senderUsername: userAuth.username,
      content: newMessage.trim(),
      media,
      messageType,
      replyTo: replyingTo
        ? {
            _id: replyingTo._id,
            content: replyingTo.content,
            senderUsername: replyingTo.senderUsername,
            senderId: replyingTo.sender?._id || replyingTo.sender,
            messageType: replyingTo.messageType,
          }
        : null,
    };

    try {
      await sendGroupMessage(messageData);
      setNewMessage("");
      setShowEmojiPicker(false);
      setReplyingTo(null);
      setError(null);
      lastMessageTime.current = Date.now();
    } catch (err) {
      console.error("Error sending message:", err);
      // The server's own reason — "You're muted in this group", "Slow mode is on —
      // wait 12s" — reaches here now that the send is acknowledged. A generic
      // string threw away the only part the user could act on.
      setError(err?.message || "Failed to send message");
    } finally {
      setIsSending(false);
    }
  };

  const handleEditMessage = async () => {
    if (!editingMessage || !newMessage.trim()) {
      setError("Message cannot be empty");
      return;
    }
    try {
      await editMessage(editingMessage._id, newMessage.trim());
      // Only on success. The provider used to swallow the rejection, so this
      // ran either way and the edit the user had typed was gone.
      setNewMessage("");
      setEditingMessage(null);
      setError(null);
    } catch (err) {
      console.error("Error editing message:", err);
      setError(
        err?.response?.data?.error || "Couldn't save that edit. Your text is still here."
      );
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSending) sendMessage();
    } else if (e.key === "Escape") {
      setEditingMessage(null);
      setNewMessage("");
      setReplyingTo(null);
      setShowEmojiPicker(false);
    }
  };

  const handleEmojiClick = (emojiObject) => {
    if (newMessage.length + emojiObject.emoji.length <= MAX_MESSAGE_LENGTH) {
      setNewMessage((prev) => prev + emojiObject.emoji);
    }
  };

  const handleMediaSelect = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const file = files[0];
    if (file.size > MAX_FILE_SIZE) {
      setError(`File size too large. Max ${MAX_FILE_SIZE / 1024 / 1024}MB`);
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setMediaPreview({
      file,
      url: previewUrl,
      type: file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
            ? "audio"
            : "document",
    });
    setIsPreviewOpen(true);
    e.target.value = "";
  };

  const handleMediaUploadConfirm = async () => {
    if (!mediaPreview) return;
    const file = mediaPreview.file;
    const messageType =
      mediaPreview.type === "image"
        ? "media"
        : mediaPreview.type === "video"
          ? "media"
          : mediaPreview.type === "audio"
            ? "voice"
            : "file";

    /*
     * One field, named for the endpoint it's going to.
     *
     * This used to append the file as `file` and then, for voice, append the
     * same file *again* as `audio`. `/chats/upload/voice` is
     * `chatUpload.single("audio")`, and multer's single() aborts with
     * LIMIT_UNEXPECTED_FILE on the first file whose fieldname doesn't match —
     * `file` arrived first, so every group voice upload 400'd.
     */
    const isVoice = messageType === "voice";

    const formData = new FormData();
    formData.append(isVoice ? "audio" : "file", file);

    try {
      // Through chatAPI (#119): the shared client refreshes an expired token on 401,
      // which the hand-rolled Authorization header snapshotted at render time never
      // did — so a long composing session ended in a silent upload failure.
      //
      // The upload endpoints return a single flat object — { url, type, ... } from
      // /chats/upload and { url, duration, waveform } from /upload/voice. Reading
      // `.media` off it gave undefined, so every group attachment was sent with no
      // media at all and arrived as an empty bubble.
      const uploaded = isVoice
        ? await chatAPI.uploadVoice(formData)
        : await chatAPI.uploadMedia(formData);
      if (!uploaded?.url) throw new Error("Upload returned no file");

      await sendMessage([uploaded], messageType);

      setMediaPreview(null);
      setIsPreviewOpen(false);
    } catch (err) {
      console.error("Upload failed", err);
      setError("Failed to upload media");
    }
  };

  // Messages loaded from the server carry no `isOwn` flag — only the optimistic
  // send path sets one — so ownership has to be derived from the sender.
  const isOwnMessage = (msg) =>
    msg?.sender?._id === userAuth?.id || msg?.sender === userAuth?.id;

  /*
   * Anchors the menu at the press, falling back to the bubble.
   *
   * The inline handler this replaces read `e.clientX/clientY` straight off the
   * event, which is 0,0 for a keyboard-invoked menu — the same bug the DM page
   * already fixed. A long press arrives as a pointer event and does carry
   * coordinates.
   */
  const handleMessageContextMenu = (msg, event) => {
    event.preventDefault?.();
    event.stopPropagation?.();

    setSelectedMessage(msg);

    const rect = event.currentTarget?.getBoundingClientRect?.();
    const x = Number.isFinite(event.clientX) && event.clientX ? event.clientX : rect?.left ?? 0;
    const y = Number.isFinite(event.clientY) && event.clientY ? event.clientY : rect?.bottom ?? 0;
    setContextMenu({ x, y });
  };

  const handleContextMenuAction = async (action) => {
    if (!selectedMessage) return;
    // These reject now that the provider stopped swallowing errors, and an
    // unhandled rejection in a menu handler is a silent no-op to the user.
    const attempt = async (label, run) => {
      try {
        await run();
        setError(null);
      } catch (err) {
        console.error(`${label} failed`, err);
        setError(err?.response?.data?.error || `Couldn't ${label} that message.`);
      }
    };

    switch (action) {
      case "reply":
        setReplyingTo(selectedMessage);
        break;
      case "edit":
        setEditingMessage(selectedMessage);
        setNewMessage(selectedMessage.content);
        break;
      case "unsend":
        await attempt("unsend", () => unsendMessage(selectedMessage._id));
        break;
      case "delete":
        await attempt("delete", () => deleteMessageForMe(selectedMessage._id));
        break;
      case "pin":
        await attempt("pin", async () => {
          // The target state, so a double-click doesn't net zero.
          await pinMessage(selectedMessage._id, !selectedMessage.isPinned);
          await loadPinned();
        });
        break;
      case "copy":
        navigator.clipboard.writeText(selectedMessage.content);
        break;
      // Fetched to a blob rather than linked, because `download` on an anchor is
      // ignored cross-origin and this media lives on Cloudinary.
      case "download":
        await attempt("download", () =>
          Promise.all((selectedMessage.media || []).map((item) => downloadMedia(item)))
        );
        break;
      case "report":
        openReport({
          targetType: "message",
          targetId: selectedMessage._id,
          // sender is an id rather than a document on some payloads; without a
          // username the sheet just drops the Block/Mute follow-ups.
          username: selectedMessage.sender?.username,
          name: selectedMessage.sender?.name,
        });
        break;
    }
    setContextMenu(null);
    setSelectedMessage(null);
  };

  /*
   * Checked before the loading and not-found branches, because a locked group is
   * neither: nothing loaded and nothing is missing — a PIN is owed.
   */
  if (lockedChatId) {
    return (
      <div className="flex flex-col min-h-screen bg-black text-white">
        <ChatLockPrompt
          chatId={lockedChatId}
          onUnlocked={() => {
            setLockedChatId(null);
            setUnlockAttempt((n) => n + 1);
          }}
          onCancel={() => navigate("/chat")}
        />
      </div>
    );
  }

  if (loading && !messages.length) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        Loading group...
      </div>
    );
  }

  /*
   * Every failure used to collapse to a bare "Group not found" with no header
   * and no way back — a removed member, a deleted group and a dropped network
   * request were indistinguishable, and on desktop the only exit was the
   * browser's back button.
   */
  if (!group && !loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 min-h-screen bg-black text-white px-6 text-center">
        <Icons.group className="w-10 h-10 text-neutral-600" />
        <p className="text-neutral-300">
          {error || "This group isn't available."}
        </p>
        <p className="text-sm text-neutral-500">
          It may have been deleted, or you may no longer be a member.
        </p>
        <button
          onClick={() => navigate("/chat")}
          className="mt-2 px-4 py-2 rounded-full bg-neutral-800 hover:bg-neutral-700 text-sm"
        >
          Back to chats
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-black text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-neutral-900 border-b border-neutral-800">
        <div className="flex items-center gap-3">
          {/*
            Not md:hidden. The page now lives inside ChatLayout, but a group
            opened directly still needs an exit on desktop — this was the only
            back control and it was hidden at exactly the width where the
            two-pane layout used to disappear.
          */}
          <button
            onClick={() => navigate("/chat")}
            aria-label="Back to chats"
            className="mr-2"
          >
            <Icons.arrowLeft className="w-6 h-6" />
          </button>
          <div className="relative">
            <img
              src={group?.avatar || "/default-group-avatar.png"}
              alt={group?.name}
              className="w-10 h-10 rounded-full object-cover bg-neutral-800"
            />
          </div>
          <div>
            <h2 className="font-semibold text-white">{group?.name}</h2>
            <p className="text-xs text-neutral-400">
              {group?.memberCount || 0} members
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {/* Had no handler at all until the info page existed to open. */}
          <button
            onClick={() => navigate(`/chat/group/${groupId}/info`)}
            aria-label="Group info"
            className="text-neutral-400 hover:text-white"
          >
            <Icons.info className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Messages */}
      {/*
        Dismissible. One "Please wait a moment" used to pin this banner above
        the thread for the rest of the session — nothing anywhere cleared it.
      */}
      {error && (
        <div className="mx-4 mt-4 p-3 pr-10 relative bg-red-900/50 border border-red-500/50 rounded-lg text-red-200 text-sm text-center">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-red-500/20"
          >
            <Icons.close className="w-4 h-4" />
          </button>
        </div>
      )}
      <ReconnectBanner />

      {/* Outside the scroll container, like the DM page's — a summary that
          scrolls away with the oldest messages is never on screen. */}
      {pinnedMessages.length > 0 && !pinnedDismissed && (
        <div className="shrink-0 mx-2 mt-2 mb-1 p-3 bg-neutral-800 border-l-4 border-yellow-500 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Icons.pin className="w-4 h-4 text-yellow-500" />
              <span className="text-sm font-medium text-white">
                Pinned Messages
              </span>
            </div>
            <button
              onClick={() => setPinnedDismissed(true)}
              aria-label="Hide pinned messages"
              className="text-neutral-400 hover:text-white"
            >
              <Icons.close className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2 max-h-32 overflow-y-auto">
            {pinnedMessages.slice(0, 3).map((m) => (
              <button
                type="button"
                key={m._id}
                onClick={() => {
                  document
                    .getElementById(`msg-${m._id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                className="w-full text-left text-sm text-neutral-300 hover:bg-neutral-700 p-2 rounded"
              >
                <div className="text-xs text-neutral-400 mb-0.5">
                  {m.sender?.username || "Unknown"}
                </div>
                <div className="truncate">
                  {m.isDeleted
                    ? "This message was deleted"
                    : m.content || "Attachment"}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
        {/* The sentinel the observer watches. There wasn't one. */}
        <div ref={topSentinelRef} />
        {loadingMore && (
          <div className="text-center text-neutral-500 py-2">
            Loading more...
          </div>
        )}

        {messages.map((msg, index) => {
          const isOwn = isOwnMessage(msg);
          const showAvatar =
            !isOwn &&
            (index === 0 || messages[index - 1].sender._id !== msg.sender._id);

          return (
            <div
              key={msg._id || msg.tempId}
              // The anchor the pinned bar scrolls to. The DM page has always
              // carried one; groups had no pinned bar to need it.
              id={`msg-${msg._id}`}
              className={`flex ${isOwn ? "justify-end" : "justify-start"} group relative`}
            >
              {!isOwn && (
                <div
                  className={`w-8 h-8 rounded-full overflow-hidden mr-2 flex-shrink-0 ${!showAvatar ? "opacity-0" : ""}`}
                >
                  <img
                    src={msg.sender.profilePic || "/default-avatar.png"}
                    alt={msg.sender.username}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              <LongPressArea
                className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                  isOwn ? "bg-blue-600 text-white" : "bg-neutral-800 text-white"
                } ${msg.isDeleted ? "italic opacity-70" : ""}`}
                onTrigger={(e) => handleMessageContextMenu(msg, e)}
              >
                {!isOwn &&
                  (index === 0 ||
                    messages[index - 1].sender._id !== msg.sender._id) && (
                    <p className="text-xs text-blue-300 mb-1 font-medium">
                      {msg.sender.username}
                    </p>
                  )}

                {/*
                  `replyTo.sender`, not `replyTo.senderUsername` — no server
                  path has ever sent the latter, so the author line here was
                  always blank. Both transports now nested-populate the sender.
                */}
                {msg.replyTo && !msg.isDeleted && (
                  <div className="mb-2 p-2 bg-black/20 rounded text-sm border-l-2 border-white/50">
                    <p className="text-xs font-semibold">
                      {msg.replyTo.sender?.name ||
                        msg.replyTo.sender?.username ||
                        "Unknown"}
                    </p>
                    <p className="truncate opacity-80">
                      {msg.replyTo.isDeleted
                        ? "This message was deleted"
                        : msg.replyTo.content || "Media"}
                    </p>
                  </div>
                )}

                {/* !isDeleted: an unsent share kept its card on screen. */}
                {msg.messageType === "post_share" &&
                  msg.sharedContent &&
                  !msg.isDeleted && (
                    <div className={msg.content ? "mb-2" : ""}>
                      <SharedPostCard sharedContent={msg.sharedContent} />
                    </div>
                  )}

                {/*
                  Every media type, not just images.

                  This branched on `type === "image"` alone and left a placeholder
                  comment where the rest should have been, so a group video, GIF,
                  voice note or document rendered as an empty rounded box. Voice was
                  the worst of it: the group composer has always been able to record
                  and upload one, so the message was stored, delivered, counted in
                  the unread badge, previewed in the chat list as "Sent a voice
                  message" — and displayed as nothing at all.
                */}
                {msg.media && msg.media.length > 0 && !msg.isDeleted && (
                  <div className="mb-2 flex flex-col gap-1 w-fit max-w-full">
                    {msg.media.map((m, i) => {
                      if (m.type === "video") {
                        return <ChatVideoBubble key={i} item={m} cornerClass="rounded-xl" />;
                      }
                      // `voice` is what the upload endpoint returns and what the
                      // Message media enum persists; `audio` is what the optimistic
                      // preview uses. Both are voice notes.
                      if (m.type === "audio" || m.type === "voice") {
                        return (
                          <VoiceNoteBubble
                            key={i}
                            item={m}
                            isOwn={isOwn}
                            bubbleRadius="rounded-xl"
                          />
                        );
                      }
                      if (m.type === "image" || m.type === "gif" || m.type === "sticker") {
                        return (
                          <img
                            key={i}
                            src={m.url}
                            alt={m.type === "gif" ? "GIF" : "media"}
                            width={m.dimensions?.width || undefined}
                            height={m.dimensions?.height || undefined}
                            className="block max-w-full h-auto rounded-xl"
                            loading="lazy"
                          />
                        );
                      }
                      if (m.type === "document") {
                        return (
                          <div
                            key={i}
                            className="flex items-center gap-2.5 min-w-[190px] max-w-[260px] py-0.5"
                          >
                            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
                              <Icons.file className="w-5 h-5 text-white" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-medium truncate">{m.filename}</p>
                              {m.fileSize > 0 && (
                                <p className="text-[11px] text-white/40">
                                  {(m.fileSize / 1024 / 1024).toFixed(1)} MB
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                downloadMedia(m).catch((err) => {
                                  console.error("Failed to download document:", err);
                                  setError("Couldn't download that.");
                                })
                              }
                              aria-label={`Download ${m.filename || "file"}`}
                              className="opacity-50 hover:opacity-90 transition-opacity shrink-0"
                            >
                              <Icons.download className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                )}

                {msg.messageType === "poll" && msg.poll && !msg.isDeleted && (
                  <div className={msg.content ? "mb-2" : ""}>
                    <PollBubble
                      message={msg}
                      isOwn={isOwn}
                      onVote={handleVote}
                    />
                  </div>
                )}

                {msg.content && (
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                )}
                <div className="flex items-center justify-end gap-1 mt-1">
                  <span className="text-[10px] opacity-70">
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              </LongPressArea>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 bg-neutral-900 border-t border-neutral-800">
        {replyingTo && (
          <div className="mb-2 p-2 bg-neutral-800 rounded flex items-center justify-between">
            <div>
              <p className="text-xs text-blue-400">
                Replying to {replyingTo.senderUsername}
              </p>
              <p className="text-sm truncate text-neutral-300">
                {replyingTo.content}
              </p>
            </div>
            <button
              onClick={() => setReplyingTo(null)}
              className="text-neutral-400 hover:text-white"
            >
              <Icons.close className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Simplified input for brevity, assuming Icons struct */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach media"
            className="text-neutral-400 hover:text-white p-2"
          >
            <Icons.plus className="w-6 h-6" />
          </button>
          <button
            onClick={() => setShowPollComposer(true)}
            aria-label="Poll"
            className="text-neutral-400 hover:text-white p-2"
          >
            <Icons.poll className="w-6 h-6" />
          </button>
          {showPollComposer && (
            <CreatePollSheet
              groupId={groupId}
              onClose={() => setShowPollComposer(false)}
            />
          )}
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            multiple
            onChange={handleMediaSelect}
          />

          <div className="flex-1 relative">
            <input
              value={newMessage}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Message..."
              className="w-full bg-neutral-950 text-white rounded-full px-4 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white"
            >
              <Icons.smile className="w-5 h-5" />
            </button>
          </div>

          {newMessage.trim() || mediaPreview ? (
            <button
              onClick={() => sendMessage()}
              disabled={isSending}
              className="bg-blue-600 text-white p-2 rounded-full hover:bg-blue-700 disabled:opacity-50"
            >
              <Icons.send className="w-5 h-5" />
            </button>
          ) : (
            <button className="bg-neutral-800 text-white p-2 rounded-full hover:bg-neutral-700">
              <Icons.mic className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Context Menu, Emoji Picker, etc would go here as overlays */}
      <ResponsiveMenu
          open={Boolean(contextMenu)}
          onClose={() => setContextMenu(null)}
          title="Message"
          className="fixed bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 py-1"
          style={{ top: contextMenu?.y, left: contextMenu?.x }}
        >
          <button
            onClick={() => handleContextMenuAction("reply")}
            className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
          >
            <Icons.reply className="w-4 h-4" /> Reply
          </button>

          {/*
            isOwnMessage, not selectedMessage.isOwn. `isOwn` is set only on the
            optimistic object the send path builds, so it was absent from every
            message that came back from the server — meaning after a reload you
            could not edit or unsend your own group messages at all. The bubble
            beside it already aligned them correctly using the same helper.
          */}
          {(!selectedMessage || isOwnMessage(selectedMessage)) && (
            <>
              {/*
                Not offered where the server would refuse it: a poll, a call log, a
                shared post or anything past the fifteen-minute window. Opening edit
                mode only to have the save rejected is worse than no menu item.
                `isOwn` is absent on messages loaded from the server, so the type and
                age checks are applied to the row directly.
              */}
              {canEditMessage({ ...selectedMessage, isOwn: true }) && (
                <button
                  onClick={() => handleContextMenuAction("edit")}
                  className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
                >
                  <Icons.edit className="w-4 h-4" /> Edit
                </button>
              )}
              <button
                onClick={() => handleContextMenuAction("unsend")}
                className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2 text-red-400"
              >
                <Icons.trash className="w-4 h-4" /> Unsend
              </button>
            </>
          )}
          {/* Only where there is something to save, and never on a tombstone —
              an unsent message's media is gone from the CDN. */}
          {selectedMessage?.media?.length > 0 && !selectedMessage?.isDeleted && (
            <button
              onClick={() => handleContextMenuAction("download")}
              className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
            >
              <Icons.download className="w-4 h-4" />{" "}
              {selectedMessage.media.length > 1 ? "Download all" : "Download"}
            </button>
          )}
          <button
            onClick={() => handleContextMenuAction("delete")}
            className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2 text-red-400"
          >
            <Icons.trash className="w-4 h-4" /> Delete for Me
          </button>
          <button
            onClick={() => handleContextMenuAction("pin")}
            className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
          >
            <Icons.pin className="w-4 h-4" /> Pin
          </button>
          {selectedMessage && !isOwnMessage(selectedMessage) && (
            <button
              onClick={() => handleContextMenuAction("report")}
              className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2 text-red-400"
            >
              <Icons.report className="w-4 h-4" /> Report
            </button>
          )}
      </ResponsiveMenu>

      {/* Desktop only: the sheet has its own backdrop on a phone. */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-40 hidden md:block"
          onClick={() => setContextMenu(null)}
        />
      )}

      {showEmojiPicker && (
        <div className="absolute bottom-20 right-4 z-50">
          <EmojiPicker theme="dark" onEmojiClick={handleEmojiClick} />
        </div>
      )}

      {/* Media Preview Modal - Simplified */}
      {isPreviewOpen && mediaPreview && (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center p-4">
          <div className="bg-neutral-900 p-4 rounded-xl max-w-lg w-full">
            <h3 className="text-lg font-semibold mb-4">Send Media</h3>
            <div className="flex justify-center mb-4">
              {mediaPreview.type === "image" && (
                <img
                  src={mediaPreview.url}
                  className="max-h-[300px] object-contain"
                />
              )}
              {/* Others */}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setIsPreviewOpen(false);
                  setMediaPreview(null);
                }}
                className="px-4 py-2 rounded bg-neutral-700"
              >
                Cancel
              </button>
              <button
                onClick={handleMediaUploadConfirm}
                className="px-4 py-2 rounded bg-blue-600 text-white"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GroupChatPage;
