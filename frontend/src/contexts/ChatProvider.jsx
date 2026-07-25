// frontend/src/contexts/ChatProvider.jsx
import React, { useReducer, useEffect } from "react";
import { toast } from "react-hot-toast";
import { useSocket } from "./useSocket";
import { chatAPI } from "../services/api";
import { ChatContext } from "./ChatContext";

const initialState = {
  conversations: [],
  currentConversation: null, // Track currently active conversation ID (userId or groupId)
  messages: [],
  loading: false,
  error: null,
  hasMoreMessages: false,
  typingUsers: {},
  onlineUsers: new Set(),
  userLastSeenMap: {},
  selectedMessage: null,
  replyMessage: null,
  searchResults: [],
  unreadCounts: {},
};

function chatReducer(state, action) {
  switch (action.type) {
    case "SET_LOADING":
      return { ...state, loading: action.payload };

    case "SET_ERROR":
      return { ...state, error: action.payload, loading: false };

    case "SET_CONVERSATIONS":
      return {
        ...state,
        conversations: action.payload,
        loading: false,
      };

    case "ADD_CONVERSATION":
      return {
        ...state,
        conversations: [action.payload, ...state.conversations],
      };

    case "SET_CURRENT_CONVERSATION":
      return {
        ...state,
        currentConversation: action.payload,
        messages: [],
        replyMessage: null,
      };

    case "SET_MESSAGES":
      return {
        ...state,
        messages: action.payload.isPagination
          ? [...action.payload.messages, ...state.messages]
          : action.payload.messages,
        hasMoreMessages: action.payload.hasMore,
        loading: false,
      };

    case "ADD_MESSAGE": {
      // Direct add (optimistic or loading).
      if (action.payload.tempId) {
        const tempIndex = state.messages.findIndex(
          (msg) => msg.tempId === action.payload.tempId
        );
        if (tempIndex !== -1) {
          const newMessages = [...state.messages];
          newMessages[tempIndex] = {
            ...newMessages[tempIndex],
            ...action.payload,
          };
          return { ...state, messages: newMessages };
        }
      }

      const messageExists = state.messages.some(
        (msg) => msg._id === action.payload._id
      );
      if (messageExists) return state;

      return {
        ...state,
        messages: [...state.messages, action.payload],
      };
    }

    case "ADD_MESSAGE_IF_ACTIVE": {
      const { message } = action.payload;
      const activeId = state.currentConversation;

      // Determine if message belongs to active chat
      let belongsToActive = false;

      if (message.isGroupMessage) {
        const groupId = message.group?._id || message.group;
        belongsToActive = groupId && (groupId.toString() === activeId || groupId === activeId);
      } else {
        const senderId = message.sender?._id || message.sender;
        const receiverId = message.receiver?._id || message.receiver;
        const senderStr = senderId?.toString?.() || senderId;
        const receiverStr = receiverId?.toString?.() || receiverId;
        belongsToActive =
          senderStr === activeId ||
          (message.isOwn && receiverStr === activeId);
      }

      if (!belongsToActive) return state;

      // Replace optimistic message if tempId matches
      if (message.tempId) {
        const tempIndex = state.messages.findIndex(
          (msg) => msg.tempId === message.tempId
        );
        if (tempIndex !== -1) {
          const newMessages = [...state.messages];
          newMessages[tempIndex] = { ...newMessages[tempIndex], ...message };
          return { ...state, messages: newMessages };
        }
      }

      // Deduplicate by real _id
      const messageExists = state.messages.some(
        (msg) => msg._id === message._id
      );
      if (messageExists) return state;

      return { ...state, messages: [...state.messages, message] };
    }

    case "UPDATE_MESSAGE":
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg._id === action.payload._id ? { ...msg, ...action.payload } : msg
        ),
      };

    case "DELETE_MESSAGE":
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg._id === action.payload.messageId
            ? { ...msg, deletedFor: action.payload.deletedFor }
            : msg
        ),
      };

    case "ADD_REACTION":
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg._id === action.payload.messageId
            ? { ...msg, reactions: action.payload.reactions }
            : msg
        ),
      };

    case "SET_TYPING":
      return {
        ...state,
        typingUsers: {
          ...state.typingUsers,
          [action.payload.userId]: action.payload.isTyping,
        },
      };

    case "SET_ONLINE_USERS":
      return {
        ...state,
        onlineUsers: new Set(action.payload),
      };

    case "UPDATE_USER_STATUS": {
      const onlineUsers = new Set(state.onlineUsers);
      if (action.payload.isOnline) {
        onlineUsers.add(action.payload.userId);
      } else {
        onlineUsers.delete(action.payload.userId);
      }
      const userLastSeenMap = { ...state.userLastSeenMap };
      if (action.payload.lastSeen) {
        userLastSeenMap[action.payload.userId] = action.payload.lastSeen;
      }
      return { ...state, onlineUsers, userLastSeenMap };
    }

    case "SET_REPLY_MESSAGE":
      return { ...state, replyMessage: action.payload };

    case "CLEAR_REPLY_MESSAGE":
      return { ...state, replyMessage: null };

    case "UPDATE_POLL":
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg._id === action.payload.messageId
            ? { ...msg, poll: action.payload.poll }
            : msg
        ),
      };

    case "UPDATE_CONVERSATION_LAST_MESSAGE":
      return {
        ...state,
        conversations: state.conversations.map((conv) =>
          conv.id === action.payload.conversationId
            ? { ...conv, latestMessage: action.payload.message, lastMessageTime: action.payload.message?.createdAt }
            : conv
        ),
      };

    case "PIN_MESSAGE":
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg._id === action.payload.messageId
            ? { ...msg, isPinned: action.payload.isPinned }
            : msg
        ),
      };

    default:
      return state;
  }
}

