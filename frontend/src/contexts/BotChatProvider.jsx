import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { botAPI } from "../services/api";
import { ChatContext } from "./ChatContext";

/*
 * Supplies the existing DM screens with a bot-owned, read-only thread.  It has
 * the same read shape as ChatProvider, but deliberately exposes no mutation
 * implementation: the owner can inspect a bot's conversations without acting
 * as that bot.
 */
const emptyPage = { hasNextPage: false, nextCursor: null };

/*
 * Which threads the owner has already looked at, per bot.
 *
 * ── Why this is not the real read state ─────────────────────────────────────
 *
 * The unread count on a bot's chat list is the *bot's*, and it is load-bearing: the runner
 * builds its perception from `ConversationRead`, drops any conversation with nothing unread,
 * and may only reply to a conversation that survived that filter. So marking a thread read
 * the way the normal DM screen does would not just be the owner acting as the bot — it would
 * permanently stop the bot from ever answering those messages. The badge would go quiet and
 * so would the bot.
 *
 * The badge is still worth clearing, because to the person looking it reads as their own
 * unread. So "seen" is tracked here, on the owner's device, and nothing is sent anywhere.
 *
 * The value is the timestamp of the newest message at the moment it was opened, not a
 * boolean: when the peer writes again the stored value falls behind and the badge comes
 * back, which is what anyone would expect and what a boolean could not do.
 */
const seenKey = (botId) => `gossips:bot-dm-seen:${botId}`;

