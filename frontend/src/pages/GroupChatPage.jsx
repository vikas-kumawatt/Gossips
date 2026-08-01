import React, {
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { UserContext } from "../contexts/UserContext";
import { useChat } from "../contexts/ChatContext";
import { useReport } from "../contexts/ReportContext";
import axios from "axios"; // Still needed for Giphy or other direct calls if any
import { useParams, useNavigate } from "react-router-dom";
import { Icons } from "../components/icons";
import SharedPostCard from "../components/Chat/SharedPostCard";
import EmojiPicker from "emoji-picker-react";
import ResponsiveMenu from "../components/ui/ResponsiveMenu";

const MESSAGE_RATE_LIMIT = 1000;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const GroupChatPage = () => {
  const { userAuth } = useContext(UserContext);
  const currentUserId = userAuth?._id || userAuth?.id;
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { openReport } = useReport();

  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
    // Actually ChatContext doesn't explicity track "activeGroup" separate from "currentConversation".
    // "currentConversation" could be the group. But payload structure varies.
    // We will trust local 'group' state for header info, and 'messages' from context.
    // Use context pagination state
    actions: {
      loadGroupMessages,
      sendGroupMessage,
      editMessage, // Context handles if it's group message via messageId?
      unsendMessage,
      deleteMessageForMe, // Context handles logic
      pinMessage,
      setCurrentConversation,
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
  const [hasMore, setHasMore] = useState(true); // Added missing hasMore state
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastMessageTime = useRef(0);
  const hasFetchedData = useRef(false);
  const observerRef = useRef(null);

  // Initialization Effect
  useEffect(() => {
    const initChat = async () => {
      // If we already fetched for this groupId, skip?
      // UserConversationPage resets hasFetchedData on params change.
      if (hasFetchedData.current === groupId) return;
      hasFetchedData.current = groupId;

      setLoading(true);
      setError(null);

      try {
        // Load messages and get group info from response
        const response = await loadGroupMessages(groupId);
        // response contains { messages, hasMore, groupInfo }

        if (response && response.groupInfo) {
          setGroup(response.groupInfo);
          setHasMore(response.hasMore); // Update hasMore based on response
        }

        // Set active conversation for socket filtering
        setCurrentConversation(groupId);
      } catch (err) {
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
  }, [groupId, userAuth.token, loadGroupMessages, setCurrentConversation]);

  const loadMoreMessages = useCallback(async () => {
    if (!hasMore || loadingMore || messagesLoading) return;

    setLoadingMore(true);
    try {
      const oldestMessage = messages[0];
      if (!oldestMessage) return;

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
      setLoadingMore(false);
    }
  }, [
    hasMore,
    loadingMore,
    messagesLoading,
    messages,
    loadGroupMessages,
    groupId,
  ]);

  useEffect(() => {
    if (!messagesContainerRef.current || !hasMore) return;

    const options = {
      root: messagesContainerRef.current,
      rootMargin: "100px",
      threshold: 0.1,
    };

    observerRef.current = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingMore) {
        loadMoreMessages();
      }
    }, options);

    const firstMessage = messagesContainerRef.current.querySelector(
      "[data-first-message]"
    );
    if (firstMessage) {
      observerRef.current.observe(firstMessage);
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, loadingMore, loadMoreMessages]);

  useEffect(() => {
    if (messagesError) {
      setError(messagesError);
    }
  }, [messagesError]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle typing - Group typing might be noisy, often disabled or simplified.
  // We'll skip outgoing typing events for now or implement if backend supports room typing.
  // Backend `socket.on("typing")` takes { receiverId }.
  // For groups, it likely expects receiverId to be groupId?
  // Let's check backend `handleUserTyping`: `const typingKey = user:${receiverId}`.
  // It assumes 1:1. It doesn't seem to handle `group:${groupId}` key logic explicitly for broadcasting to room?
  // lines 411: typingUsers.set(typingKey...
  // lines 435: const receiverSockets = userSockets.get(receiverId).
  // It tries to emit to specific user. It does NOT emit to a room.
  // So typing indicators won't work for groups with current backend logic.
  // I will disabling typing emission for groups.

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
      lastMessageTime.current = Date.now();
    } catch (err) {
      console.error("Error sending message:", err);
      setError("Failed to send message");
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
      setNewMessage("");
      setEditingMessage(null);
    } catch (err) {
      console.error("Error editing message:", err);
      setError("Failed to edit message");
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

    const formData = new FormData();
    formData.append("file", file);

    try {
      const endpoint =
        messageType === "voice" ? "/chats/upload/voice" : "/chats/upload";
      // Need to set name manually for voice if needed, but 'file' usually works if multer expects it.
      if (messageType === "voice") formData.append("audio", file); // Multer expects 'audio' for voice

      const uploadResponse = await axios.post(
        `${import.meta.env.VITE_SERVER}${endpoint}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${userAuth.token}`,
            "Content-Type": "multipart/form-data",
          },
        }
      );
      const media = uploadResponse.data.media; // Assuming response structure { media: [...] } or { url: ... }
      // chatController uploadChatMedia returns { media: [...] } (array of objects)

      await sendMessage(media, messageType);

      setMediaPreview(null);
      setIsPreviewOpen(false);
    } catch (err) {
      console.error("Upload failed", err);
      setError("Failed to upload media");
    }
  };

  const handlePinMessage = async (messageId) => {
    try {
      await pinMessage(messageId);
    } catch (err) {
      console.error("Pin failed", err);
    }
  };

  // Messages loaded from the server carry no `isOwn` flag — only the optimistic
  // send path sets one — so ownership has to be derived from the sender.
  const isOwnMessage = (msg) =>
    msg?.sender?._id === userAuth?.id || msg?.sender === userAuth?.id;

  const handleContextMenuAction = async (action) => {
    if (!selectedMessage) return;
    switch (action) {
      case "reply":
        setReplyingTo(selectedMessage);
        break;
      case "edit":
        setEditingMessage(selectedMessage);
        setNewMessage(selectedMessage.content);
        break;
      case "unsend":
        await unsendMessage(selectedMessage._id);
        break;
      case "delete":
        await deleteMessageForMe(selectedMessage._id);
        break;
      case "pin":
        await handlePinMessage(selectedMessage._id);
        break;
      case "copy":
        navigator.clipboard.writeText(selectedMessage.content);
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

  if (loading && !messages.length) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        Loading group...
      </div>
    );
  }

  if (!group && !loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        Group not found
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-black text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-neutral-900 border-b border-neutral-800">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/chat")} className="mr-2 md:hidden">
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
          {/* Add group specific actions like 'Info' */}
          <button className="text-neutral-400 hover:text-white">
            <Icons.info className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-900/50 border border-red-500/50 rounded-lg text-red-200 text-sm text-center">
          {error}
        </div>
      )}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
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
              <div
                className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                  isOwn ? "bg-blue-600 text-white" : "bg-neutral-800 text-white"
                } ${msg.isDeleted ? "italic opacity-70" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedMessage(msg);
                  setContextMenu({ x: e.clientX, y: e.clientY });
                }}
              >
                {!isOwn &&
                  (index === 0 ||
                    messages[index - 1].sender._id !== msg.sender._id) && (
                    <p className="text-xs text-blue-300 mb-1 font-medium">
                      {msg.sender.username}
                    </p>
                  )}

                {msg.replyTo && (
                  <div className="mb-2 p-2 bg-black/20 rounded text-sm border-l-2 border-white/50">
                    <p className="text-xs font-semibold">
                      {msg.replyTo.senderUsername}
                    </p>
                    <p className="truncate opacity-80">
                      {msg.replyTo.content || "Media"}
                    </p>
                  </div>
                )}

                {msg.messageType === "post_share" && msg.sharedContent && (
                  <div className={msg.content ? "mb-2" : ""}>
                    <SharedPostCard sharedContent={msg.sharedContent} />
                  </div>
                )}

                {msg.media && msg.media.length > 0 && (
                  <div className="mb-2">
                    {msg.media.map((m, i) => (
                      <div key={i} className="rounded overflow-hidden">
                        {m.type === "image" && (
                          <img
                            src={m.url}
                            alt="media"
                            className="max-w-full h-auto"
                          />
                        )}
                        {/* Add other media types handling */}
                      </div>
                    ))}
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
              </div>
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
            className="text-neutral-400 hover:text-white p-2"
          >
            <Icons.plus className="w-6 h-6" />
          </button>
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

          {(selectedMessage?.isOwn || !selectedMessage) && (
            <>
              <button
                onClick={() => handleContextMenuAction("edit")}
                className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
              >
                <Icons.edit className="w-4 h-4" /> Edit
              </button>
              <button
                onClick={() => handleContextMenuAction("unsend")}
                className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2 text-red-400"
              >
                <Icons.trash className="w-4 h-4" /> Unsend
              </button>
            </>
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