export function ChatProvider({ children }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const { socket, isConnected } = useSocket();

  // Socket event handlers
  const currentConversationRef = React.useRef(state.currentConversation);

  useEffect(() => {
    currentConversationRef.current = state.currentConversation;
  }, [state.currentConversation]);

  // Socket event handlers
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleNewMessage = (message) => {
      dispatch({
        type: "ADD_MESSAGE_IF_ACTIVE",
        payload: { message },
      });

      // Compute the conversation ID used in the chats list
      let conversationId;
      if (message.isGroupMessage) {
        const groupId = message.group?._id || message.group;
        conversationId = `group_${groupId}`;
      } else {
        const senderId = message.sender?._id?.toString?.() || message.sender?.toString?.();
        const receiverId = message.receiver?._id?.toString?.() || message.receiver?.toString?.();
        // The "other" person is whoever is not us (isOwn means we sent it)
        const otherId = message.isOwn ? receiverId : senderId;
        conversationId = `user_${otherId}`;
      }

      if (conversationId) {
        dispatch({
          type: "UPDATE_CONVERSATION_LAST_MESSAGE",
          payload: { conversationId, message },
        });
      }
    };

    const handleMessageUnsent = (data) => {
      dispatch({
        type: "UPDATE_MESSAGE",
        payload: {
          _id: data.messageId,
          isDeleted: true,
          content: "This message was deleted",
          media: [],
        },
      });
    };

    const handleMessageReaction = (data) => {
      dispatch({
        type: "ADD_REACTION",
        payload: {
          messageId: data.messageId,
          reactions: data.reactions,
        },
      });
    };

    const handleMessageEdited = (data) => {
      dispatch({
        type: "UPDATE_MESSAGE",
        payload: {
          _id: data.messageId,
          content: data.content,
          isEdited: true,
          updatedAt: data.editedAt,
        },
      });
    };

    const handleMessageDeleted = (data) => {
      dispatch({
        type: "DELETE_MESSAGE",
        payload: data,
      });
    };

    const handleUserTyping = (data) => {
      dispatch({
        type: "SET_TYPING",
        payload: {
          userId: data.userId,
          isTyping: data.isTyping,
        },
      });
    };

    const handleUserStatusChange = (data) => {
      dispatch({
        type: "UPDATE_USER_STATUS",
        payload: data,
      });
    };

    const handlePollUpdated = (data) => {
      dispatch({
        type: "UPDATE_POLL",
        payload: data,
      });
    };

    const handleMessagePinned = (data) => {
      dispatch({
        type: "PIN_MESSAGE",
        payload: {
          messageId: data.messageId,
          isPinned: data.isPinned,
        },
      });
    };

    // The server rejects sends for blocks, privacy and feature flags by
    // emitting "error". Nothing listened for it, so a rejected message sat at
    // "sending" forever with no explanation.
    const handleSendError = (payload) => {
      const message = payload?.message || "Message couldn't be sent";
      if (payload?.tempId) {
        dispatch({
          type: "UPDATE_MESSAGE",
          payload: { _id: payload.tempId, messageStatus: "failed", failedReason: message },
        });
      }
      dispatch({ type: "SET_ERROR", payload: message });
      toast.error(message);
    };

    socket.on("error", handleSendError);
    socket.on("receiveMessage", handleNewMessage);
    socket.on("receiveGroupMessage", handleNewMessage);
    socket.on("messageReaction", handleMessageReaction);
    socket.on("messageEdited", handleMessageEdited);
    socket.on("messageDeleted", handleMessageDeleted);
    socket.on("messageUnsent", handleMessageUnsent);
    socket.on("userTyping", handleUserTyping);
    socket.on("userStatus", handleUserStatusChange);
    socket.on("pollUpdated", handlePollUpdated);
    socket.on("messagePinned", handleMessagePinned);

    return () => {
      socket.off("error", handleSendError);
      socket.off("receiveMessage", handleNewMessage);
      socket.off("receiveGroupMessage", handleNewMessage);
      socket.off("messageReaction", handleMessageReaction);
      socket.off("messageEdited", handleMessageEdited);
      socket.off("messageDeleted", handleMessageDeleted);
      socket.off("messageUnsent", handleMessageUnsent);
      socket.off("userTyping", handleUserTyping);
      socket.off("userStatus", handleUserStatusChange);
      socket.off("pollUpdated", handlePollUpdated);
      socket.off("messagePinned", handleMessagePinned);
    };
  }, [socket, isConnected]);

  const actions = React.useMemo(
    () => ({
      loadConversations: async (params = {}) => {
        try {
          dispatch({ type: "SET_LOADING", payload: true });
          const response = await chatAPI.getConversations(params);
          dispatch({ type: "SET_CONVERSATIONS", payload: response.chats });
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      setCurrentConversation: (id) => {
        dispatch({ type: "SET_CURRENT_CONVERSATION", payload: id });
      },

      loadMessages: async (conversationId, cursor = null) => {
        try {
          dispatch({ type: "SET_LOADING", payload: true });
          const response = await chatAPI.getMessages(conversationId, {
            cursor,
          });

          dispatch({
            type: "SET_MESSAGES",
            payload: {
              messages: response.messages,
              hasMore: response.pageInfo?.hasNextPage ?? response.hasMore,
              isPagination: !!cursor,
            },
          });
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      loadGroupMessages: async (groupId, cursor = null) => {
        try {
          dispatch({ type: "SET_LOADING", payload: true });
          const response = await chatAPI.getGroupMessages(groupId, { cursor });

          dispatch({
            type: "SET_MESSAGES",
            payload: {
              messages: response.messages,
              hasMore: response.pageInfo?.hasNextPage ?? response.hasMore,
              isPagination: !!cursor,
            },
          });
          return response;
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
          throw error;
        }
      },

      sendMessage: async (messageData) => {
        try {
          if (!socket) throw new Error("Socket not connected");
          socket.emit("sendMessage", messageData);

          // Build a proper optimistic message so sender/receiver objects exist
          // and the message renders on the correct side immediately.
          const optimistic = {
            ...messageData,
            sender: {
              _id: messageData.senderId,
              username: messageData.senderUsername,
            },
            receiver: {
              _id: messageData.receiverId,
              username: messageData.receiverUsername,
            },
            _id: messageData.tempId || Date.now().toString(),
            createdAt: messageData.createdAt || new Date().toISOString(),
            isOwn: true,
            messageStatus: "sending",
          };

          dispatch({ type: "ADD_MESSAGE", payload: optimistic });
          dispatch({ type: "CLEAR_REPLY_MESSAGE" });
          return messageData;
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
          throw error;
        }
      },

      sendGroupMessage: async (messageData) => {
        try {
          if (!socket) throw new Error("Socket not connected");
          socket.emit("sendGroupMessage", messageData);

          const optimistic = {
            ...messageData,
            sender: {
              _id: messageData.senderId || messageData.sender,
              username: messageData.senderUsername,
            },
            _id: messageData.tempId || Date.now().toString(),
            createdAt: messageData.createdAt || new Date().toISOString(),
            isOwn: true,
            isGroupMessage: true,
            messageStatus: "sending",
          };

          dispatch({ type: "ADD_MESSAGE", payload: optimistic });
          dispatch({ type: "CLEAR_REPLY_MESSAGE" });
          return messageData;
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
          throw error;
        }
      },

      startTyping: (receiverId) => {
        if (socket) {
          socket.emit("typing", { receiverId, isTyping: true });
        }
      },

      stopTyping: (receiverId) => {
        if (socket) {
          socket.emit("typing", { receiverId, isTyping: false });
        }
      },

      reactToMessage: async (messageId, emoji) => {
        try {
          await chatAPI.reactToMessage(messageId, { emoji });
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      editMessage: async (messageId, content) => {
        try {
          await chatAPI.editMessage(messageId, { content });
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      deleteMessage: async (messageId) => {
        try {
          await chatAPI.deleteMessage(messageId);
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      unsendMessage: async (messageId) => {
        try {
          await chatAPI.unsendMessage(messageId);
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      deleteMessageForMe: async (messageId) => {
        try {
          await chatAPI.deleteMessageForMe(messageId);
          dispatch({
            type: "DELETE_MESSAGE",
            payload: { messageId, deletedFor: "me" },
          });
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      pinMessage: async (messageId) => {
        try {
          await chatAPI.pinMessage(messageId);
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      voteInPoll: async (messageId, optionIndexes) => {
        try {
          await chatAPI.voteInPoll(messageId, { optionIndexes });
        } catch (error) {
          dispatch({ type: "SET_ERROR", payload: error.message });
        }
      },

      markMessageAsRead: (messageId, receiverId) => {
        if (socket) {
          socket.emit("markAsRead", { messageId, receiverId });
        }
      },

      markConversationAsRead: (senderId) => {
        if (socket) {
          socket.emit("markConversationAsRead", { senderId });
        }
      },

      checkUserStatus: (userId) => {
        if (socket) {
          socket.emit("getUserStatus", { userId });
        }
      },

      setReplyMessage: (message) => {
        dispatch({ type: "SET_REPLY_MESSAGE", payload: message });
      },

      clearReplyMessage: () => {
        dispatch({ type: "CLEAR_REPLY_MESSAGE" });
      },

      addConversation: (conv) =>
        dispatch({ type: "ADD_CONVERSATION", payload: conv }),
    }),
    [socket]
  ); 

  const value = React.useMemo(
    () => ({
      ...state,
      actions,
    }),
    [state, actions]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