const readSeen = (botId) => {
  try {
    const raw = localStorage.getItem(seenKey(botId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Private mode, or a half-written value. Losing this means a badge stays up.
    return {};
  }
};

const writeSeen = (botId, value) => {
  try {
    localStorage.setItem(seenKey(botId), JSON.stringify(value));
  } catch {
    // Not fatal — it just won't survive the reload.
  }
};

const latestAt = (conversation) =>
  new Date(conversation?.latestMessage?.createdAt || conversation?.lastMessageTime || 0).getTime();

const BotChatProvider = ({ botId, children }) => {
  const [conversations, setConversations] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [listPageInfo, setListPageInfo] = useState(emptyPage);
  const [messages, setMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [currentConversation, setCurrentConversation] = useState(null);
  const [seen, setSeen] = useState(() => readSeen(botId));
  /*
   * Presence and read receipts arrive with the REST payloads rather than over a socket —
   * this screen has none. See `includePresence` in the chat controller.
   */
  const [onlineUsers, setOnlineUsers] = useState(() => new Set());
  const [userLastSeenMap, setUserLastSeenMap] = useState({});
  const [peerReadAt, setPeerReadAt] = useState({});

  useEffect(() => {
    setSeen(readSeen(botId));
  }, [botId]);

  /** Folds the presence a payload carried into the maps the DM screens read. */
  const absorbPresence = useCallback((peers) => {
    const withPresence = peers.filter((peer) => peer?._id && peer.lastSeen !== undefined);
    if (!withPresence.length) return;

    setOnlineUsers((current) => {
      const next = new Set(current);
      for (const peer of withPresence) {
        if (peer.isOnline) next.add(String(peer._id));
        else next.delete(String(peer._id));
      }
      return next;
    });
    setUserLastSeenMap((current) => {
      const next = { ...current };
      for (const peer of withPresence) next[String(peer._id)] = peer.lastSeen;
      return next;
    });
  }, []);

  const loadConversations = useCallback(
    async (params = {}) => {
      setListLoading(true);
      setListError(null);
      try {
        const response = await botAPI.getChats(botId, params);
        const chats = Array.isArray(response)
          ? response
          : response?.chats || response?.conversations || response?.items || [];
        setConversations(chats);
        setListPageInfo(response?.pageInfo || emptyPage);
        absorbPresence(chats.map((chat) => chat?.user).filter(Boolean));
        return response;
      } catch (error) {
        setListError("Could not load conversations.");
        throw error;
      } finally {
        setListLoading(false);
      }
    },
    [botId, absorbPresence]
  );

  const loadMessages = useCallback(
    async (username, cursor = null) => {
      setThreadLoading(true);
      try {
        const response = await botAPI.getConversation(botId, username, cursor ? { cursor } : {});
        const nextMessages = response?.messages || [];
        setMessages((current) => (cursor ? [...nextMessages, ...current] : nextMessages));
        setHasMoreMessages(Boolean(response?.hasMore || response?.pageInfo?.hasNextPage));

        if (response?.peer) absorbPresence([response.peer]);
        /*
         * Keyed by the conversation the server named. The thread reads
         * `peerReadAt[conversationKey]` to decide between "Delivered" and "Seen"; without
         * it every message the bot sent showed as Delivered for ever, even ones the person
         * had plainly replied to.
         */
        if (response?.conversation && response?.peerReadAt !== undefined) {
          setPeerReadAt((current) => ({
            ...current,
            [response.conversation]: response.peerReadAt,
          }));
        }
        return response;
      } finally {
        setThreadLoading(false);
      }
    },
    [botId, absorbPresence]
  );

  /*
   * Read through a ref so the callback below can be stable.
   *
   * It is called from the thread page's `initChat` effect, whose dependency list also
   * triggers the fetch — a callback that changed whenever `conversations` did would reload
   * the whole conversation every time the list refreshed.
   */
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  /**
   * The owner opened this thread. Local only — see the note on `seenKey`.
   *
   * `at` is a *server* timestamp: the newest message in the thread that was just loaded.
   * The caller has to supply it, because the thread screen mounts its own provider (see
   * `BotConversationRoute`) and never loads the chat list — so looking it up from
   * `conversations` here would find nothing and silently fall back to the local clock.
   * That fallback compares a client reading against server `createdAt`s: a device running
   * slow would never clear the badge, and one running fast would swallow messages that
   * arrived inside the skew.
   *
   * @param {number} [at] epoch ms of the newest message; falls back to the list's own copy.
   */
  const markThreadSeenByOwner = useCallback(
    (chatId, at) => {
      if (!chatId) return;
      setSeen((current) => {
        const fromList = conversationsRef.current.find((chat) => chat.id === chatId);
        const mark = Number.isFinite(at) ? at : fromList ? latestAt(fromList) : null;
        // Nothing trustworthy to record. Better a badge that stays up than one that
        // clears against a clock the server never agreed to.
        if (mark === null) return current;
        if (current[chatId] === mark) return current;
        const next = { ...current, [chatId]: mark };
        writeSeen(botId, next);
        return next;
      });
    },
    [botId]
  );

  /*
   * Only threads the owner has caught up on get a key. An absent key is what makes
   * ChatPage's `unreadCounts[chat.id] ?? chat.unreadCount` fall through to the server's
   * count, so an unopened thread still shows the bot's real backlog.
   */
  const unreadCounts = useMemo(() => {
    const counts = {};
    for (const conversation of conversations) {
      const seenAt = seen[conversation.id];
      if (seenAt !== undefined && seenAt >= latestAt(conversation)) counts[conversation.id] = 0;
    }
    return counts;
  }, [conversations, seen]);

  const actions = useMemo(
    () => ({
      loadConversations,
      loadMoreConversations: async () => null,
      loadMessages,
      setCurrentConversation,
      loadPreferences: async () => null,
      hydrateThreadFromCache: async () => null,
      markThreadSeenByOwner,
      // All mutating normal-DM actions are intentionally inert in bot inspection mode.
      clearChatUnread: async () => null,
      markConversationUnread: async () => null,
      applyPreferences: async () => null,
      setChatState: async () => null,
      toggleFavoriteChat: async () => null,
      deleteChat: async () => false,
      sendMessage: async () => null,
      /*
       * Still inert, and this is the one that must stay that way. Writing the bot's read
       * watermark would take the conversation out of its perception and it would never
       * reply — `markThreadSeenByOwner` is the owner-side substitute.
       */
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
    }),
    [loadConversations, loadMessages, markThreadSeenByOwner]
  );

  const value = useMemo(
    () => ({
      conversations,
      listLoading,
      listLoadingMore: false,
      listError,
      listPageInfo,
      messages,
      threadLoading,
      hasMoreMessages,
      currentConversation,
      onlineUsers,
      unreadCounts,
      // Nobody is typing at a screen with no socket, and a stale indicator would be worse
      // than none.
      typingUsers: {},
      userLastSeenMap,
      peerReadAt,
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
    }),
    [
      actions,
      conversations,
      currentConversation,
      hasMoreMessages,
      listError,
      listLoading,
      listPageInfo,
      messages,
      onlineUsers,
      peerReadAt,
      threadLoading,
      unreadCounts,
      userLastSeenMap,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export default BotChatProvider;
