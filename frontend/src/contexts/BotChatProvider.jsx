import { useCallback, useMemo, useState } from "react";
import { botAPI } from "../services/api";
import { ChatContext } from "./ChatContext";

/*
 * Supplies the existing DM screens with a bot-owned, read-only thread.  It has
 * the same read shape as ChatProvider, but deliberately exposes no mutation
 * implementation: the owner can inspect a bot's conversations without acting
 * as that bot.
 */
const emptyPage = { hasNextPage: false, nextCursor: null };

const BotChatProvider = ({ botId, children }) => {
  const [conversations, setConversations] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [listPageInfo, setListPageInfo] = useState(emptyPage);
  const [messages, setMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [currentConversation, setCurrentConversation] = useState(null);

  const loadConversations = useCallback(async (params = {}) => {
    setListLoading(true);
    setListError(null);
    try {
      const response = await botAPI.getChats(botId, params);
      const chats = Array.isArray(response)
        ? response
        : response?.chats || response?.conversations || response?.items || [];
      setConversations(chats);
      setListPageInfo(response?.pageInfo || emptyPage);
      return response;
    } catch (error) {
      setListError("Could not load conversations.");
      throw error;
    } finally {
      setListLoading(false);
    }
  }, [botId]);

  const loadMessages = useCallback(async (username, cursor = null) => {
    setThreadLoading(true);
    try {
      const response = await botAPI.getConversation(botId, username, cursor ? { cursor } : {});
      const nextMessages = response?.messages || [];
      setMessages((current) => (cursor ? [...nextMessages, ...current] : nextMessages));
      setHasMoreMessages(Boolean(response?.hasMore || response?.pageInfo?.hasNextPage));
      return response;
    } finally {
      setThreadLoading(false);
    }
  }, [botId]);

  const actions = useMemo(() => ({
    loadConversations,
    loadMoreConversations: async () => null,
    loadMessages,
    setCurrentConversation,
    loadPreferences: async () => null,
    hydrateThreadFromCache: async () => null,
    // All mutating normal-DM actions are intentionally inert in bot inspection mode.
    clearChatUnread: async () => null,
    markConversationUnread: async () => null,
    applyPreferences: async () => null,
    setChatState: async () => null,
    toggleFavoriteChat: async () => null,
    deleteChat: async () => false,
    sendMessage: async () => null,
    markConversationAsRead: () => null,
    checkUserStatus: () => null,
    reactToMessage: async () => null,
    editMessage: async () => null,
    unsendMessage: async () => null,
    deleteMessageForMe: async () => null,
    pinMessage: async () => null,
    voteInPoll: async () => null,
    startTyping: () => null,
    stopTyping: () => null,
  }), [loadConversations, loadMessages]);

  const value = useMemo(() => ({
    conversations,
    listLoading,
    listLoadingMore: false,
    listError,
    listPageInfo,
    messages,
    threadLoading,
    hasMoreMessages,
    currentConversation,
    onlineUsers: new Set(),
    unreadCounts: {},
    typingUsers: {},
    userLastSeenMap: {},
    peerReadAt: {},
    preferences: {
      loaded: false,
      categories: [],
      categoryAssignments: {},
      favoriteChats: [],
      mutedChats: [],
      pinnedChats: [],
      lockedChats: [],
      hasLockPin: false,
      disappearingByChat: [],
    },
    actions,
  }), [
    actions,
    conversations,
    currentConversation,
    hasMoreMessages,
    listError,
    listLoading,
    listPageInfo,
    messages,
    threadLoading,
  ]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export default BotChatProvider;
