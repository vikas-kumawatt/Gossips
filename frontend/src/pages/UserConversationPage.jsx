import React, {
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { UserContext } from "../contexts/UserContext";
import { useChat } from "../contexts/ChatContext";
import { useBlock } from "../contexts/BlockContext";
import { useReport } from "../contexts/ReportContext";
import axios from "axios";
import { chatAPI } from "../services/api";
// import { io } from "socket.io-client"; // Handled by context
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Icons } from "../components/icons";
import SharedPostCard from "../components/Chat/SharedPostCard";
import { toast } from "react-hot-toast";
import EmojiPicker from "emoji-picker-react";
import GifPicker from "../components/GifPicker";
import RichText from "../components/RichText";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const MESSAGE_RATE_LIMIT = 1000;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MESSAGES_PER_PAGE = 50;

// ── Instagram-style voice note player bubble ──────────────────────────────
const VOICE_BUBBLE_GRADIENT = {
  background:
    "linear-gradient(to bottom, #C026D3, #A21CAF, #8B5CF6, #7C3AED, #5B21B6, #4F46E5, #2563EB, #1D4ED8, #C026D3, #A21CAF)",
  backgroundAttachment: "fixed",
};

const VoiceNoteBubble = ({ item, isOwn = false, bubbleRadius = "rounded-[18px]" }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(item.duration || 0);
  const audioRef = useRef(null);

  // Normalise waveform to 0-1 range for 32 display bars
  const waveformBars = useMemo(() => {
    if (item.waveform?.length >= 10) {
      const bars = [];
      const step = item.waveform.length / 32;
      for (let i = 0; i < 32; i++) {
        const val = item.waveform[Math.floor(i * step)] || 0;
        // backend sends 0-1 values; clamp just in case
        bars.push(Math.min(1, Math.max(0, val)));
      }
      return bars;
    }
    return Array.from({ length: 32 }, (_, i) => 0.15 + Math.abs(Math.sin(i * 0.7 + 1)) * 0.65);
  }, [item.waveform]);

  const progress = audioDuration > 0 ? currentTime / audioDuration : 0;

  const togglePlay = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(item.url);
      audioRef.current.onloadedmetadata = () => {
        if (audioRef.current) setAudioDuration(audioRef.current.duration);
      };
      audioRef.current.ontimeupdate = () => {
        if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
      };
      audioRef.current.onended = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
    }
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(console.error);
      setIsPlaying(true);
    }
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, []);

  const fmtTime = (s) => {
    const t = Math.floor(s || 0);
    return `${Math.floor(t / 60).toString().padStart(2, "0")}:${(t % 60).toString().padStart(2, "0")}`;
  };

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-[9px] min-w-[220px] max-w-[260px] ${bubbleRadius} ${
        isOwn ? "" : "bg-[#262626]"
      }`}
      style={isOwn ? VOICE_BUBBLE_GRADIENT : undefined}
    >
      <button
        onClick={togglePlay}
        className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center shrink-0 hover:bg-white/30 active:scale-95 transition-all"
      >
        {isPlaying ? (
          /* Pause — two thick rounded bars */
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] text-white">
            <rect x="5" y="4" width="4.5" height="16" rx="2" />
            <rect x="14.5" y="4" width="4.5" height="16" rx="2" />
          </svg>
        ) : (
          /* Play — bold solid teardrop triangle */
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] text-white translate-x-[1px]">
            <path d="M6.5 4.98c0-1.37 1.5-2.17 2.67-1.43l10.6 7.02c1.1.73 1.1 2.33 0 3.06L9.17 20.45C7.99 21.19 6.5 20.39 6.5 19V4.98z" />
          </svg>
        )}
      </button>
      <div className="flex flex-col gap-[5px] flex-1 min-w-0">
        <div className="flex items-center gap-[2.5px] h-[20px]">
          {waveformBars.map((amp, i) => (
            <div
              key={i}
              className={`w-[2px] rounded-full flex-none transition-colors duration-75 ${
                i / waveformBars.length < progress ? "bg-white" : "bg-white/30"
              }`}
              style={{ height: `${Math.max(3, amp * 18)}px` }}
            />
          ))}
        </div>
        <span className="text-[11px] text-white/50 leading-none tabular-nums">
          {isPlaying || currentTime > 0 ? fmtTime(currentTime) : fmtTime(audioDuration)}
        </span>
      </div>
    </div>
  );
};

const UserConversationPage = () => {
  const { userAuth } = useContext(UserContext);
  const currentUserId = userAuth?._id || userAuth?.id;
  const { username } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    hasMoreMessages,
    onlineUsers,
    userLastSeenMap,
    typingUsers,
    actions: {
      loadMessages,
      sendMessage: sendContextMessage,
      // markMessageAsRead, // Unused
      markConversationAsRead,
      checkUserStatus,
      reactToMessage,
      editMessage,
      unsendMessage,
      deleteMessageForMe,
      pinMessage,
      setCurrentConversation,
    },
  } = useChat();

  // const [messages, setMessages] = useState([]); // Replaced by context
  const [newMessage, setNewMessage] = useState("");
  const hasMore = hasMoreMessages;
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [isOnline, setIsOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const isUserTyping =
    selectedUser && typingUsers ? typingUsers[selectedUser._id] : false;
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [mediaPreview, setMediaPreview] = useState(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [reactingTo, setReactingTo] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [isRestricted, setIsRestricted] = useState(false);
  const [blockedByThem, setBlockedByThem] = useState(false);
  const { isBlocked: isUserBlocked, requestBlock, unblock: unblockUser } = useBlock();
  const { openReport } = useReport();
  // Combined: you blocked them (context/server) OR they blocked you.
  const blocked = isUserBlocked(username) || isBlocked || blockedByThem;
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [showPinned, setShowPinned] = useState(false);
  const [messageToForward, setMessageToForward] = useState(null);
  const [showForwardModal, setShowForwardModal] = useState(false);
  const [forwardContacts, setForwardContacts] = useState([]);
  const [selectedForwardContacts, setSelectedForwardContacts] = useState([]);
  const [selectedMediaFiles, setSelectedMediaFiles] = useState([]); // [{file, url, type}]
  const [bigPreviewMedia, setBigPreviewMedia] = useState(null);
  const [uploadingPreview, setUploadingPreview] = useState(null);

  // const socket = useRef(null); // Replaced by context
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  // const voiceInputRef = useRef(null);
  const lastMessageTime = useRef(0);
  const typingTimeoutRef = useRef(null);
  const hasFetchedData = useRef(false);
  const observerRef = useRef(null);
  const topSentinelRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  const isInitialLoadRef = useRef(true);
  const selectedUserRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [voicePreview, setVoicePreview] = useState(null); // { file, url, duration }
  const [isVoicePreviewPlaying, setIsVoicePreviewPlaying] = useState(false);
  const [liveWaveform, setLiveWaveform] = useState([]);
  const [voiceStaticWaveform] = useState(() =>
    Array.from({ length: 32 }, (_, i) => 18 + Math.abs(Math.sin(i * 0.7 + 1)) * 65)
  );
  const recordingTimerRef = useRef(null);
  const recordingCancelledRef = useRef(false);
  const recordingTimeRef = useRef(0);
  const voicePreviewAudioRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const waveformHistoryRef = useRef([]);
  /** Per-DM disappearing TTL (seconds); loaded from chat preferences */
  const [conversationDisappearingSeconds, setConversationDisappearingSeconds] =
    useState(null);

  useEffect(() => {
    selectedUserRef.current = selectedUser;
  }, [selectedUser]);

  // Enhanced cleanup function
  const cleanupTempUrls = useCallback(() => {
    messages.forEach((message) => {
      if (message.media && message.isUploading) {
        message.media.forEach((media) => {
          if (media.url?.startsWith("blob:")) {
            URL.revokeObjectURL(media.url);
          }
        });
      }
    });
    if (mediaPreview?.url?.startsWith("blob:")) {
      URL.revokeObjectURL(mediaPreview.url);
    }
    selectedMediaFiles.forEach((item) => {
      if (item.url?.startsWith("blob:")) URL.revokeObjectURL(item.url);
    });
  }, [messages, mediaPreview, selectedMediaFiles]);

  const handleFetchError = useCallback(
    (error) => {
      console.error("Fetch error:", error.response || error);

      if (error.response?.status === 404) {
        toast.error("User not found");
        setTimeout(() => navigate("/chat"), 2000);
      } else if (error.response?.status === 403) {
        toast.error("You are blocked from messaging this user");
        setIsBlocked(true);
      } else if (error.response?.status === 401) {
        toast.error("Authentication error. Please login again");
        setTimeout(() => navigate("/login"), 2000);
      } else {
        toast.error("Failed to load conversation. Please try again.");
      }
    },
    [navigate]
  );

  // markMessageAsRead replaced by context action

  // markConversationAsRead replaced by context action

  // Initialization Effect
  useEffect(() => {
    const initChat = async () => {
      if (hasFetchedData.current || !username) return;
      hasFetchedData.current = true;

      setLoading(true);
      setBlockedByThem(false);

      try {
        // Fetch user data first. If they blocked us, the profile 404s — we still
        // open the thread with an anonymized "Gossips User" identity (Instagram-style).
        let userData = null;
        try {
          const userResponse = await axios.get(
            `${import.meta.env.VITE_SERVER}/user/${username}`,
            {
              headers: { Authorization: `Bearer ${userAuth.token}` },
            }
          );
          if (!userResponse.data) throw new Error("User not found");
          userData = userResponse.data;
        } catch (profileErr) {
          if (profileErr.response?.status === 404) {
            userData = {
              username,
              name: "Gossips User",
              profilePic: "",
              blockedByThem: true,
            };
            setBlockedByThem(true);
          } else {
            throw profileErr;
          }
        }

        setSelectedUser(userData);
        setIsBlocked(Boolean(userData.relationship?.youBlocked));
        setIsRestricted(userData.restricted?.includes(currentUserId) || false);
        setIsOnline(userData.isOnline || false);
        setLastSeen(userData.lastSeen || null);

        // Set active conversation (only when we have the peer id)
        if (userData._id) setCurrentConversation(userData._id);

        // Fetch messages via context (resolves by username server-side)
        await loadMessages(userData.username);

        // Pinned / status / read receipts need the peer id
        if (userData._id) {
          try {
            const pinnedResponse = await axios.get(
              `${import.meta.env.VITE_SERVER}/chats/${userData._id}/pinned`,
              {
                headers: { Authorization: `Bearer ${userAuth.token}` },
              }
            );
            setPinnedMessages(pinnedResponse.data.pinnedMessages || []);
          } catch (pinnedError) {
            console.error("Error fetching pinned messages:", pinnedError);
          }
          checkUserStatus(userData._id);
          markConversationAsRead(userData._id);
        }
      } catch (error) {
        console.error("Error in initChat:", error);
        handleFetchError(error);
        hasFetchedData.current = false;
      } finally {
        setLoading(false);
      }
    };

    initChat();
  }, [
    username,
    userAuth.token,
    currentUserId,
    handleFetchError,
    markConversationAsRead,
    checkUserStatus,
    loadMessages,
    setCurrentConversation,
  ]);

  // Open in-chat search when returning from conversation details (Search action)
  useEffect(() => {
    if (location.state?.openConversationSearch) {
      setShowSearch(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, navigate]);

  // Load per-chat disappearing-message default for sends (updates when returning from details)
  useEffect(() => {
    if (!selectedUser?._id || !userAuth?.token) return;
    let cancelled = false;
    (async () => {
      try {
        const prefs = await chatAPI.getPreferences();
        if (cancelled) return;
        const key = `user_${selectedUser._id}`;
        const row = (prefs.disappearingByChat || []).find(
          (x) => x.chatId === key
        );
        setConversationDisappearingSeconds(row?.seconds ?? null);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedUser?._id, userAuth?.token, location.pathname]);

  // Update isOnline and lastSeen from context
  useEffect(() => {
    if (selectedUser && onlineUsers.has(selectedUser._id)) {
      setIsOnline(true);
    } else if (selectedUser) {
      setIsOnline(false);
      // lastSeen is static from initial fetch or context update?
      // Context handles userStatus update but doesn't store lastSeen map for everyone?
      // Context reducer: UPDATE_USER_STATUS updates 'onlineUsers' set only (add/delete).
      // It DOES NOT store lastSeen timestamp.
      // So lastSeen is only accurate from initial fetch or if we listen to 'userStatus' event locally?
      // But verify ChatContext again.
      // case "UPDATE_USER_STATUS": ... return { ...state, onlineUsers };
      // Yes, only online status.
      // So lastSeen updates are lost unless we handle them.
      // If accurate lastSeen is important, ChatContext should store 'userStatuses' map { userId: { isOnline, lastSeen } }.
      // For now, I will keep it as is (initial fetch setting lastSeen).
    }
  }, [selectedUser, onlineUsers]);

  // Mark messages as read when they change/load
  useEffect(() => {
    if (messages.length > 0 && selectedUser) {
      // Debounce or just call? markConversationAsRead is lightweight (emit).
      markConversationAsRead(selectedUser._id);
    }
  }, [messages, selectedUser, markConversationAsRead]);

  // Cleanup effect
  useEffect(() => {
    return () => cleanupTempUrls();
  }, [cleanupTempUrls]);

  // Add this useEffect to reset hasFetchedData when username changes
  useEffect(() => {
    hasFetchedData.current = false;
    isInitialLoadRef.current = true;

    return () => {
      hasFetchedData.current = false;
      isInitialLoadRef.current = true;
      setCurrentConversation(null);
    };
  }, [username, setCurrentConversation]);

  const loadMoreMessages = useCallback(async () => {
    if (!hasMore || loadingMore || messagesLoading) return;

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
      if (!oldestMessage) return;

      if (selectedUserRef.current) {
        const cursor = btoa(
          JSON.stringify({
            createdAt: oldestMessage.createdAt,
            _id: oldestMessage._id,
          })
        )
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "");
        await loadMessages(selectedUserRef.current.username, cursor);
      }
    } catch (error) {
      console.error("Error loading more messages:", error);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, messagesLoading, messages, loadMessages]);

  useEffect(() => {
    if (!topSentinelRef.current || !hasMore) return;

    const options = {
      root: messagesContainerRef.current,
      rootMargin: "200px",
      threshold: 0,
    };

    observerRef.current = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingMore) {
        loadMoreMessages();
      }
    }, options);

    observerRef.current.observe(topSentinelRef.current);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, loadingMore, loadMoreMessages]);

  // Socket initialization and event listeners removed - handled by ChatContext

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || messages.length === 0) return;

    // Restore scroll position after loading older messages
    if (scrollAnchorRef.current) {
      const { prevScrollHeight, prevScrollTop } = scrollAnchorRef.current;
      container.scrollTop = container.scrollHeight - prevScrollHeight + prevScrollTop;
      scrollAnchorRef.current = null;
      return;
    }

    // Instant scroll to bottom on initial load
    if (isInitialLoadRef.current) {
      container.scrollTop = container.scrollHeight;
      isInitialLoadRef.current = false;
      return;
    }

    // For new incoming messages, only auto-scroll if already near the bottom
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 150) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    if (messagesError) toast.error(messagesError);
  }, [messagesError]);

  const { startTyping, stopTyping } = useChat().actions;

  const handleTyping = useCallback(
    (isTyping) => {
      if (selectedUserRef.current?._id) {
        if (isTyping) {
          startTyping(selectedUserRef.current._id);
        } else {
          stopTyping(selectedUserRef.current._id);
        }
      }
    },
    [startTyping, stopTyping]
  );

  const handleInputChange = (e) => {
    const value = e.target.value;

    if (editingMessage) {
      setNewMessage(value);
      return;
    }

    setNewMessage(value);

    if (value.trim() && !isTyping) {
      setIsTyping(true);
      handleTyping(true);
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      handleTyping(false);
    }, 1000);
  };

  const validateMessage = (media = []) => {
    if (
      !newMessage.trim() &&
      !fileInputRef.current?.files?.length &&
      !mediaPreview &&
      media.length === 0
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

  const handleSendMedia = async () => {
    if (!selectedMediaFiles.length || !selectedUser?._id || isSending) return;
    if (blocked || isRestricted) {
      toast.error("You cannot send messages to this user");
      return;
    }

    // Capture files and show optimistic bubble immediately
    const filesToUpload = [...selectedMediaFiles];
    setUploadingPreview({
      _id: `uploading-${Date.now()}`,
      isOwn: true,
      isUploading: true,
      media: filesToUpload.map((f) => ({ type: f.type, url: f.url })),
      messageType: "media",
      createdAt: new Date().toISOString(),
      content: "",
    });
    setSelectedMediaFiles([]);
    setIsSending(true);

    try {
      const uploadedItems = [];
      for (const item of filesToUpload) {
        const formData = new FormData();
        formData.append("file", item.file);
        const response = await axios.post(
          `${import.meta.env.VITE_SERVER}/chats/upload`,
          formData,
          {
            headers: {
              Authorization: `Bearer ${userAuth.token}`,
              "Content-Type": "multipart/form-data",
            },
            timeout: 60000,
          }
        );
        uploadedItems.push({
          type: item.type,
          url: response.data.url,
          thumbnail: response.data.thumbnail,
          filename: item.file.name,
          fileSize: item.file.size,
        });
      }

      const tempId = `temp-${Date.now()}-${Math.random()}`;
      await sendContextMessage({
        tempId,
        senderId: currentUserId,
        receiverId: selectedUser._id,
        receiverUsername: username,
        senderUsername: userAuth.username,
        content: "",
        media: uploadedItems,
        messageType: "media",
        replyTo: replyingTo
          ? {
              _id: replyingTo._id,
              content: replyingTo.content,
              media: replyingTo.media,
              senderUsername: replyingTo.senderUsername,
              senderId: replyingTo.sender?._id || replyingTo.sender,
              messageType: replyingTo.messageType,
            }
          : null,
        createdAt: new Date().toISOString(),
        isUploading: false,
      });

      filesToUpload.forEach((item) => URL.revokeObjectURL(item.url));
      setUploadingPreview(null);
      setReplyingTo(null);
      lastMessageTime.current = Date.now();
    } catch (error) {
      console.error("Error sending media:", error);
      filesToUpload.forEach((item) => URL.revokeObjectURL(item.url));
      setUploadingPreview(null);
      toast.error("Failed to send media. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  const handleSendButtonClick = () => {
    if (isSending) return;
    if (selectedMediaFiles.length > 0 && !editingMessage) {
      handleSendMedia();
      return;
    }
    sendMessage();
  };

  // Enhanced send message with different message types
  const sendMessage = async (media = [], messageType = "text") => {
    if (editingMessage) {
      await handleEditMessage();
      return;
    }

    const validationError = validateMessage(media);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    if (blocked || isRestricted) {
      toast.error("You cannot send messages to this user");
      return;
    }

    if (!selectedUser || !selectedUser._id) {
      toast.error("User not found");
      console.error("Selected user is invalid:", selectedUser);
      return;
    }

    setIsSending(true);
    const tempId = `temp-${Date.now()}-${Math.random()}`;

    const messageData = {
      tempId,
      senderId: currentUserId,
      receiverId: selectedUser._id,
      receiverUsername: username,
      senderUsername: userAuth.username,
      content: newMessage.trim(),
      media,
      messageType,
      replyTo: replyingTo
        ? {
            _id: replyingTo._id,
            content: replyingTo.content,
            media: replyingTo.media,
            senderUsername: replyingTo.senderUsername,
            senderId: replyingTo.sender?._id || replyingTo.sender,
            messageType: replyingTo.messageType,
          }
        : null,
      isUploading: messageType !== "gif" && !!media.length,
    };

    const ttl = conversationDisappearingSeconds;
    if (ttl != null && ttl > 0) {
      messageData.isEphemeral = true;
      messageData.selfDestructTimer = ttl;
    }

    try {
      await sendContextMessage(messageData);

      setNewMessage("");
      setShowEmojiPicker(false);
      setShowGifPicker(false);
      setReplyingTo(null);
      lastMessageTime.current = Date.now();

      setIsTyping(false);
      handleTyping(false);
    } catch (error) {
      console.error("Error sending message:", error);
      toast.error("Failed to send message");
    } finally {
      setIsSending(false);
    }
  };

  // const { editMessage } = useChat().actions; // Removed duplicate

  const handleEditMessage = async () => {
    if (!editingMessage || !newMessage.trim()) {
      toast.error("Message cannot be empty");
      return;
    }

    try {
      await editMessage(editingMessage._id, newMessage.trim());

      setNewMessage("");
      setEditingMessage(null);
    } catch (error) {
      console.error("Error editing message:", error);
      toast.error("Failed to edit message");
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSending) {
        handleSendButtonClick();
      }
    } else if (e.key === "Escape") {
      if (editingMessage) {
        setEditingMessage(null);
        setNewMessage("");
      }
      if (replyingTo) {
        setReplyingTo(null);
      }
      setShowEmojiPicker(false);
      setShowGifPicker(false);
    }
  };

  const handleEmojiClick = (emojiObject) => {
    if (newMessage.length + emojiObject.emoji.length <= MAX_MESSAGE_LENGTH) {
      setNewMessage((prev) => prev + emojiObject.emoji);
    }
  };

  /** Shape from the shared GifPicker: { url, width, height }. */
  const handleGifSelect = (gif) => {
    if (blocked || isRestricted) {
      toast.error("You cannot send messages to this user");
      return;
    }
    sendMessage([{ type: "gif", url: gif.url, thumbnail: gif.url }], "gif");
    setShowGifPicker(false);
  };

  const validateFile = (file) => {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File size too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`
      );
    }

    const validTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "video/mp4",
      "video/quicktime",
      "video/x-msvideo",
    ];

    if (!validTypes.includes(file.type)) {
      throw new Error("Invalid file type. Only images and videos are allowed");
    }
  };

  const handleMediaSelect = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const newItems = [];
    for (const file of files) {
      try {
        validateFile(file);
        const url = URL.createObjectURL(file);
        const type = file.type.startsWith("image/") ? "image" : "video";
        newItems.push({ file, url, type });
      } catch (error) {
        toast.error(error.message);
      }
    }

    if (newItems.length) setSelectedMediaFiles((prev) => [...prev, ...newItems]);
    e.target.value = "";
  };

  const handleMediaUploadConfirm = async () => {
    if (!mediaPreview) return;

    const file = mediaPreview.file;
    const tempId = `temp-${Date.now()}-${Math.random()}`;
    // tempMedia removed as optimistic update is handled by context (or skipped)

    const messageType =
      mediaPreview.type === "image"
        ? "media"
        : mediaPreview.type === "video"
          ? "media"
          : mediaPreview.type === "audio"
            ? "voice"
            : "file";

    // Optimistic update handled by ChatContext logic (wait, media upload logic is tricky)
    // ChatContext ADD_MESSAGE expects fully formed message.
    // For media, we usually upload first then send.
    // So we don't need local optimistic setMessages here if we trust the flow.
    // But we might want it for "uploading" state?
    // ChatContext doesn't handle "uploading" state for media specifically unless we add it.
    // For now, let's skip local "uploading" state in message list and just show spinner in modal or toast.
    // Or we rely on sendContextMessage to add it.
    // But sendContextMessage expects 'media' URLs.
    // The issue is seeing the message appearing BEFORE upload completes.
    // UserConversationPage logic showed "Uploading..." in message list.
    // To replicate this with ChatContext, we would need to add a message with local blob URL and isUploading=true to Context?
    // But `sendContextMessage` is async.
    // We can manually dispatch ADD_MESSAGE to context? But context `dispatch` is not exposed.
    // We can assume fast uploads or just wait.
    // Given complexity, let's wait for upload then send.

    /* 
    setMessages((prev) =>
      [...prev, tempMessage].sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      )
    );
    */

    const formData = new FormData();
    formData.append("file", file);

    try {
      const endpoint =
        mediaPreview.type === "audio"
          ? `${import.meta.env.VITE_SERVER}/chats/upload/voice`
          : `${import.meta.env.VITE_SERVER}/chats/upload`;

      const response = await axios.post(endpoint, formData, {
        headers: {
          Authorization: `Bearer ${userAuth.token}`,
          "Content-Type": "multipart/form-data",
        },
        timeout: 60000,
      });

      const media = [
        {
          type: mediaPreview.type,
          url: response.data.url,
          thumbnail: response.data.thumbnail,
          filename: file.name,
          fileSize: file.size,
          duration: response.data.duration,
        },
      ];

      /*
       * Optimistic update handled by ChatContext
       * Socket emission handled by ChatContext
       */

      await sendContextMessage({
        senderId: currentUserId,
        receiverId: selectedUser._id,
        receiverUsername: username,
        content: newMessage.trim(),
        media,
        messageType,
        replyTo: replyingTo
          ? {
              _id: replyingTo._id,
              content: replyingTo.content,
              media: replyingTo.media,
              senderUsername: replyingTo.senderUsername,
              senderId: replyingTo.sender,
              messageType: replyingTo.messageType,
            }
          : null,
        createdAt: new Date().toISOString(),
        tempId,
      });

      setNewMessage("");
      setReplyingTo(null);
      lastMessageTime.current = Date.now();
    } catch (error) {
      console.error("Error uploading media:", error);
      // Clean up blobs if failed
      if (mediaPreview?.url) {
        URL.revokeObjectURL(mediaPreview.url);
      }
      toast.error("Failed to upload media. Please try again.");
    } finally {
      setIsPreviewOpen(false);
      setMediaPreview(null);
      if (mediaPreview?.url) {
        URL.revokeObjectURL(mediaPreview.url);
      }
    }
  };

  // ── Voice recording ──────────────────────────────────────────────────────
  const stopWaveformAnalysis = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      analyserRef.current = null;
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // ── Real-time waveform via Web Audio API ──
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      analyserRef.current.smoothingTimeConstant = 0.5;
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      const freqData = new Uint8Array(analyserRef.current.frequencyBinCount);
      waveformHistoryRef.current = [];

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(freqData);
        // RMS energy across voice-range frequency bins (roughly 0–3 kHz)
        const voiceBins = Math.min(freqData.length, 48);
        let sum = 0;
        for (let i = 0; i < voiceBins; i++) sum += freqData[i] * freqData[i];
        const rms = Math.sqrt(sum / voiceBins) / 255; // 0..1
        // Amplify quiet signals; add small idle jitter so bars breathe in silence
        const amp = rms < 0.02
          ? 0.02 + Math.random() * 0.04
          : Math.min(1, rms * 4);
        waveformHistoryRef.current = [...waveformHistoryRef.current, amp].slice(-52);
        setLiveWaveform([...waveformHistoryRef.current]);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);

      // ── MediaRecorder ──
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recordingCancelledRef.current = false;

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingCancelledRef.current) {
          recordingCancelledRef.current = false;
          return;
        }
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const audioUrl = URL.createObjectURL(audioBlob);
        const ext = mimeType === "audio/webm" ? "webm" : "mp4";
        setVoicePreview({
          file: new File([audioBlob], `voice-message.${ext}`, { type: mimeType }),
          url: audioUrl,
          duration: recordingTimeRef.current,
          waveformSnapshot: [...waveformHistoryRef.current],
        });
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimeRef.current = 0;

      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => {
          recordingTimeRef.current = prev + 1;
          return prev + 1;
        });
      }, 1000);

      setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") stopRecording();
      }, 120000);
    } catch (error) {
      console.error("Error starting recording:", error);
      toast.error("Microphone access is required for voice messages");
    }
  };

  const stopRecording = () => {
    stopWaveformAnalysis();
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const cancelRecording = () => {
    recordingCancelledRef.current = true;
    stopWaveformAnalysis();
    stopRecording();
    setLiveWaveform([]);
    setRecordingTime(0);
  };

  const cancelVoicePreview = () => {
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current.src = "";
      voicePreviewAudioRef.current = null;
    }
    if (voicePreview?.url) URL.revokeObjectURL(voicePreview.url);
    setVoicePreview(null);
    setIsVoicePreviewPlaying(false);
    setRecordingTime(0);
  };

  const toggleVoicePreviewPlay = () => {
    if (!voicePreview) return;
    if (!voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current = new Audio(voicePreview.url);
      voicePreviewAudioRef.current.onended = () => setIsVoicePreviewPlaying(false);
    }
    if (isVoicePreviewPlaying) {
      voicePreviewAudioRef.current.pause();
      setIsVoicePreviewPlaying(false);
    } else {
      voicePreviewAudioRef.current.play().catch(console.error);
      setIsVoicePreviewPlaying(true);
    }
  };

  const sendVoiceNote = async () => {
    if (!voicePreview || isSending) return;
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current.src = "";
      voicePreviewAudioRef.current = null;
    }
    setIsVoicePreviewPlaying(false);

    const { file, duration, url: blobUrl } = voicePreview;
    const tempId = `temp-${Date.now()}-${Math.random()}`;

    setUploadingPreview({
      _id: tempId,
      tempId,
      isOwn: true,
      isUploading: true,
      messageType: "voice",
      media: [{ type: "audio", url: blobUrl, duration }],
      createdAt: new Date().toISOString(),
    });

    setVoicePreview(null);
    setRecordingTime(0);

    try {
      setIsSending(true);
      const formData = new FormData();
      formData.append("audio", file);

      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}/chats/upload/voice`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${userAuth.token}`,
            "Content-Type": "multipart/form-data",
          },
          timeout: 60000,
        }
      );

      await sendContextMessage({
        senderId: currentUserId,
        receiverId: selectedUser._id,
        receiverUsername: username,
        content: "",
        media: [{
          type: "audio",
          url: response.data.url,
          duration: response.data.duration || duration,
          waveform: response.data.waveform,
        }],
        messageType: "voice",
        replyTo: replyingTo
          ? {
              _id: replyingTo._id,
              content: replyingTo.content,
              media: replyingTo.media,
              senderUsername: replyingTo.senderUsername,
              senderId: replyingTo.sender,
              messageType: replyingTo.messageType,
            }
          : null,
        createdAt: new Date().toISOString(),
        tempId,
      });

      setReplyingTo(null);
    } catch (error) {
      console.error("Error uploading voice note:", error);
      toast.error("Failed to send voice message. Please try again.");
    } finally {
      setIsSending(false);
      setUploadingPreview(null);
      URL.revokeObjectURL(blobUrl);
    }
  };

  const handleMessageContextMenu = (message, event) => {
    event.preventDefault();
    event.stopPropagation();

    setSelectedMessage(message);
    setContextMenu({
      x: event.clientX || event.touches?.[0]?.clientX || 0,
      y: event.clientY || event.touches?.[0]?.clientY || 0,
    });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
    setSelectedMessage(null);
  };

  const handleContextMenuAction = async (action) => {
    if (!selectedMessage) return;

    switch (action) {
      case "edit":
        if (selectedMessage.content && selectedMessage.isOwn) {
          setEditingMessage(selectedMessage);
          setNewMessage(selectedMessage.content);
        }
        break;
      case "unsend":
        if (window.confirm("Unsend this message? This cannot be undone.")) {
          await handleUnsendMessage(selectedMessage._id);
        }
        break;
      case "delete":
        if (window.confirm("Delete this message for yourself?")) {
          await handleDeleteMessageForMe(selectedMessage._id);
        }
        break;
      case "reply":
        setReplyingTo(selectedMessage);
        break;
      case "copy":
        if (selectedMessage.content) {
          await navigator.clipboard.writeText(selectedMessage.content);
          toast.success("Copied to clipboard");
        }
        break;
      case "forward":
        setMessageToForward(selectedMessage);
        setShowForwardModal(true);
        fetchForwardContacts();
        break;
      case "react":
        setReactingTo(selectedMessage._id);
        break;
      case "pin":
        await handlePinMessage(selectedMessage._id);
        break;
      case "report":
        handleReportMessage(selectedMessage);
        break;
      default:
        break;
    }

    closeContextMenu();
  };

  const handleUnsendMessage = async (messageId) => {
    // renamed from unsendMessage to avoid name conflict with action
    try {
      await unsendMessage(messageId);
    } catch (error) {
      console.error("Error unsending message:", error);
      toast.error("Failed to unsend message");
    }
  };

  const handleDeleteMessageForMe = async (messageId) => {
    // renamed from deleteMessageForMe to avoid name conflict
    try {
      await deleteMessageForMe(messageId);
    } catch (error) {
      console.error("Error deleting message:", error);
      toast.error("Failed to delete message");
    }
  };

  const handlePinMessage = async (messageId) => {
    // renamed from pinMessage to avoid name conflict
    try {
      await pinMessage(messageId);
      fetchPinnedMessages();
    } catch (error) {
      console.error("Error pinning message:", error);
      toast.error("Failed to pin message");
    }
  };

  const fetchPinnedMessages = async () => {
    try {
      const response = await axios.get(
        `${import.meta.env.VITE_SERVER}/chats/${selectedUser._id}/pinned`,
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      setPinnedMessages(response.data.pinnedMessages || []);
    } catch (error) {
      console.error("Error fetching pinned messages:", error);
    }
  };

  const fetchForwardContacts = async () => {
    try {
      const response = await axios.get(`${import.meta.env.VITE_SERVER}/chats`, {
        headers: { Authorization: `Bearer ${userAuth.token}` },
      });
      setForwardContacts(response.data.chats.map((chat) => chat.user));
    } catch (error) {
      console.error("Error fetching forward contacts:", error);
    }
  };

  const handleForwardMessage = async () => {
    if (!messageToForward || selectedForwardContacts.length === 0) return;

    try {
      await axios.post(
        `${import.meta.env.VITE_SERVER}/chats/message/${messageToForward._id}/forward`,
        { receiverIds: selectedForwardContacts.map((contact) => contact._id) },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );

      toast.success(`Forwarded to ${selectedForwardContacts.length} contact(s)`);
      setShowForwardModal(false);
      setMessageToForward(null);
      setSelectedForwardContacts([]);
    } catch (error) {
      console.error("Error forwarding message:", error);
      toast.error("Failed to forward message");
    }
  };

  const handleAddReaction = async (messageId, emoji) => {
    try {
      await reactToMessage(messageId, emoji);
      setReactingTo(null);
    } catch (error) {
      console.error("Error adding reaction:", error);
    }
  };

  const searchMessages = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      const response = await axios.get(
        `${import.meta.env.VITE_SERVER}/chats/messages/${username}/search`,
        {
          params: { query: searchQuery, limit: 50 },
          headers: { Authorization: `Bearer ${userAuth.token}` },
        }
      );
      setSearchResults(response.data.messages);
    } catch (error) {
      console.error("Error searching messages:", error);
    }
  }, [searchQuery, username, userAuth.token]);

  const handleRestrict = async () => {
    try {
      await axios.post(
        `${import.meta.env.VITE_SERVER}/user/restrict/${username}`,
        {},
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      setIsRestricted(true);
      toast.success("User restricted");
    } catch (error) {
      console.error("Error restricting user:", error);
      toast.error("Failed to restrict user");
    }
  };

  const handleBlock = () => {
    // Shared confirmation dialog + app-wide block state.
    requestBlock({ username, name: selectedUser?.name });
  };

  const handleUnblock = async () => {
    try {
      await unblockUser(username);
      setIsBlocked(false);
    } catch {
      // toast handled in context
    }
  };

  const handleReport = () => {
    openReport({
      targetType: "conversation",
      username,
      name: selectedUser?.name,
    });
  };

  // Only offered on messages you didn't send, so the peer is always the owner.
  const handleReportMessage = (message) => {
    openReport({
      targetType: "message",
      targetId: message._id,
      username,
      name: selectedUser?.name,
    });
  };

  const handleDeleteChat = async () => {
    if (
      !window.confirm(
        "Delete this entire conversation? This action cannot be undone."
      )
    )
      return;

    try {
      await axios.delete(`${import.meta.env.VITE_SERVER}/chats/${username}`, {
        headers: { Authorization: `Bearer ${userAuth.token}` },
      });
      navigate("/chat");
    } catch (error) {
      console.error("Error deleting chat:", error);
      toast.error("Failed to delete chat");
    }
  };

  const formatLastSeen = (lastSeen) => {
    if (!lastSeen) return null;

    const diffMs = Date.now() - new Date(lastSeen).getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);

    if (diffSecs < 60) return `${diffSecs}s ago`;
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks <= 4) return `${diffWeeks}w ago`;
    return null;
  };

  const formatInstagramTimestamp = (dateString) => {
    const messageDate = new Date(dateString);
    const now = new Date();

    const isToday = messageDate.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = messageDate.toDateString() === yesterday.toDateString();

    const hours = messageDate.getHours() % 12 || 12;
    const minutes = messageDate.getMinutes().toString().padStart(2, "0");
    const ampm = messageDate.getHours() >= 12 ? "pm" : "am";
    const timeStr = `${hours}:${minutes} ${ampm}`;

    if (isToday) return `Today ${timeStr}`;
    if (isYesterday) return `Yesterday ${timeStr}`;

    const daysDiff = Math.floor((now - messageDate) / (1000 * 60 * 60 * 24));
    if (daysDiff < 7) {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `${days[messageDate.getDay()]} ${timeStr}`;
    }

    if (messageDate.getFullYear() === now.getFullYear()) {
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      return `${messageDate.getDate()} ${months[messageDate.getMonth()]}, ${timeStr}`;
    }

    const day = messageDate.getDate().toString().padStart(2, "0");
    const month = (messageDate.getMonth() + 1).toString().padStart(2, "0");
    return `${day}-${month}-${messageDate.getFullYear()}`;
  };

  const shouldShowTimestamp = (prevGroup, currentGroup) => {
    if (!prevGroup) return true;

    const prevTime = new Date(prevGroup[prevGroup.length - 1].createdAt);
    const currentTime = new Date(currentGroup[0].createdAt);

    const hoursDiff = (currentTime - prevTime) / (1000 * 60 * 60);
    return prevTime.getHours() !== currentTime.getHours() || hoursDiff >= 0.5;
  };

  const groupMessages = () => {
    const grouped = [];
    let currentGroup = [];

    messages.forEach((message) => {
      const isOwn = (message.sender?._id || message.sender) === currentUserId;

      if (
        currentGroup.length === 0 ||
        currentGroup[0].isOwn !== isOwn ||
        new Date(message.createdAt) -
          new Date(currentGroup[currentGroup.length - 1].createdAt) >
          2 * 60 * 1000
      ) {
        if (currentGroup.length > 0) {
          grouped.push(currentGroup);
        }
        currentGroup = [];
      }

      currentGroup.push({ ...message, isOwn });
    });

    if (currentGroup.length > 0) {
      grouped.push(currentGroup);
    }

    return grouped;
  };

  const getMessageIndicator = (message, isOwn) => {
    if (!isOwn) return null;

    const isLastMessage = message._id === messages[messages.length - 1]?._id;
    if (!isLastMessage) return null;

    if (message.isRead) {
      return (
        <div className="flex items-center gap-1">
          <span className="text-xs text-neutral-400">Seen</span>
          <img
            src={selectedUser?.profilePic || "/default-avatar.png"}
            alt="Seen"
            className="w-3 h-3 rounded-full"
          />
        </div>
      );
    }

    return message.isUploading ? null : "Delivered";
  };

  const getMessageContent = (message) => {
    if (message.isDeleted) {
      return (
        <span className="italic text-neutral-400">
          This message was deleted
        </span>
      );
    }

    switch (message.messageType) {
      case "media":
        return "📷 Media";
      case "voice":
        return "🎤 Voice message";
      case "poll":
        return "📊 Poll";
      case "sticker":
        return "🎨 Sticker";
      case "gif":
        return "GIF";
      case "file":
        return "📎 File";
      // The card renders itself; only the accompanying note is text.
      case "post_share":
        return message.content || "";
      default:
        return message.content;
    }
  };

  const messageGroups = groupMessages();

  const UserStatusIndicator = () => {
    const resolvedLastSeen = selectedUser
      ? userLastSeenMap[selectedUser._id] || lastSeen
      : null;
    return (
      <div className="flex items-center gap-2 text-xs">
        {isOnline ? (
          <span className="text-green-500">Online</span>
        ) : resolvedLastSeen ? (
          <span className="text-neutral-400">
            Last seen {formatLastSeen(resolvedLastSeen)}
          </span>
        ) : null}
      </div>
    );
  };

  // Enhanced Media Preview Modal
  const MediaPreviewModal = () => (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden">
        <div className="p-4 border-b border-neutral-800 flex justify-between items-center">
          <h3 className="font-medium">
            {mediaPreview?.type === "audio"
              ? "Send Voice Message"
              : "Send Media"}
          </h3>
          <button
            onClick={() => {
              setIsPreviewOpen(false);
              setMediaPreview(null);
              if (mediaPreview?.url) URL.revokeObjectURL(mediaPreview.url);
            }}
            className="text-neutral-400 hover:text-white"
          >
            <Icons.close className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4">
          {mediaPreview?.type === "image" ? (
            <img
              src={mediaPreview.url}
              alt="Preview"
              className="max-w-[min(100%,240px)] max-h-52 w-auto h-auto object-contain rounded-lg mx-auto block"
            />
          ) : mediaPreview?.type === "video" ? (
            <video
              src={mediaPreview.url}
              controls
              className="max-w-[min(100%,240px)] max-h-52 w-auto h-auto object-contain rounded-lg mx-auto block"
            />
          ) : mediaPreview?.type === "audio" ? (
            <div className="flex flex-col items-center">
              <audio
                src={mediaPreview.url}
                controls
                className="w-full max-w-md"
              />
              <p className="text-neutral-400 text-sm mt-2">
                Voice message ({Math.floor(recordingTime)}s)
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center p-4">
              <Icons.file className="w-16 h-16 text-neutral-400 mb-2" />
              <p className="text-white font-medium">{mediaPreview.file.name}</p>
              <p className="text-neutral-400 text-sm">
                {(mediaPreview.file.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          )}

          {mediaPreview?.type !== "audio" && (
            <textarea
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Add a caption..."
              className="w-full mt-4 bg-neutral-800 text-white placeholder-neutral-400 rounded-lg p-3 resize-none focus:outline-none"
              rows={3}
            />
          )}

          <div className="flex gap-3 mt-4">
            <button
              onClick={() => {
                setIsPreviewOpen(false);
                setMediaPreview(null);
                if (mediaPreview?.url) URL.revokeObjectURL(mediaPreview.url);
              }}
              className="flex-1 bg-neutral-800 text-white py-2.5 rounded-lg font-medium hover:bg-neutral-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleMediaUploadConfirm}
              disabled={isSending}
              className="flex-1 bg-violet-600 text-white py-2.5 rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
            >
              {isSending ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Forward Modal
  const ForwardModal = () => (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl max-w-md w-full max-h-[80vh] overflow-hidden">
        <div className="p-4 border-b border-neutral-800">
          <h3 className="font-medium text-lg">Forward Message</h3>
          <p className="text-neutral-400 text-sm mt-1">
            Select contacts to forward to
          </p>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {forwardContacts.map((contact) => (
            <div
              key={contact._id}
              className="flex items-center gap-3 p-3 hover:bg-neutral-800 cursor-pointer"
              onClick={() => {
                setSelectedForwardContacts((prev) =>
                  prev.some((c) => c._id === contact._id)
                    ? prev.filter((c) => c._id !== contact._id)
                    : [...prev, contact]
                );
              }}
            >
              <input
                type="checkbox"
                checked={selectedForwardContacts.some(
                  (c) => c._id === contact._id
                )}
                onChange={() => {}}
                className="w-4 h-4 text-blue-500 rounded"
              />
              <img
                src={contact.profilePic || "/default-avatar.png"}
                alt={contact.username}
                className="w-10 h-10 rounded-full"
              />
              <div>
                <p className="text-white font-medium">
                  {contact.name || contact.username}
                </p>
                <p className="text-neutral-400 text-sm">@{contact.username}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-neutral-800 flex gap-3">
          <button
            onClick={() => {
              setShowForwardModal(false);
              setSelectedForwardContacts([]);
              setMessageToForward(null);
            }}
            className="flex-1 bg-neutral-800 text-white py-2.5 rounded-lg font-medium hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleForwardMessage}
            disabled={selectedForwardContacts.length === 0}
            className="flex-1 bg-violet-600 text-white py-2.5 rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            Forward ({selectedForwardContacts.length})
          </button>
        </div>
      </div>
    </div>
  );

  const ReplyPreview = () => (
    <div className="flex items-center justify-between bg-neutral-800 px-4 py-2 border-l-4 border-violet-600 mx-2 mb-2 rounded-lg">
      <div className="flex-1">
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span>
            Replying to{" "}
            {replyingTo?.isOwn ? "yourself" : replyingTo?.senderUsername}
          </span>
        </div>
        <div className="text-sm truncate">{getMessageContent(replyingTo)}</div>
      </div>
      <button
        onClick={() => setReplyingTo(null)}
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
        onClick={() => {
          setEditingMessage(null);
          setNewMessage("");
        }}
        className="text-neutral-400 hover:text-white ml-2"
      >
        <Icons.close className="w-4 h-4" />
      </button>
    </div>
  );

  const PinnedMessagesBar = () => (
    <div className="bg-neutral-800 border-l-4 border-yellow-500 mx-2 mb-2 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icons.pin className="w-4 h-4 text-yellow-500" />
          <span className="text-sm font-medium text-white">
            Pinned Messages
          </span>
        </div>
        <button
          onClick={() => setShowPinned(false)}
          className="text-neutral-400 hover:text-white"
        >
          <Icons.close className="w-4 h-4" />
        </button>
      </div>
      <div className="space-y-2 max-h-32 overflow-y-auto">
        {pinnedMessages.slice(0, 3).map((message) => (
          <div
            key={message._id}
            className="text-sm text-neutral-300 cursor-pointer hover:bg-neutral-700 p-2 rounded"
            onClick={() => {
              const element = document.getElementById(`msg-${message._id}`);
              element?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          >
            <div className="flex justify-between text-xs text-neutral-400 mb-1">
              <span>{message.sender.username}</span>
              <span>{formatInstagramTimestamp(message.createdAt)}</span>
            </div>
            <div className="truncate">{getMessageContent(message)}</div>
          </div>
        ))}
      </div>
      {pinnedMessages.length > 3 && (
        <button
          onClick={() => setShowPinned(true)}
          className="text-blue-400 text-xs mt-2 hover:text-blue-300"
        >
          View all {pinnedMessages.length} pinned messages
        </button>
      )}
    </div>
  );

  const MediaWidget = () => (
    <div className="px-3 pt-2 pb-1 border-t border-neutral-800">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pt-2 pb-1">
        {selectedMediaFiles.map((item, idx) => (
          <div key={idx} className="relative shrink-0">
            <button
              className="block w-16 h-16 rounded-xl overflow-hidden focus:outline-none"
              onClick={() => setBigPreviewMedia(item)}
            >
              {item.type === "image" ? (
                <img src={item.url} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
                  <Icons.video className="w-6 h-6 text-white/70" />
                </div>
              )}
            </button>
            <button
              onClick={() => {
                URL.revokeObjectURL(item.url);
                setSelectedMediaFiles((prev) => prev.filter((_, i) => i !== idx));
              }}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-neutral-600 rounded-full flex items-center justify-center hover:bg-red-500 transition-colors z-10"
            >
              <Icons.close className="w-3 h-3 text-white" />
            </button>
          </div>
        ))}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-16 h-16 shrink-0 rounded-xl border-2 border-dashed border-neutral-700 flex items-center justify-center text-neutral-500 hover:text-white hover:border-neutral-500 transition-colors"
          title="Add more"
        >
          <Icons.image className="w-5 h-5" />
        </button>
      </div>
    </div>
  );

const MessageBubble = ({ message, isOwn, msgIndex = 0, groupLength = 1 }) => {
  const [hovered, setHovered] = useState(false);

  const hasMedia = message.media?.length > 0;
  const hasContent = message.content?.trim();
  const isDeleted = message.isDeleted;

  const isEmojiOnly =
    !hasMedia &&
    !!hasContent &&
    !isDeleted &&
    message.content
      .replace(
        /\p{Extended_Pictographic}|\p{Emoji_Presentation}|️|‍|⃣|\s/gu,
        ""
      )
      .length === 0;

  // A shared post carries its own card chrome, so a bare share gets no bubble.
  const isShare = message.messageType === "post_share" && message.sharedContent;
  const isShareOnly = isShare && !hasContent && !isDeleted;

  // No bubble background: emoji-only or standalone media/gif (no text, no reply)
  const isMediaOnly = hasMedia && !hasContent && !message.replyTo && !isDeleted;
  const noBg = isEmojiOnly || isMediaOnly || isShareOnly;

  const isFirst = msgIndex === 0;
  const isLast = msgIndex === groupLength - 1;
  const isSingle = groupLength === 1;

  // Instagram-style corner radius: 18px base, 5px on "inner" side for grouped messages
  const getBubbleRadius = () => {
    if (noBg) return "";
    if (isSingle) return "rounded-[18px]";
    if (isOwn) {
      // tail = bottom-right
      if (isFirst && !isLast) return "rounded-[18px] rounded-br-[5px]";
      if (isLast && !isFirst) return "rounded-[18px] rounded-tr-[5px]";
      return "rounded-[18px] rounded-r-[5px]";
    } else {
      // tail = bottom-left
      if (isFirst && !isLast) return "rounded-[18px] rounded-bl-[5px]";
      if (isLast && !isFirst) return "rounded-[18px] rounded-tl-[5px]";
      return "rounded-[18px] rounded-l-[5px]";
    }
  };

  const getBubbleBg = () => {
    if (noBg) return "bg-transparent";
    if (!isOwn) return "bg-[#262626]";
    return ""; // own messages: bg applied via inline style below
  };

  // Viewport-fixed gradient so each bubble shows only its vertical slice —
  // top of screen = magenta/purple, bottom = bright blue, just like Instagram.
  const getBubbleStyle = () => {
    if (noBg || !isOwn) return {};
    return {
      background:
        "linear-gradient(to bottom, #C026D3, #A21CAF, #8B5CF6, #7C3AED, #5B21B6, #4F46E5, #2563EB, #1D4ED8, #C026D3, #A21CAF)",
      backgroundAttachment: "fixed",
    };
  };

  const getBubblePadding = () => {
    if (noBg) return "p-0";
    if (isMediaOnly) return "p-0 overflow-hidden";
    return "px-3 py-[9px]";
  };

  // Group reactions by emoji for display
  const groupedReactions = {};
  if (message.reactions) {
    Object.values(message.reactions).forEach((rd) => {
      const emoji = typeof rd === "string" ? rd : rd.emoji;
      groupedReactions[emoji] = (groupedReactions[emoji] || 0) + 1;
    });
  }
  const hasReactions = Object.keys(groupedReactions).length > 0;

  return (
    <div
      id={`msg-${message._id}`}
      className={`relative inline-flex flex-col w-fit max-w-full ${
        isOwn ? "items-end" : "items-start"
      }`}
      onContextMenu={(e) => handleMessageContextMenu(message, e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Pinned badge */}
      {message.isPinned && (
        <div className="absolute -top-5 right-0 text-[11px] text-yellow-400 flex items-center gap-1 z-10">
          <Icons.pin className="w-3 h-3" />
          <span>Pinned</span>
        </div>
      )}

      {/* Forwarded label */}
      {message.isForwarded && (
        <div
          className={`text-[11px] text-neutral-500 mb-1 flex items-center gap-1 ${
            isOwn ? "justify-end" : "justify-start"
          }`}
        >
          <Icons.forward className="w-3 h-3" />
          <span>Forwarded</span>
        </div>
      )}

      {/* Instagram-style reaction picker */}
      {reactingTo === message._id && (
        <div
          className={`absolute ${
            isOwn ? "right-0" : "left-0"
          } -top-[54px] bg-[#1c1c1e] border border-white/10 rounded-full px-2 py-1.5 flex gap-0.5 shadow-2xl z-30`}
        >
          {["❤️", "😂", "😮", "😢", "😡", "👍"].map((emoji) => (
            <button
              key={emoji}
              onClick={() => handleAddReaction(message._id, emoji)}
              className="w-9 h-9 text-[20px] flex items-center justify-center rounded-full hover:bg-white/10 hover:scale-125 transition-all duration-150"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* Main bubble */}
      <div
        className={`relative w-fit max-w-full text-white ${getBubbleRadius()} ${getBubbleBg()} ${getBubblePadding()} ${
          message.isPinned ? "ring-1 ring-yellow-400/60" : ""
        }`}
        style={getBubbleStyle()}
      >
        {/* Reply-to preview */}
        {message.replyTo && (
          <div
            className={`mb-2 px-2.5 py-[7px] rounded-xl ${
              isOwn
                ? "bg-black/20 border-l-2 border-white/25"
                : "bg-white/10 border-l-2 border-white/20"
            }`}
          >
            <p className="text-[11px] font-semibold truncate opacity-70 mb-0.5">
              {message.replyTo.senderUsername}
            </p>
            <p className="text-[12px] truncate opacity-50">
              {getMessageContent(message.replyTo)}
            </p>
          </div>
        )}

        {/* Shared post / comment */}
        {isShare && !isDeleted && (
          <div className={hasContent ? "mb-2" : ""}>
            <SharedPostCard sharedContent={message.sharedContent} />
          </div>
        )}

        {/* Text */}
        {hasContent && !isDeleted && (
          <p
            className={`whitespace-pre-wrap break-words ${
              isEmojiOnly
                ? "text-[44px] leading-none py-1"
                : "text-[14.5px] leading-[1.45]"
            } ${hasMedia ? "mb-2" : ""}`}
          >
            {/* No mentionUsernames: in a DM every handle links. It's a
                shortcut to a profile, not a way to summon a stranger, so
                nothing is gated and nobody is notified. */}
            <RichText content={getMessageContent(message)} />
            {message.isEdited && (
              <span className="text-[11px] opacity-40 ml-1.5">edited</span>
            )}
          </p>
        )}

        {/* Deleted state */}
        {isDeleted && (
          <p className="text-[13.5px] italic text-white/40">
            This message was deleted
          </p>
        )}

        {/* Media */}
        {hasMedia && !isDeleted && (
          <div className="flex flex-col gap-1 w-fit max-w-full">
            {message.media.map((item, idx) => {
              const cornerClass =
                hasContent || message.replyTo ? "rounded-xl" : "rounded-[18px]";

              if (item.type === "image") {
                return (
                  <img
                    key={idx}
                    src={item.url}
                    alt="Shared media"
                    className={`block max-w-[260px] max-h-[340px] w-auto h-auto object-cover cursor-pointer ${cornerClass}`}
                    loading="lazy"
                    onClick={() => window.open(item.url, "_blank")}
                  />
                );
              }
              if (item.type === "gif") {
                return (
                  <img
                    key={idx}
                    src={item.url}
                    alt="GIF"
                    className={`block max-w-[260px] max-h-[260px] w-auto h-auto ${cornerClass}`}
                    loading="lazy"
                  />
                );
              }
              if (item.type === "video") {
                return (
                  <video
                    key={idx}
                    src={item.url}
                    controls
                    className={`block max-w-[260px] max-h-[340px] w-auto h-auto ${cornerClass}`}
                  >
                    Your browser does not support video.
                  </video>
                );
              }
              if (item.type === "audio") {
                // Compute the same corner radii a text bubble would use
                let vRadius = "rounded-[18px]";
                if (!isSingle) {
                  if (isOwn) {
                    if (isFirst && !isLast) vRadius = "rounded-[18px] rounded-br-[5px]";
                    else if (isLast && !isFirst) vRadius = "rounded-[18px] rounded-tr-[5px]";
                    else vRadius = "rounded-[18px] rounded-r-[5px]";
                  } else {
                    if (isFirst && !isLast) vRadius = "rounded-[18px] rounded-bl-[5px]";
                    else if (isLast && !isFirst) vRadius = "rounded-[18px] rounded-tl-[5px]";
                    else vRadius = "rounded-[18px] rounded-l-[5px]";
                  }
                }
                return <VoiceNoteBubble key={idx} item={item} isOwn={isOwn} bubbleRadius={vRadius} />;
              }
              if (item.type === "document") {
                return (
                  <div
                    key={idx}
                    className="flex items-center gap-2.5 min-w-[190px] max-w-[260px] py-0.5"
                  >
                    <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
                      <Icons.file className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium truncate">
                        {item.filename}
                      </p>
                      <p className="text-[11px] text-white/40">
                        {(item.fileSize / 1024 / 1024).toFixed(1)} MB
                      </p>
                    </div>
                    <a
                      href={item.url}
                      download={item.filename}
                      className="opacity-50 hover:opacity-90 transition-opacity shrink-0"
                    >
                      <Icons.download className="w-4 h-4" />
                    </a>
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}

        {/* Upload overlay */}
        {message.isUploading && (
          <div className="absolute inset-0 bg-black/60 rounded-[inherit] flex items-center justify-center">
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-6 h-6 border-[2.5px] border-white border-t-transparent rounded-full animate-spin" />
              <span className="text-[11px] text-white font-medium">
                Sending
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Reactions — Instagram-style floating pills */}
      {hasReactions && (
        <div
          className={`flex gap-1 -mt-1.5 mb-0.5 ${
            isOwn ? "pr-2" : "pl-2"
          }`}
        >
          {Object.entries(groupedReactions).map(([emoji, count]) => (
            <button
              key={emoji}
              onClick={() => handleAddReaction(message._id, emoji)}
              className="flex items-center gap-0.5 bg-[#1c1c1e] border border-white/15 rounded-full pl-1.5 pr-2 py-[3px] text-[13px] shadow-sm hover:border-white/35 active:scale-95 transition-all"
            >
              <span>{emoji}</span>
              {count > 1 && (
                <span className="text-[11px] text-white/60 ml-0.5">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Timestamp — revealed on hover */}
      <div
        className={`overflow-hidden transition-all duration-200 ease-in-out ${
          hovered ? "max-h-5 opacity-100" : "max-h-0 opacity-0"
        } px-0.5`}
      >
        <span className="text-[11px] text-neutral-500 leading-5">
          {formatInstagramTimestamp(message.createdAt)}
        </span>
      </div>
    </div>
  );
};
  const MessageContextMenu = () => (
    <DropdownMenu
      open={!!contextMenu}
      onOpenChange={(open) => !open && closeContextMenu()}
    >
      <DropdownMenuTrigger asChild>
        <div className="fixed inset-0 z-40" style={{ pointerEvents: "none" }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent sheetTitle="Message"
        align="end"
        className="bg-neutral-900 border-neutral-700 rounded-2xl w-56 p-2 z-50"
        style={{
          position: "fixed",
          left: Math.min(contextMenu?.x || 0, window.innerWidth - 224),
          top: Math.min(contextMenu?.y || 0, window.innerHeight - 300),
        }}
      >
        {selectedMessage?.isOwn &&
          selectedMessage?.content &&
          !selectedMessage?.isDeleted && (
            <DropdownMenuItem
              onClick={() => handleContextMenuAction("edit")}
              className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
            >
              <span>Edit</span>
              <Icons.edit className="w-4 h-4" />
            </DropdownMenuItem>
          )}
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("reply")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>Reply</span>
          <Icons.reply3 className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("react")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>React</span>
          <Icons.smile className="w-4 h-4" />
        </DropdownMenuItem>
        {selectedMessage?.content && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("copy")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
          >
            <span>Copy</span>
            <Icons.copy className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("forward")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>Forward</span>
          <Icons.forward className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("pin")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>{selectedMessage?.isPinned ? "Unpin" : "Pin"}</span>
          <Icons.pin className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-neutral-700 my-2" />
        {!selectedMessage?.isOwn && !selectedMessage?.isDeleted && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("report")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
          >
            <span>Report</span>
            <Icons.report className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        {selectedMessage?.isOwn && !selectedMessage?.isDeleted && (
          <DropdownMenuItem
            onClick={() => handleContextMenuAction("unsend")}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
          >
            <span>Unsend</span>
            <Icons.delete className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handleContextMenuAction("delete")}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
        >
          <span>Delete for me</span>
          <Icons.delete className="w-4 h-4" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (!userAuth?.token) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        <div className="text-center">
          <Icons.lock className="w-12 h-12 mx-auto mb-4 text-neutral-400" />
          <p>Please log in to access messages</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-black text-white">
      {/* Enhanced Header */}
      <header className="shrink-0 bg-black border-b border-neutral-800 z-10 py-3 px-3 sm:py-4 sm:px-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(-1)}
            className="md:hidden text-neutral-400 hover:text-white transition-colors"
            aria-label="Go back"
          >
            <Icons.back className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
              type="button"
              className="relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-600"
              onClick={() =>
                selectedUser?.username &&
                navigate(`/${selectedUser.username}`)
              }
              aria-label="View profile"
            >
              <img
                src={selectedUser?.profilePic || "/default-avatar.png"}
                alt={selectedUser?.username}
                className="w-9 h-9 rounded-full object-cover border border-neutral-700"
              />
              {isOnline && (
                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-black bg-green-500" />
              )}
            </button>
            <button
              type="button"
              className="flex-1 min-w-0 text-left cursor-pointer"
              onClick={() =>
                username && navigate(`/chat/${username}/details`)
              }
              aria-label="Conversation details"
            >
              <h2 className="font-medium text-base truncate">
                {selectedUser?.name || "User"}
              </h2>
              <UserStatusIndicator />
            </button>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => {
                /* Implement call functionality */
              }}
              className="text-neutral-400 hover:text-white transition-colors cursor-pointer p-0.5"
              aria-label="Voice Call"
            >
              <Icons.phone className="w-5 h-5 shrink-0" />
            </button>
            <button
              onClick={() => {
                /* Implement video call functionality */
              }}
              className="text-neutral-400 hover:text-white transition-colors cursor-pointer p-0.5"
              aria-label="Video Call"
            >
              <Icons.video className="w-5 h-5 shrink-0" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="text-white cursor-pointer" aria-label="Menu">
                  <Icons.about className="w-6 h-6" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent sheetTitle="Chat options"
                align="end"
                className="bg-neutral-900 border-neutral-700 rounded-2xl w-56 p-2"
              >
                <DropdownMenuItem
                  onClick={handleRestrict}
                  className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                  disabled={isRestricted}
                >
                  <span>{isRestricted ? "Restricted" : "Restrict"}</span>
                  <Icons.restrict className="w-5 h-5" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={isUserBlocked(username) ? handleUnblock : handleBlock}
                  className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                >
                  <span>{isUserBlocked(username) ? "Unblock" : "Block"}</span>
                  <Icons.block className="w-5 h-5" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleReport}
                  className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
                >
                  <span>Report</span>
                  <Icons.report className="w-5 h-5" />
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-neutral-700 my-2" />
                <DropdownMenuItem
                  onClick={handleDeleteChat}
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
              onChange={(e) => {
                setSearchQuery(e.target.value);
                searchMessages();
              }}
              className="flex-1 bg-neutral-800 text-white placeholder-neutral-400 rounded-full px-4 py-2 text-sm focus:outline-none"
            />
            <button
              onClick={() => {
                setShowSearch(false);
                setSearchQuery("");
                setSearchResults([]);
              }}
              className="text-neutral-400 hover:text-white p-2"
            >
              <Icons.close className="w-4 h-4" />
            </button>
          </div>
        )}
      </header>

      <main
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-hide"
      >
        {loading ? (
          <div className="flex justify-center items-center min-h-[200px]">
            <Icons.spinner className="animate-spin w-8 h-8 text-neutral-400" />
          </div>
        ) : (
          <div className="min-h-full flex flex-col">
            {pinnedMessages.length > 0 && !showPinned && <PinnedMessagesBar />}

            {showSearch && searchResults.length > 0 && (
              <div className="px-4 py-2 bg-neutral-900 mx-2 rounded-lg mb-4">
                <div className="text-xs text-neutral-400 mb-2">
                  {searchResults.length} result
                  {searchResults.length !== 1 ? "s" : ""} found
                </div>
                {searchResults.map((message) => (
                  <div
                    key={message._id}
                    className="text-sm py-2 border-b border-neutral-800 last:border-b-0 cursor-pointer hover:bg-neutral-800 px-2 rounded"
                    onClick={() => {
                      const element = document.getElementById(
                        `msg-${message._id}`
                      );
                      element?.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                      element?.classList.add("bg-violet-900");
                      setTimeout(
                        () => element?.classList.remove("bg-violet-900"),
                        2000
                      );
                    }}
                  >
                    <div className="flex justify-between mb-1">
                      <span className="text-neutral-400 text-xs">
                        {formatInstagramTimestamp(message.createdAt)}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {message.isOwn ? "You" : selectedUser?.name}
                      </span>
                    </div>
                    <p className="truncate">{getMessageContent(message)}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col items-center justify-center mt-6 mb-8 px-4">
              <img
                src={selectedUser?.profilePic || "/default-avatar.png"}
                alt={selectedUser?.username}
                className="w-20 h-20 rounded-full object-cover border-2 border-neutral-700"
              />
              <h3 className="mt-4 font-medium">{selectedUser?.name}</h3>
              {!blockedByThem && (
                <>
                  <p className="text-neutral-400">@{selectedUser?.username}</p>
                  <p className="text-sm text-neutral-400 mt-1">
                    {selectedUser?.followerCount || 0} followers
                  </p>
                </>
              )}
              <button
                className="bg-neutral-900 rounded-xl py-2 px-4 mt-3 font-medium text-sm hover:bg-neutral-800 transition-colors"
                onClick={() => navigate(`/${selectedUser?.username}`)}
              >
                View profile
              </button>
            </div>

            <div className="flex-1" />

            <div className="pb-4">
              <div ref={topSentinelRef} />
              {loadingMore && (
                <div className="flex justify-center py-4">
                  <Icons.spinner className="animate-spin w-6 h-6 text-neutral-400" />
                </div>
              )}
              {messageGroups.length === 0 ? (
                <div className="text-center py-12 text-neutral-400">
                  <Icons.chat2 className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No messages yet. Start the conversation!</p>
                </div>
              ) : (
                messageGroups.map((group, groupIndex) => {
                  const isOwn = group[0].isOwn;
                  const showTimestamp = shouldShowTimestamp(
                    messageGroups[groupIndex - 1],
                    group
                  );

                  return (
                    <React.Fragment key={`group-${groupIndex}-${group[0]._id}`}>
                      {showTimestamp && (
                        <div className="text-center text-xs text-neutral-500 my-4">
                          {formatInstagramTimestamp(group[0].createdAt)}
                        </div>
                      )}

                      <div
                        className={`flex ${isOwn ? "justify-end" : "justify-start"} px-3 mb-3`}
                      >
                        {!isOwn && (
                          <div className="mr-2 self-end mb-1">
                            <img
                              src={
                                selectedUser?.profilePic ||
                                "/default-avatar.png"
                              }
                              alt={selectedUser?.username}
                              className="w-8 h-8 rounded-full object-cover border border-neutral-800"
                            />
                          </div>
                        )}

                        <div
                          className={`max-w-[80%] flex flex-col gap-[2px] ${
                            isOwn ? "items-end" : "items-start"
                          }`}
                        >
                          {group.map((message, msgIndex) => (
                            <MessageBubble
                              key={message._id || message.tempId}
                              message={message}
                              isOwn={isOwn}
                              msgIndex={msgIndex}
                              groupLength={group.length}
                            />
                          ))}
                        </div>
                      </div>

                      {getMessageIndicator(group[group.length - 1], isOwn) && (
                        <div
                          className={`text-xs text-neutral-400 mt-1 px-3 ${
                            isOwn ? "text-right" : "text-left ml-12"
                          }`}
                        >
                          {getMessageIndicator(group[group.length - 1], isOwn)}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })
              )}
              {uploadingPreview && (
                <div className="flex justify-end px-3 mb-3">
                  <div className="max-w-[80%] flex flex-col items-end">
                    <MessageBubble
                      message={uploadingPreview}
                      isOwn={true}
                      msgIndex={0}
                      groupLength={1}
                    />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {isUserTyping && (
              <div className="flex justify-start px-3 mb-3">
                <div className="mr-2 self-end mb-1">
                  <img
                    src={selectedUser?.profilePic || "/default-avatar.png"}
                    alt={selectedUser?.username}
                    className="w-8 h-8 rounded-full object-cover border border-neutral-800"
                  />
                </div>
                <div className="bg-neutral-800 px-4 py-3 rounded-2xl rounded-bl-md">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce" />
                    <div
                      className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.1s" }}
                    />
                    <div
                      className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.2s" }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <div className="shrink-0 bg-black" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {replyingTo && <ReplyPreview />}
        {editingMessage && <EditingPreview />}

        {blocked || isRestricted ? (
          isUserBlocked(username) || isBlocked ? (
            // You blocked them — Instagram-style bar with Unblock / Delete.
            <div className="bg-black border-t border-neutral-800 px-4 pt-3 pb-4">
              <p className="text-center font-semibold text-[15px]">
                You blocked {username}
              </p>
              <p className="text-center text-neutral-400 text-sm mt-1 mb-3">
                You can't message or call this profile unless you unblock them
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleUnblock}
                  className="flex-1 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 font-semibold cursor-pointer"
                >
                  Unblock
                </button>
                <button
                  onClick={handleDeleteChat}
                  className="flex-1 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 font-semibold text-red-500 cursor-pointer"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : blockedByThem ? (
            <div className="py-4 bg-black border-t border-neutral-800 text-center text-neutral-400 text-sm">
              You can't message this account
            </div>
          ) : (
            <div className="py-4 bg-black border-t border-neutral-800 text-center text-neutral-400 text-sm">
              You cannot message restricted users
            </div>
          )
        ) : (
          <div className="bg-black border-t border-neutral-800">
          {selectedMediaFiles.length > 0 && !isRecording && !voicePreview && <MediaWidget />}
          <div className="py-3">
          {/* ── Instagram-style recording bar ── */}
          {isRecording ? (
            <div className="flex items-center gap-2.5 mx-3 px-3 py-2 bg-[#0095F6] rounded-full">
              {/* Delete / cancel */}
              <button
                onClick={cancelRecording}
                className="shrink-0 p-1 text-white/80 hover:text-red-400 cursor-pointer transition-colors"
                aria-label="Cancel recording"
              >
                <Icons.trash className="w-5 h-5" />
              </button>

              {/* Live waveform — bars sized by real amplitude (0–1) */}
              <div className="flex-1 flex items-center justify-start gap-[2px] h-9 overflow-hidden">
                {liveWaveform.map((amp, i) => (
                  <div
                    key={i}
                    className="w-[2.5px] rounded-full bg-white shrink-0"
                    style={{
                      height: `${Math.max(3, amp * 30)}px`,
                      transition: "height 60ms ease-out",
                    }}
                  />
                ))}
                {/* idle dots shown before first tick */}
                {liveWaveform.length === 0 && (
                  <div className="flex items-center gap-[2px]">
                    {[0.3, 0.5, 0.4, 0.6, 0.3].map((a, i) => (
                      <div key={i} className="w-[2.5px] rounded-full bg-white/60 shrink-0" style={{ height: `${a * 30}px` }} />
                    ))}
                  </div>
                )}
              </div>

              {/* Timer */}
              <span className="text-white text-[13px] font-semibold tabular-nums shrink-0 min-w-[38px] text-right">
                {`${Math.floor(recordingTime / 60).toString().padStart(2, "0")}:${(recordingTime % 60).toString().padStart(2, "0")}`}
              </span>

              {/* Stop button — square icon → transitions to preview */}
              <button
                onClick={stopRecording}
                className="shrink-0 w-8 h-8 bg-white rounded-full flex items-center justify-center ml-1 cursor-pointer active:scale-95 transition-transform"
                aria-label="Stop recording"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-[#0095F6]">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              </button>
            </div>

          ) : voicePreview ? (
          /* ── Voice preview bar ── */
            <div className="flex items-center gap-2.5 mx-3 px-3 py-2 bg-[#0095F6] rounded-full">
              {/* Delete */}
              <button
                onClick={cancelVoicePreview}
                className="shrink-0 p-1 text-white/80 hover:text-red-400 cursor-pointer transition-colors"
                aria-label="Delete voice note"
              >
                <Icons.trash className="w-5 h-5" />
              </button>

              {/* Play / Pause preview */}
              <button
                onClick={toggleVoicePreviewPlay}
                className="shrink-0 w-7 h-7 flex items-center justify-center text-white cursor-pointer"
                aria-label={isVoicePreviewPlaying ? "Pause" : "Play"}
              >
                {isVoicePreviewPlaying ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                ) : (
                  <Icons.play className="w-5 h-5 ml-0.5" />
                )}
              </button>

              {/* Snapshot waveform (static) */}
              <div className="flex-1 flex items-center justify-start gap-[2px] h-9 overflow-hidden">
                {(voicePreview.waveformSnapshot?.length > 0
                  ? voicePreview.waveformSnapshot
                  : voiceStaticWaveform
                ).map((amp, i) => (
                  <div
                    key={i}
                    className="w-[2.5px] rounded-full bg-white/70 shrink-0"
                    style={{ height: `${Math.max(3, amp * 30)}px` }}
                  />
                ))}
              </div>

              {/* Duration */}
              <span className="text-white text-[13px] font-semibold tabular-nums shrink-0 min-w-[38px] text-right">
                {`${Math.floor((voicePreview.duration || 0) / 60).toString().padStart(2, "0")}:${((voicePreview.duration || 0) % 60).toString().padStart(2, "0")}`}
              </span>

              {/* Send */}
              <button
                onClick={sendVoiceNote}
                disabled={isSending}
                className="shrink-0 w-8 h-8 bg-white rounded-full flex items-center justify-center ml-1 cursor-pointer active:scale-95 transition-transform disabled:opacity-60"
                aria-label="Send voice note"
              >
                {isSending ? (
                  <Icons.spinner className="w-4 h-4 text-[#0095F6] animate-spin" />
                ) : (
                  <Icons.send className="w-4 h-4 text-[#0095F6]" />
                )}
              </button>
            </div>

          ) : (
          /* ── Normal input row ── */
          <>
          <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 relative">
            <button
              onMouseDown={startRecording}
              onTouchStart={startRecording}
              className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors"
              aria-label="Voice message"
            >
              <Icons.mic className="w-6 h-6" />
            </button>

            {/* Desktop only: phone keyboards have their own emoji panel, and
                this one is a fixed-width popover that doesn't fit beside it. */}
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="hidden md:inline-flex text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
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
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={editingMessage ? "Edit message..." : "Message..."}
              className="flex-1 min-w-0 bg-neutral-800 text-sm text-white placeholder-neutral-400 focus:outline-none py-2 sm:py-2.5 px-3 sm:px-4 rounded-full disabled:opacity-50"
              disabled={isSending}
              maxLength={MAX_MESSAGE_LENGTH}
            />

            <div className="hidden sm:block text-xs text-neutral-500 min-w-[60px] text-right">
              {newMessage.length}/{MAX_MESSAGE_LENGTH}
            </div>

            <input
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/x-msvideo"
              ref={fileInputRef}
              onChange={handleMediaSelect}
              className="hidden"
              multiple
            />

            {newMessage.trim() || editingMessage || selectedMediaFiles.length > 0 ? (
              <button
                onClick={handleSendButtonClick}
                disabled={isSending}
                className="text-white px-3 sm:px-4 py-2 rounded-full bg-violet-600 hover:bg-violet-700 transition-colors disabled:opacity-50 font-medium text-sm shrink-0"
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
                  onClick={() => fileInputRef.current.click()}
                  className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                  disabled={isSending}
                  aria-label="Media"
                >
                  <Icons.image className="w-6 h-6" />
                </button>
                <button
                  onClick={() => {
                    setShowGifPicker(!showGifPicker);
                  }}
                  className="text-neutral-400 hover:text-white p-1.5 sm:p-2 transition-colors disabled:opacity-50"
                  disabled={isSending}
                  aria-label="GIF"
                >
                  <Icons.gif className="w-6 h-6" />
                </button>
              </div>
            )}
          </div>

          {showGifPicker && (
            <GifPicker
              onSelect={handleGifSelect}
              onClose={() => setShowGifPicker(false)}
            />
          )}
          </>
          )}
          </div>
          </div>
        )}
      </div>

      {isPreviewOpen && <MediaPreviewModal />}
      {showForwardModal && <ForwardModal />}

      {bigPreviewMedia && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-50"
          onClick={() => setBigPreviewMedia(null)}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setBigPreviewMedia(null)}
              className="absolute -top-3 -right-3 w-5 h-5 bg-neutral-600 rounded-full flex items-center justify-center hover:bg-red-500 transition-colors z-10"
            >
              <Icons.close className="w-3 h-3 text-white" />
            </button>
            {bigPreviewMedia.type === "image" ? (
              <img
                src={bigPreviewMedia.url}
                alt=""
                className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl"
              />
            ) : (
              <video
                src={bigPreviewMedia.url}
                controls
                autoPlay
                className="max-w-[90vw] max-h-[90vh] rounded-xl"
              />
            )}
          </div>
        </div>
      )}
      {contextMenu && <MessageContextMenu />}
    </div>
  );
};

export default UserConversationPage;
