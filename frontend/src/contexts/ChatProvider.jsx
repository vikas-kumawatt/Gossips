// frontend/src/contexts/ChatProvider.jsx
import React, { useContext, useReducer, useEffect } from "react";
import { toast } from "react-hot-toast";
import { useSocket } from "./useSocket";
import { chatAPI } from "../services/api";
import { ChatContext } from "./ChatContext";
import { UserContext } from "./UserContext";
import {
  getCachedChatList,
  setCachedChatList,
  getCachedThread,
  setCachedThread,
  deleteCachedThread,
} from "../utils/chatCache";

/*
 * Which cached list a set of `GET /chats` params belongs to.
 *
 * The list is refetched per tab with server-side filters, so one cache entry per
 * account would have the Archived tab's rows warming the All tab. A search is
 * never cached: the results are transient and there is no tab to come back to.
 */
const listCacheKey = (params = {}) => {
  if (params.search) return null;
  const view = params.view || "all";
  const archived = params.archived === "true" ? "archived" : "active";
  return params.categoryId
    ? `${view}:${params.categoryId}:${archived}`
    : `${view}:${archived}`;
};

/*
 * Thread cache keys.
 *
 * A DM thread is addressed by username everywhere on the client — that is what the
 * route carries and what `getMessages` takes — so it is keyed by username here
 * too, lowercased because usernames are case-insensitive and `/Alice` and `/alice`
 * are one conversation. Groups are keyed by id.
 */
const dmThreadCacheKey = (username) => `dm:${String(username || "").toLowerCase()}`;
const groupThreadCacheKey = (groupId) => `group:${String(groupId || "")}`;

/*
 * What to show a user when a request fails.
 *
 * `error.message` on an axios rejection is "Request failed with status code
 * 404", and on a programming mistake it is whatever the exception said —
 * "chatAPI.deleteMessageForMe is not a function" was on screen in a toast.
 * The server's own message is the only one written for a person to read, so
 * prefer it and fall back to something plain.
 */
const readableError = (error, fallback = "Something went wrong. Try again.") =>
  error?.response?.data?.error || error?.response?.data?.message || fallback;

const initialState = {
  conversations: [],
  currentConversation: null, // Track currently active conversation ID (userId or groupId)
  messages: [],

  /*
   * Loading and error are per-surface, not global.
   *
   * There used to be one `loading` and one `error` shared by the chat list and
   * the open conversation, and on desktop `ChatLayout` renders both at once.
   * Opening a conversation therefore spun the chat list, and a rejected
   * *message send* painted a red error bar under the *list* — where nothing
   * ever cleared it, because the list had not done anything wrong.
   */
  listLoading: false,
  listError: null,

  /*
   * Whether `conversations` currently holds the unfiltered list.
   *
   * The chat list is re-fetched per tab with server-side filters, so
   * `conversations` is often a subset. A live message must not insert a row
   * into a filtered view it doesn't belong to — a DM arriving while you sit on
   * the Archived tab would otherwise appear there, since nothing filters
   * `archived` or `requests` again on the client.
   */
  listIsUnfiltered: true,

  /*
   * Where the chat list has read up to (CF23/CF24).
   *
   * `GET /chats` is cursored now — it used to return up to 500 conversations and
   * silently stop, so anyone past that simply could not reach their older chats. The
   * cursor is opaque and belongs to the current filter, so it is reset on every fresh
   * load rather than carried across tabs.
   *
   * `filteredAfterFetch` is the server admitting that this view (Requests, or a search)
   * filters the page after fetching it, so an empty page does not mean there are no more
   * matches — it means keep asking. Without it, "no results" and "nothing on this page"
   * look identical to the client.
   */
  listPageInfo: { hasNextPage: false, nextCursor: null, filteredAfterFetch: false },
  listLoadingMore: false,

  threadLoading: false,
  threadError: null,

  hasMoreMessages: false,
  typingUsers: {},
  onlineUsers: new Set(),
  userLastSeenMap: {},
  replyMessage: null,

  /*
   * Unread, keyed by the chat list's id ("user_<id>" / "group_<id>").
   *
   * This existed before and nothing ever wrote to it — `getUnreadCount` was
   * never called and no reducer case touched it — so every badge read
   * `undefined`. Since ChatPage sits outside the router outlet and never
   * unmounts, that meant a new message bumped nothing and opening a chat
   * cleared nothing.
   */
  unreadCounts: {},

  // How far the other side has read, keyed by conversation. Drives "Seen".
  peerReadAt: {},

  /*
   * Chat preferences, owned here (#96).
   *
   * Three components each fetched and held their own copy — ChatPage, the details
   * page and the conversation page — with a 60-second cache underneath. So muting a
   * chat from its details page changed that page's state and nothing else: the list
   * still showed it unmuted, and going back inside the cache window re-read the old
   * value from IndexedDB. Every preference is per account and read by all three, so
   * there is one copy and one loader.
   *
   * `loaded` distinguishes "no preferences" from "not fetched yet" — the difference
   * between rendering a chat as unlocked and not knowing whether it is.
   */
  preferences: {
    loaded: false,
    categories: [],
    categoryAssignments: {},
    favoriteChats: [],
    pinnedChats: [],
    mutedChats: [],
    lockedChats: [],
    hasLockPin: false,
    theme: "system",
    themeByChat: {},
    disappearingByChat: [],
  },
};

/**
 * Merge a preferences payload, keeping any key the response didn't mention.
 *
 * The mutation endpoints answer with different subsets — `updateChatState` returns
 * every list, `updateChatTheme` returns only the themes — so a replace would blank
 * whatever the particular endpoint happened not to include.
 */
const mergePreferences = (current, incoming = {}) => {
  const next = { ...current, loaded: true };
  const arrays = [
    "categories",
    "favoriteChats",
    "pinnedChats",
    "mutedChats",
    "lockedChats",
    "disappearingByChat",
  ];
  for (const key of arrays) {
    if (Array.isArray(incoming[key])) next[key] = incoming[key];
  }
  for (const key of ["categoryAssignments", "themeByChat"]) {
    if (incoming[key] && typeof incoming[key] === "object") next[key] = incoming[key];
  }
  if (typeof incoming.hasLockPin === "boolean") next.hasLockPin = incoming.hasLockPin;
  if (typeof incoming.theme === "string") next.theme = incoming.theme;
  return next;
};

function chatReducer(state, action) {
  switch (action.type) {
    case "SET_PREFERENCES":
      return { ...state, preferences: mergePreferences(state.preferences, action.payload) };

    case "RESET_PREFERENCES":
      return { ...state, preferences: initialState.preferences };

    case "SET_LIST_LOADING":
      return { ...state, listLoading: action.payload };

    case "SET_LIST_ERROR":
      return { ...state, listError: action.payload, listLoading: false, listLoadingMore: false };

    case "SET_THREAD_LOADING":
      return { ...state, threadLoading: action.payload };

    case "SET_THREAD_ERROR":
      return { ...state, threadError: action.payload, threadLoading: false };

    case "SET_CONVERSATIONS": {
      /*
       * Appending a page deduplicates by id.
       *
       * Two pages can legitimately overlap: the cursor is a point in `lastMessageAt`, and
       * a conversation that receives a message between page one and page two moves *up*
       * past the cursor and would arrive twice. The later copy is the fresher one, so it
       * wins — and React needs the keys unique regardless.
       */
      const conversations = action.append
        ? [...new Map([...state.conversations, ...action.payload].map((c) => [c.id, c])).values()]
        : action.payload;

      return {
        ...state,
        conversations,
        // Seed from the server so the list and the badge can't disagree.
        // Merged, not replaced: a filtered view ("unread", "favorites") returns
        // a subset, and rebuilding from it would drop everything else.
        unreadCounts: {
          ...state.unreadCounts,
          ...Object.fromEntries(action.payload.map((c) => [c.id, c.unreadCount || 0])),
        },
        // `keepLoading` is the warm-start path: rows are on screen but the request
        // that will replace them is still in flight.
        listLoading: Boolean(action.keepLoading),
        listLoadingMore: false,
        listError: null,
        listIsUnfiltered: action.isUnfiltered !== false,
        listPageInfo: action.pageInfo ?? initialState.listPageInfo,
      };
    }

    /*
     * Drop one row from the list.
     *
     * Deleting a conversation had no reducer case at all, so the only way the row
     * could leave the screen was a full `loadConversations` refetch — which ChatPage
     * fired and UserConversationPage didn't, meaning deleting from inside a thread
     * navigated back to a list that still showed it. With a warm-start cache in front
     * of that list the stale row could also be re-rendered from IndexedDB after the
     * refetch, so "delete" appeared to do nothing at all.
     *
     * `unreadCounts` is cleared alongside it, or the badge would keep counting for a
     * conversation with no row to sit on.
     */
    case "REMOVE_CONVERSATION": {
      const id = action.payload;
      if (!id) return state;
      const { [id]: _dropped, ...unreadCounts } = state.unreadCounts;
      return {
        ...state,
        conversations: state.conversations.filter((c) => c.id !== id),
        unreadCounts,
      };
    }

    /*
     * Put a removed row back, at its original position, when the delete failed.
     * Appending would silently reorder the list, and the list is sorted by recency.
     */
    case "RESTORE_CONVERSATION": {
      const { conversation, index } = action.payload || {};
      if (!conversation?.id) return state;
      if (state.conversations.some((c) => c.id === conversation.id)) return state;
      const next = [...state.conversations];
      next.splice(Math.max(0, Math.min(index ?? next.length, next.length)), 0, conversation);
      return { ...state, conversations: next };
    }

    case "SET_LIST_LOADING_MORE":
      return { ...state, listLoadingMore: action.payload };

    // Merge for a partial update; replace for the periodic full refresh. The
    // endpoint omits conversations with nothing unread, so merging a full
    // refresh would leave a stale badge on anything read from another device.
    case "SET_UNREAD_COUNTS":
      return {
        ...state,
        unreadCounts: action.payload.replace
          ? action.payload.counts
          : { ...state.unreadCounts, ...action.payload.counts },
      };

    case "BUMP_UNREAD":
      return {
        ...state,
        unreadCounts: {
          ...state.unreadCounts,
          [action.payload.conversationId]:
            (state.unreadCounts[action.payload.conversationId] || 0) + 1,
        },
      };

    case "CLEAR_UNREAD":
      return {
        ...state,
        unreadCounts: { ...state.unreadCounts, [action.payload.conversationId]: 0 },
      };

    case "SET_PEER_READ_AT":
      return {
        ...state,
        peerReadAt: { ...state.peerReadAt, [action.payload.conversation]: action.payload.readAt },
      };

    case "SET_CURRENT_CONVERSATION": {
      // Opening a conversation clears its badge. This used to be persisted
      // server-side as a "forced read" flag that could never be undone, so a
      // chat you had opened once could never show unread again.
      // `currentConversation` is a raw user/group id (ADD_MESSAGE_IF_ACTIVE
       // compares it against message.sender._id), while the badge map is keyed
       // "user_<id>" / "group_<id>". Clear both spellings — only one exists.
      const unreadCounts = { ...state.unreadCounts };
      if (action.payload) {
        unreadCounts[`user_${action.payload}`] = 0;
        unreadCounts[`group_${action.payload}`] = 0;
      }
      return {
        ...state,
        currentConversation: action.payload,
        unreadCounts,
        /*
         * Clearing is the default: switching chats must not flash the previous
         * thread's messages. `keepMessages` is for the one caller that learns
         * the peer's id only *after* loading the thread — when the profile
         * endpoint 404s because that person blocked you — where clearing would
         * throw away the messages it just fetched.
         *
         * Re-selecting the conversation already open also keeps them. That isn't
         * a switch, so there is no previous thread to avoid flashing — and the
         * warm-start path depends on it: the cache sets the conversation and its
         * messages before the profile request resolves, and initChat then sets
         * the same id again from the response. Clearing there would throw away
         * the cached thread a moment after painting it.
         */
        messages:
          action.keepMessages ||
          (action.payload && action.payload === state.currentConversation)
            ? state.messages
            : [],
        replyMessage: null,
      };
    }

    case "SET_MESSAGES": {
      if (!action.payload.isPagination) {
        return {
          ...state,
          messages: action.payload.messages,
          hasMoreMessages: action.payload.hasMore,
          threadLoading: false,
          threadError: null,
        };
      }

      /*
       * Prepending an older page, deduplicated by _id.
       *
       * This used to concatenate blindly. Two observer callbacks firing in the
       * same tick request the same cursor, and the same fifty messages land
       * twice — duplicate React keys inside a group, and the same bubble drawn
       * twice. The ref guard in loadMoreMessages closes that race; this is the
       * backstop for any other route to a repeated page, including a retry.
       */
      const existing = new Set(state.messages.map((m) => m._id));
      const older = action.payload.messages.filter((m) => !existing.has(m._id));

      return {
        ...state,
        messages: older.length ? [...older, ...state.messages] : state.messages,
        hasMoreMessages: action.payload.hasMore,
        threadLoading: false,
        threadError: null,
      };
    }

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
          /*
           * `messageStatus` is dropped, not merged.
           *
           * The optimistic row carries `messageStatus: "sending"` and the server
           * echo has no such field — it has the real `status` — so a plain merge
           * left "sending" on the row forever. The bubble's indicator returns null
           * for "sending", so every message sent in the current session showed no
           * tick at all, permanently, and reappeared correctly only after a reload.
           */
          const { messageStatus: _sending, failedReason: _reason, ...settled } =
            newMessages[tempIndex];
          newMessages[tempIndex] = { ...settled, ...message };
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

    /*
     * `reactionSummary`, not `reactions`.
     *
     * `Message.reactions` was a Map the schema rewrite replaced with the
     * MessageReaction collection plus a cached top-three summary, and the
     * `messageReaction` event has always carried `reactionSummary`. This reducer
     * wrote `data.reactions` — permanently undefined — onto a field the bubble also
     * read, so reactions have never rendered at either end of the round trip.
     */
    case "ADD_REACTION":
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg._id === action.payload.messageId
            ? { ...msg, reactionSummary: action.payload.reactionSummary }
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

    case "UPDATE_CONVERSATION_LAST_MESSAGE": {
      const { conversationId, message, peer, isGroup } = action.payload;
      const known = state.conversations.some((conv) => conv.id === conversationId);

      if (known) {
        return {
          ...state,
          conversations: state.conversations.map((conv) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  // A locked chat keeps its preview withheld. The server strips
                  // latestMessage out of the chat list for locked conversations,
                  // but the live socket echo would have written the plaintext
                  // straight back over it on the next message.
                  latestMessage: conv.isLocked ? null : message,
                  lastMessageTime: message?.createdAt,
                }
              : conv
          ),
        };
      }

      /*
       * A conversation that isn't in the list yet.
       *
       * This used to be a plain `.map()`, so a message from someone you had
       * never spoken to updated nothing: the very first DM anyone sent you
       * produced no row at all until a manual refresh, which is the worst
       * possible message to drop. `ADD_CONVERSATION` existed for this and was
       * never dispatched from anywhere.
       *
       * The row is built from what the message carries. It's thinner than a
       * row from `GET /chats` — no relationship flags, no category — and the
       * next full load replaces it with the real thing. Getting the person's
       * name and their message on screen immediately is the point.
       *
       * Only into the unfiltered list: inserting into "Archived" or
       * "Requests" would put the row in a view the server had deliberately
       * excluded it from, and it would vanish again on the next tab switch.
       */
      if (!peer || !state.listIsUnfiltered) return state;

      const newRow = {
        id: conversationId,
        isGroup: Boolean(isGroup),
        latestMessage: message,
        conversation: message?.conversation ?? null,
        unreadCount: 0,
        lastMessageTime: message?.createdAt,
        ...(isGroup ? { group: peer } : { user: peer }),
        relationship: { isFollowing: false, isFollower: false },
        isBlocked: false,
        blockedByThem: false,
        isArchived: false,
        isFavorite: false,
        isPinned: false,
        isMuted: false,
        isLocked: false,
        categoryId: null,
      };

      return { ...state, conversations: [newRow, ...state.conversations] };
    }

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
  const { socket, isConnected, connectionEpoch } = useSocket();
  const { userAuth } = useContext(UserContext);

  /*
   * Drop the previous account's preferences when the account changes.
   *
   * A switch is a hard navigation, so the provider is rebuilt and there is nothing to
   * clear — but a *sign-out* isn't: `setUserAuth({token: null})` leaves this provider
   * mounted with the signed-out account's mute, lock and category lists still in
   * memory, ready to render for whoever signs in next on the same machine.
   */
  const accountRef = React.useRef(null);
  useEffect(() => {
    const id = userAuth?.token ? userAuth?.id || userAuth?._id || null : null;
    if (accountRef.current !== null && accountRef.current !== id) {
      dispatch({ type: "RESET_PREFERENCES" });
    }
    accountRef.current = id;
  }, [userAuth?.token, userAuth?.id, userAuth?._id]);

  /*
   * The socket, held in a ref as well as in state.
   *
   * `actions` below is memoised, and it used to depend on `socket` — which is
   * null on the first render and arrives one render later. So every action
   * identity changed once, shortly after mount, and every effect that depended
   * on one re-ran. In the conversation pages that meant initChat firing twice:
   * two profile fetches, two message fetches, and a cleanup in between that
   * called setCurrentConversation(null) and emptied the message list that had
   * just loaded.
   *
   * Reading the socket through a ref lets `actions` be built once and stay
   * stable for the provider's lifetime, so a component can safely put an action
   * in a dependency array. Written during render rather than in an effect
   * because an action may be called before effects have run.
   */
  const socketRef = React.useRef(socket);
  socketRef.current = socket;

  /*
   * The current state, for actions that have to read it.
   *
   * Same reason as `socketRef`: `actions` is memoised once with `[]` so its identities
   * stay stable, which means it closes over the *first* `state`. `loadMoreConversations`
   * needs the live cursor and the live in-flight flag, and a stale cursor re-requests the
   * page the list already has. Written during render, not in an effect, because an action
   * can be called before effects have run.
   */
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const currentConversationRef = React.useRef(state.currentConversation);

  useEffect(() => {
    currentConversationRef.current = state.currentConversation;
  }, [state.currentConversation]);

  /*
   * `loadConversations` reached through a ref.
   *
   * The socket effect below needs it, but `actions` is built once and lives
   * further down the component — and putting it in that effect's dependency
   * array is what caused the double-init bug this provider was rewritten to
   * fix. A ref keeps the effect's dependencies at [socket, isConnected].
   */
  const loadConversationsRef = React.useRef(null);

  /*
   * The params the list was last loaded with.
   *
   * Every background refetch — a reconnect, a group membership change — has to use
   * them, or it replaces a filtered view with the unfiltered one while the tab still
   * says "Archived". Held in a ref rather than state because only refetches read it and
   * a re-render on every load would be pointless churn.
   */
  const lastListParamsRef = React.useRef({});

  /*
   * The viewer's id, for scoping cache keys.
   *
   * Written during render for the same reason as socketRef: `actions` is built once
   * with `[]` deps, so it can't close over `userAuth`. Every cached record is keyed
   * by account — two people using one browser must not warm-start into each
   * other's threads.
   */
  const viewerIdRef = React.useRef(null);
  viewerIdRef.current = userAuth?.token ? userAuth?.id || userAuth?._id || null : null;

  /*
   * Which thread the cache-persisting effect below should write to, and which
   * cached list the same applies to.
   *
   * Set by whichever loader ran last rather than derived from
   * `state.currentConversation`, because that holds a bare user/group id and
   * nothing on it says which of the two it is.
   */
  const activeThreadCacheKeyRef = React.useRef(null);
  const listCacheKeyRef = React.useRef(null);

  // Socket event handlers
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleNewMessage = (message) => {
      dispatch({
        type: "ADD_MESSAGE_IF_ACTIVE",
        payload: { message },
      });

      // Compute the conversation ID used in the chats list, and the peer the
      // row is titled with — needed in case this conversation isn't in the
      // list yet, which is the case for a first-ever message from someone.
      let conversationId;
      let peer;
      const isGroup = Boolean(message.isGroupMessage);

      if (isGroup) {
        const groupId = message.group?._id || message.group;
        conversationId = `group_${groupId}`;
        peer = typeof message.group === "object" ? message.group : null;
      } else {
        const senderId = message.sender?._id?.toString?.() || message.sender?.toString?.();
        const receiverId = message.receiver?._id?.toString?.() || message.receiver?.toString?.();
        // The "other" person is whoever is not us (isOwn means we sent it)
        const otherId = message.isOwn ? receiverId : senderId;
        conversationId = `user_${otherId}`;
        const otherSide = message.isOwn ? message.receiver : message.sender;
        peer = typeof otherSide === "object" ? otherSide : null;
      }

      if (conversationId) {
        dispatch({
          type: "UPDATE_CONVERSATION_LAST_MESSAGE",
          payload: { conversationId, message, peer, isGroup },
        });

        // Someone else's message, for a conversation that isn't open: bump the
        // badge. The open one is being read, so it stays at zero.
        //
        // currentConversation holds a raw id, conversationId is the chat-list
        // id — comparing them directly never matched, so the open thread got
        // bumped too.
        const openRawId = currentConversationRef.current;
        const isOpen = openRawId && conversationId.endsWith(`_${openRawId}`);
        if (!message.isOwn && !isOpen) {
          dispatch({ type: "BUMP_UNREAD", payload: { conversationId } });
        }
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
          /*
           * Everything else that carries content, to match what the server
           * clears on unsend. Without these a shared post kept its card and a
           * poll kept its question and tally on screen under the tombstone
           * until the next reload, and the stale reaction pills stayed
           * clickable on a message that no longer exists.
           */
          poll: null,
          sharedContent: null,
          reactionSummary: { total: 0, top: [] },
        },
      });
    };

    const handleMessageReaction = (data) => {
      dispatch({
        type: "ADD_REACTION",
        payload: {
          messageId: data.messageId,
          // The field the server actually sends — see the reducer.
          reactionSummary: data.reactionSummary,
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

    /*
     * The server rejects sends for blocks, privacy and feature flags by emitting
     * "error". Nothing listened for it, so a rejected message sat at "sending"
     * forever with no explanation.
     *
     * The send handlers also answer their ack callback now, and the sender is
     * awaiting that — so a refusal carrying a `tempId` is reported by whoever is
     * waiting, with the server's own wording. Toasting here as well would be two
     * toasts for one failure, which is the shape of audit #111. An error with no
     * `tempId` has nobody waiting on it, so it is toasted here.
     */
    const handleSendError = (payload) => {
      const message = payload?.message || "Message couldn't be sent";
      if (payload?.tempId) {
        dispatch({
          type: "UPDATE_MESSAGE",
          payload: { _id: payload.tempId, messageStatus: "failed", failedReason: message },
        });
        return;
      }
      // Never the global error field: that rendered as a permanent red bar under
      // the chat list for a failure belonging to one message bubble.
      toast.error(message);
    };

    /*
     * The other side read the thread. The server has always emitted this and
     * nothing listened, which is why "Seen" never appeared — the bubble tested
     * `message.isRead`, a field that doesn't exist on the schema.
     *
     * A watermark rather than per-message flags: everything the peer sent
     * before `readAt` is seen.
     */
    const handleConversationRead = ({ conversation, readAt }) => {
      if (!conversation || !readAt) return;
      dispatch({ type: "SET_PEER_READ_AT", payload: { conversation, readAt } });
    };

    // Our own read, landing from another tab or device. The server sends the
    // chat-list id alongside the conversation key so the two namespaces don't
    // have to be translated in two places.
    const handleSelfRead = ({ chatId }) => {
      if (!chatId) return;
      dispatch({ type: "CLEAR_UNREAD", payload: { conversationId: chatId } });
    };

    /*
     * The presence snapshot the server now sends on connect.
     *
     * `SET_ONLINE_USERS` existed in the reducer and was never dispatched from
     * anywhere, and the server only emitted `userStatus` on a *transition* — so
     * on page load every dot in the chat list was grey until somebody happened
     * to come online or go offline while you watched.
     */
    const handlePresenceSnapshot = ({ online }) => {
      if (!Array.isArray(online)) return;
      dispatch({ type: "SET_ONLINE_USERS", payload: online });
    };

    /*
     * Group membership changed under us.
     *
     * The management endpoints emit `groupUpdated`, `groupMembersAdded`,
     * `groupMemberRemoved`, `groupMemberUpdated` and `removedFromGroup`, and
     * nothing listened for any of them — so a rename or a removal was
     * invisible until a manual refetch. The list is the thing that has to be
     * right; the info page refetches on mount and owns its own state.
     */
    // Same params, same reason as the reconnect refetch below.
    const handleGroupChanged = () =>
      loadConversationsRef.current?.(lastListParamsRef.current);

    const handleRemovedFromGroup = ({ groupName }) => {
      toast(`You were removed from ${groupName || "a group"}`);
      loadConversationsRef.current?.(lastListParamsRef.current);
    };

    socket.on("groupUpdated", handleGroupChanged);
    socket.on("groupCreated", handleGroupChanged);
    socket.on("groupMembersAdded", handleGroupChanged);
    socket.on("groupMemberRemoved", handleGroupChanged);
    socket.on("removedFromGroup", handleRemovedFromGroup);
    socket.on("presenceSnapshot", handlePresenceSnapshot);
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
    socket.on("conversationRead", handleConversationRead);
    socket.on("conversationReadSelf", handleSelfRead);

    return () => {
      socket.off("groupUpdated", handleGroupChanged);
      socket.off("groupCreated", handleGroupChanged);
      socket.off("groupMembersAdded", handleGroupChanged);
      socket.off("groupMemberRemoved", handleGroupChanged);
      socket.off("removedFromGroup", handleRemovedFromGroup);
      socket.off("presenceSnapshot", handlePresenceSnapshot);
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
      socket.off("conversationRead", handleConversationRead);
      socket.off("conversationReadSelf", handleSelfRead);
    };
  }, [socket, isConnected]);

  /*
   * Refetch the chat list on every *re*connect (#92).
   *
   * Only the unread counts refetched. Everything else that arrived while the socket
   * was down produced no `receiveMessage`, so the list's previews, ordering and any
   * new conversation were stale by the length of the outage with nothing to correct
   * them — the app looked connected and quietly wasn't current.
   *
   * `connectionEpoch > 1` skips the first connect, where the initial load has already
   * happened or is in flight. The open thread refetches separately: only the
   * conversation page knows which one is open and what its cursor is.
   */
  const reconnectedRef = React.useRef(0);
  useEffect(() => {
    if (!isConnected || connectionEpoch <= 1) return;
    if (reconnectedRef.current === connectionEpoch) return;
    reconnectedRef.current = connectionEpoch;
    /*
     * Refetched with the params the list is *currently* showing.
     *
     * Calling `loadConversations()` bare sends no `view` and no `archived`, so the
     * server answers with everything — which replaces a filtered list with the
     * unfiltered one while the tab stays highlighted. Sitting on Archived when the
     * socket reconnected produced a list containing every chat, and `ChatPage`'s own
     * loader couldn't correct it because `activeFilter` hadn't changed.
     *
     * Not outage-only either: `SocketProvider` rebuilds its socket when the token
     * changes, so an ordinary token refresh reaches epoch 2 and fired the same wipe.
     */
    loadConversationsRef.current?.(lastListParamsRef.current).catch(() => {});
  }, [isConnected, connectionEpoch]);

  /*
   * Pull unread counts on connect, and again on every reconnect.
   *
   * The reconnect case is the point: messages that arrived while the socket was
   * down produced no `receiveMessage`, so the badges are stale by exactly the
   * length of the outage and nothing else would ever correct them.
   */
  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    chatAPI
      .getUnreadCount()
      .then(({ byChatId = {} }) => {
        if (!cancelled) {
          dispatch({ type: "SET_UNREAD_COUNTS", payload: { counts: byChatId, replace: true } });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isConnected]);

  /**
   * Emit and wait for the server's answer.
   *
   * The send handlers used to be emit-and-hope: no acknowledgement, so a client
   * couldn't tell a refused send from a slow one and the optimistic bubble sat at
   * "sending" forever. They take a callback now and answer `{ok}` either way, so a
   * rejection here is a real rejection and the caller's catch can mark the bubble
   * failed.
   *
   * The timeout matters as much as the ack: without one, a send during a dropped
   * connection buffers in socket.io and the promise never settles at all.
   *
   * `socketRef`, not `socket`, so this doesn't have to be a dependency of the
   * memo below — see the note on socketRef for why `actions` is built once.
   */
  const emitWithAck = React.useCallback(async (event, payload, timeoutMs = 15000) => {
    const active = socketRef.current;
    if (!active) throw new Error("You're offline — this will send when you reconnect");

    const markFailed = (reason) => {
      if (payload?.tempId) {
        dispatch({
          type: "UPDATE_MESSAGE",
          payload: { _id: payload.tempId, messageStatus: "failed", failedReason: reason },
        });
      }
    };

    let reply;
    try {
      reply = await active.timeout(timeoutMs).emitWithAck(event, payload);
    } catch {
      /*
       * A timeout, which is the case nothing else covers.
       *
       * `socketRef.current` being truthy does not mean connected — SocketContext
       * disconnects without nulling the socket — so an emit during a token change
       * is buffered by socket.io and simply never answered (CF18). Without a
       * timeout the promise never settles and the bubble sits at "sending" for the
       * rest of the session.
       */
      const reason = "Still trying to send — check your connection";
      markFailed(reason);
      throw new Error(reason);
    }

    if (reply && reply.ok === false) {
      const reason = reply.error || "That didn't go through";
      markFailed(reason);
      throw new Error(reason);
    }
    return reply;
  }, []);

  const actions = React.useMemo(
    () => ({
      /*
       * The chat list, from cache immediately and from the network always.
       *
       * The list used to open on a spinner every time, including when the rows were
       * unchanged from a moment ago — `GET /chats` is `no-store` and excluded from
       * the axios cache, correctly, so there was nothing to render until it
       * answered. This paints the last known rows first and then replaces them with
       * the response. The request is started *before* the cache is read so a slow
       * IndexedDB open can never delay the network, and the cached rows are dropped
       * if the response has already landed — repainting stale rows over fresh ones
       * would be a visible step backwards.
       */
      loadConversations: async (params = {}) => {
        // Without the cursor: this is always the first page. A caller passing one would
        // make the "fresh load" path silently continue an older query.
        const { cursor: _ignored, ...firstPage } = params;
        lastListParamsRef.current = firstPage;
        // A view or a search means this is a subset of the user's chats.
        const isUnfiltered =
          !firstPage.search && (!firstPage.view || firstPage.view === "all");

        const viewerId = viewerIdRef.current;
        const cacheKey = listCacheKey(firstPage);
        listCacheKeyRef.current = cacheKey;

        dispatch({ type: "SET_LIST_LOADING", payload: true });

        const request = chatAPI.getConversations(firstPage);
        let settled = false;
        // Attached before the await below so the flag is set the moment the
        // response arrives, whichever of the two finishes first.
        request.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );

        if (viewerId && cacheKey) {
          try {
            const cached = await getCachedChatList(viewerId, cacheKey);
            if (cached?.chats?.length && !settled) {
              dispatch({
                type: "SET_CONVERSATIONS",
                payload: cached.chats,
                pageInfo: cached.pageInfo,
                isUnfiltered,
                // The request is still out; the list must keep saying so, or the
                // spinner and the sentinel both read as "finished".
                keepLoading: true,
              });
            }
          } catch (error) {
            console.error("Failed to hydrate cached chat list:", error);
          }
        }

        try {
          const response = await request;
          dispatch({
            type: "SET_CONVERSATIONS",
            payload: response.chats,
            pageInfo: response.pageInfo,
            isUnfiltered,
          });
          if (viewerId && cacheKey) {
            setCachedChatList(viewerId, cacheKey, {
              chats: response.chats,
              pageInfo: response.pageInfo,
            }).catch((error) => {
              console.error("Failed to cache chat list:", error);
            });
          }
        } catch (error) {
          dispatch({ type: "SET_LIST_ERROR", payload: readableError(error) });
        }
      },

      /**
       * The next page of the *current* list (CF23/CF24).
       *
       * Reads its parameters from `lastListParamsRef` rather than taking them, for the
       * same reason the reconnect refetch does: a caller that reconstructs them is a
       * caller that can get them wrong, and asking for page two of a different filter
       * than page one returns rows that don't belong in the list.
       *
       * Guarded against re-entry — an infinite-scroll sentinel fires repeatedly while it
       * is still in view, and without the guard each firing starts another request from
       * the same cursor and appends the same page again.
       */
      loadMoreConversations: async () => {
        const { hasNextPage, nextCursor } = stateRef.current.listPageInfo;
        if (!hasNextPage || !nextCursor) return;
        if (stateRef.current.listLoadingMore) return;

        try {
          dispatch({ type: "SET_LIST_LOADING_MORE", payload: true });
          const params = { ...lastListParamsRef.current, cursor: nextCursor };
          const response = await chatAPI.getConversations(params);
          const isUnfiltered =
            !params.search && (!params.view || params.view === "all");
          dispatch({
            type: "SET_CONVERSATIONS",
            payload: response.chats,
            pageInfo: response.pageInfo,
            isUnfiltered,
            append: true,
          });
        } catch (error) {
          // Not `SET_LIST_ERROR`: the list on screen is fine, only the next page failed.
          // Painting a red bar over a working list is worse than the sentinel simply
          // retrying when it next scrolls into view.
          console.error("Failed to load more conversations:", error);
          dispatch({ type: "SET_LIST_LOADING_MORE", payload: false });
        }
      },

      /*
       * Load the account's chat preferences into the one place that holds them.
       *
       * `bypassCache` by default: this is called after every preference mutation to
       * pick up the server's canonical lists, and the 60-second IndexedDB entry would
       * hand back the state from before the change. The cached form is still there
       * for the theme read on the conversation page, which is the one place where a
       * slightly stale value is harmless and the request is on a hot path.
       */
      /**
       * Forget the current account's preferences.
       *
       * Called on an account switch. Without it there is a window between the switch
       * and the refetch in which the *previous* account's mute, pin, lock and category
       * lists are still what the list renders — so a chat locked by the account you
       * just left briefly shows as locked in the one you switched to, keyed by an id
       * that means something different now.
       */
      resetPreferences: () => dispatch({ type: "RESET_PREFERENCES" }),

      loadPreferences: async ({ bypassCache = true } = {}) => {
        try {
          const data = await chatAPI.getPreferences({ bypassCache });
          dispatch({ type: "SET_PREFERENCES", payload: data || {} });
          return data;
        } catch (error) {
          // Preferences are decoration on top of a working chat list — a failure
          // here must not take the list down with it.
          console.error("Failed to load chat preferences:", error);
          return null;
        }
      },

      /**
       * Apply a mutation response without a round trip.
       *
       * Every preference endpoint answers with the lists it changed, so the state can
       * move immediately rather than after a refetch — which is what made the
       * details page and the list disagree, since only the page that acted knew.
       */
      applyPreferences: (payload) => {
        if (payload) dispatch({ type: "SET_PREFERENCES", payload });
      },

      /**
       * Star or unstar a conversation (CF37).
       *
       * Here rather than at each call site because there are two — the chat list and the
       * post card's author menu — and the second one used to keep its own module-level
       * `Set` of favourite chat ids, with its own fetch, its own epoch counter to stop a
       * late GET clobbering a toggle, and its own copy of the cache patch below. Two
       * copies of one list is one that goes stale: favouriting from the feed left the chat
       * list showing an empty star for the rest of the session, and vice versa.
       *
       * The IndexedDB patch is not decoration. `ConversationDetailsPage` and
       * `UserConversationPage` both call `loadPreferences({bypassCache: false})` on mount,
       * so the 60-second cached entry written *before* this toggle would be read back over
       * the state and silently undo it. Patching the entry keeps the cache agreeing with
       * the state it will later be used to rebuild.
       *
       * @returns the endpoint's response, or null if it failed — callers that need to know
       *   whether it stuck (to revert an optimistic star) should check.
       */
      toggleFavoriteChat: async (chatId) => {
        /*
         * Optimistic, because the star is a one-tap toggle and a round trip is long
         * enough to read as "the tap didn't register" — the previous version left the
         * icon and the menu label on the old value until the response landed, then
         * flipped both, which is why it looked like a stale cache.
         *
         * The list is recomputed from `preferences.favoriteChats`, so writing the
         * predicted array is enough to move every surface at once; the response then
         * replaces it with the server's own, which is authoritative and may differ if
         * another device toggled the same chat.
         */
        const previous = Array.isArray(stateRef.current.preferences.favoriteChats)
          ? stateRef.current.preferences.favoriteChats
          : [];
        const optimistic = previous.includes(chatId)
          ? previous.filter((id) => id !== chatId)
          : [...previous, chatId];

        dispatch({ type: "SET_PREFERENCES", payload: { favoriteChats: optimistic } });
        // Patched now rather than only on success: a page mounting in the next 60s
        // reads the cached preferences, and an unpatched entry would undo the toggle
        // on screen before the request had even answered.
        chatAPI.patchCachedPreferencesFavorites(optimistic).catch(() => {});

        try {
          const data = await chatAPI.toggleFavoriteChat(encodeURIComponent(chatId));
          dispatch({ type: "SET_PREFERENCES", payload: data });
          if (Array.isArray(data?.favoriteChats)) {
            chatAPI.patchCachedPreferencesFavorites(data.favoriteChats).catch(() => {});
          }
          return data;
        } catch (error) {
          console.error("Failed to toggle favorite chat:", error);
          dispatch({ type: "SET_PREFERENCES", payload: { favoriteChats: previous } });
          chatAPI.patchCachedPreferencesFavorites(previous).catch(() => {});
          toast.error(readableError(error, "Couldn't update favorites."));
          return null;
        }
      },

      /**
       * Delete a DM for this account only, and take its row with it.
       *
       * Owned here rather than called straight off `chatAPI` by two pages, because the
       * row lives in this reducer and only this reducer can remove it. Both callers
       * previously hit the endpoint directly: ChatPage then refetched the whole list,
       * and UserConversationPage did nothing at all and navigated back to a list that
       * still listed the deleted chat.
       *
       * Optimistic, with the row and its index captured so a failure can put it back
       * exactly where it was. The cached snapshot is dropped too — leaving it would
       * let the next warm start paint the thread we just deleted.
       *
       * @param username The peer's handle; the endpoint is keyed by handle.
       * @param chatId   The list row id (`user_<peerId>`), when the caller knows it.
       */
      deleteChat: async (username, chatId = undefined) => {
        if (!username) return false;

        const id = chatId || null;
        const conversations = stateRef.current.conversations;
        const index = id ? conversations.findIndex((c) => c.id === id) : -1;
        const removed = index >= 0 ? conversations[index] : null;

        if (id) dispatch({ type: "REMOVE_CONVERSATION", payload: id });

        try {
          await chatAPI.deleteChat(username);
          if (viewerIdRef.current) {
            deleteCachedThread(viewerIdRef.current, dmThreadCacheKey(username)).catch(
              () => {}
            );
          }
          return true;
        } catch (error) {
          console.error("Failed to delete chat:", error);
          if (removed) {
            dispatch({
              type: "RESTORE_CONVERSATION",
              payload: { conversation: removed, index },
            });
          }
          toast.error(readableError(error, "Couldn't delete that conversation."));
          return false;
        }
      },

      setCurrentConversation: (id, { keepMessages = false } = {}) => {
        dispatch({ type: "SET_CURRENT_CONVERSATION", payload: id, keepMessages });
      },

      /**
       * @param conversationId  the peer's *username* — the endpoint resolves it.
       * @param chatId  `user_<peerId>`, when the caller knows it. Only used to
       *   attach a chat-lock unlock grant: the thread endpoint answers 423 for a
       *   locked conversation, and the grant is signed per conversation, so it
       *   can't be attached by an interceptor that only sees the username.
       */
      loadMessages: async (conversationId, cursor = null, chatId = undefined) => {
        const threadKey = dmThreadCacheKey(conversationId);
        if (!cursor) activeThreadCacheKeyRef.current = threadKey;
        try {
          dispatch({ type: "SET_THREAD_LOADING", payload: true });
          const response = await chatAPI.getMessages(
            conversationId,
            { cursor },
            chatId
          );

          dispatch({
            type: "SET_MESSAGES",
            payload: {
              messages: response.messages,
              hasMore: response.pageInfo?.hasNextPage ?? response.hasMore,
              isPagination: !!cursor,
            },
          });

          /*
           * Written on the first page only, and written even when it is empty —
           * an emptied thread has to overwrite its snapshot or the cache would
           * keep warm-starting into messages the server no longer has. Older
           * pages are left out on purpose: the cap keeps the newest tail, and
           * writing a prepended page would just churn the same records.
           */
          if (!cursor && viewerIdRef.current) {
            setCachedThread(viewerIdRef.current, threadKey, {
              messages: response.messages,
              hasMore: response.pageInfo?.hasNextPage ?? response.hasMore,
              // Read from state rather than the response: initChat sets the
              // conversation before calling this, and `response.conversation` is a
              // conversation key, not the peer's user id.
              peerId: stateRef.current.currentConversation,
              /*
               * The thread response already carries everything the conversation
               * header draws — id, username, name, avatar, verified — and it was
               * being thrown away. Storing it is what lets the header render on the
               * next open without waiting for `getProfile`.
               */
              peer: response.peer || undefined,
            }).catch((error) => {
              console.error("Failed to cache thread:", error);
            });
          }

          // How far they've read, so Seen is right on a cold load and not only
          // after a live conversationRead event arrives.
          if (response.conversation && response.peerReadAt) {
            dispatch({
              type: "SET_PEER_READ_AT",
              payload: { conversation: response.conversation, readAt: response.peerReadAt },
            });
          }
          return response;
        } catch (error) {
          // Rethrown without recording an error: the caller's own catch reports
          // it, and doing both produced two toasts for one failure.
          dispatch({ type: "SET_THREAD_LOADING", payload: false });
          throw error;
        }
      },

      loadGroupMessages: async (groupId, cursor = null) => {
        const threadKey = groupThreadCacheKey(groupId);
        if (!cursor) activeThreadCacheKeyRef.current = threadKey;
        try {
          dispatch({ type: "SET_THREAD_LOADING", payload: true });
          const response = await chatAPI.getGroupMessages(groupId, { cursor });

          dispatch({
            type: "SET_MESSAGES",
            payload: {
              messages: response.messages,
              hasMore: response.pageInfo?.hasNextPage ?? response.hasMore,
              isPagination: !!cursor,
            },
          });

          // First page only, same contract as the DM loader above.
          if (!cursor && viewerIdRef.current) {
            setCachedThread(viewerIdRef.current, threadKey, {
              messages: response.messages,
              hasMore: response.pageInfo?.hasNextPage ?? response.hasMore,
              peerId: groupId,
            }).catch((error) => {
              console.error("Failed to cache group thread:", error);
            });
          }
          return response;
        } catch (error) {
          // Same contract as loadMessages: the caller reports it.
          dispatch({ type: "SET_THREAD_LOADING", payload: false });
          throw error;
        }
      },

      /**
       * Paint a thread from its last snapshot, before the network is asked anything.
       *
       * Called at the very top of a conversation page's init, in parallel with the
       * profile/group request that init otherwise waits on — that request is
       * `bypassCache: true` by design, so without this the thread cannot render
       * until a full round trip completes, which is the "opens on a spinner every
       * time" the cache is here to remove.
       *
       * Declines to *paint messages* if the thread already has some: the network may
       * have won the race, and painting a snapshot over a fresh thread would be a
       * visible step backwards. The cached record is still returned in that case, so
       * the caller can seed its header regardless.
       *
       * @param {"dm"|"group"} kind
       * @param {string} identifier Username for a DM, group id for a group.
       * @returns {Promise<{messages: object[], peer: object|null, painted: boolean}|null>}
       *   The snapshot, or null when there wasn't one. `painted` says whether the
       *   message list was actually replaced.
       */
      hydrateThreadFromCache: async (kind, identifier) => {
        const viewerId = viewerIdRef.current;
        if (!viewerId || !identifier) return null;

        const threadKey =
          kind === "group" ? groupThreadCacheKey(identifier) : dmThreadCacheKey(identifier);

        try {
          const cached = await getCachedThread(viewerId, threadKey);
          if (!cached) return null;
          // Nothing to paint, but a cached peer is still worth handing back — the
          // header can use it even when the message tail is empty.
          if (!cached.messages?.length || stateRef.current.messages.length > 0) {
            return { ...cached, painted: false };
          }

          activeThreadCacheKeyRef.current = threadKey;

          /*
           * The conversation is marked active first, for two reasons: a live message
           * arriving during the warm window is only added to the open thread by
           * ADD_MESSAGE_IF_ACTIVE, and setting it here means init's own
           * `setCurrentConversation` with the same id is a no-op that leaves these
           * messages alone rather than clearing them.
           */
          if (cached.peerId) {
            dispatch({ type: "SET_CURRENT_CONVERSATION", payload: cached.peerId });
          }

          dispatch({
            type: "SET_MESSAGES",
            payload: {
              messages: cached.messages,
              hasMore: cached.hasMore,
              isPagination: false,
            },
          });
          return { ...cached, painted: true };
        } catch (error) {
          console.error("Failed to hydrate cached thread:", error);
          return null;
        }
      },

      sendMessage: async (messageData) => {
        if (!socketRef.current) throw new Error("Socket not connected");

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
        return emitWithAck("sendMessage", messageData);
      },

      sendGroupMessage: async (messageData) => {
        if (!socketRef.current) throw new Error("Socket not connected");

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
        return emitWithAck("sendGroupMessage", messageData);
      },

      startTyping: (receiverId) => {
        if (socketRef.current) {
          socketRef.current.emit("typing", { receiverId, isTyping: true });
        }
      },

      stopTyping: (receiverId) => {
        if (socketRef.current) {
          socketRef.current.emit("typing", { receiverId, isTyping: false });
        }
      },

      /*
       * The mutations below let their errors out.
       *
       * They used to catch, record the message in the shared error field, and
       * return normally — so every caller took the success path on a failure.
       * `GroupChatPage.handleEditMessage` cleared the composer and left edit
       * mode on a rejected edit, discarding what the user had typed with no way
       * to get it back. Unsend, delete and pin did the same quieter version:
       * the action appeared to work until the next reload.
       *
       * Rejecting is the only way a caller can tell. Each one has its own catch
       * that toasts and keeps the user's input.
       */
      reactToMessage: async (messageId, emoji) => {
        /*
         * The response's summary is applied directly.
         *
         * The reacting client's own bubble used to update only when the room
         * broadcast came back — and `io.to(room)` includes the sender, so it did
         * arrive, but the reducer was writing the wrong field so nothing rendered
         * either way. Applying the response makes the reactor's own tap immediate
         * and independent of the socket being up.
         */
        const data = await chatAPI.reactToMessage(messageId, { emoji });
        if (data?.reactionSummary) {
          dispatch({
            type: "ADD_REACTION",
            payload: { messageId, reactionSummary: data.reactionSummary },
          });
        }
      },

      editMessage: async (messageId, content) => {
        await chatAPI.editMessage(messageId, { content });
      },

      unsendMessage: async (messageId) => {
        await chatAPI.unsendMessage(messageId);
      },

      deleteMessageForMe: async (messageId) => {
        await chatAPI.deleteMessageForMe(messageId);
        dispatch({
          type: "DELETE_MESSAGE",
          payload: { messageId, deletedFor: "me" },
        });
      },

      // `pinned` is the target state, not a toggle — see chatAPI.pinMessage.
      pinMessage: async (messageId, pinned) => {
        await chatAPI.pinMessage(messageId, pinned);
      },

      /*
       * Voting goes over the socket, not HTTP.
       *
       * There is no vote route — the only vote handler in the app is
       * `socket.on("voteInPoll")`, and the result comes back to the whole room
       * as `pollUpdated`. The previous action called `chatAPI.voteInPoll`,
       * which didn't exist, against a route that didn't exist, and had no
       * callers; polls had no UI at all.
       *
       * `optionIds` is the reader's complete selection, not a delta: the server
       * clears their existing votes and re-applies this list on every call.
       */
      voteInPoll: (messageId, optionIds) => {
        if (!socketRef.current) throw new Error("Socket not connected");
        socketRef.current.emit("voteInPoll", {
          messageId,
          optionIds: Array.isArray(optionIds) ? optionIds : [optionIds],
        });
      },

      markMessageAsRead: (messageId, receiverId) => {
        if (socketRef.current) {
          socketRef.current.emit("markAsRead", { messageId, receiverId });
        }
      },

      /**
       * @param senderId       the DM peer, for the derived-key form
       * @param chatId         the chat-list id, so the badge clears immediately
       * @param conversation   an explicit conversation key — groups have no
       *                       "sender" to derive one from
       */
      markConversationAsRead: (senderId, chatId, conversation) => {
        if (socketRef.current) socketRef.current.emit("markConversationAsRead", { senderId, conversation });
        // Clear locally rather than waiting for the round trip — the badge
        // shouldn't linger while the server catches up.
        if (chatId) dispatch({ type: "CLEAR_UNREAD", payload: { conversationId: chatId } });
      },

      /**
       * Toggle one per-chat flag — mute, pin, favourite, lock.
       *
       * Here rather than in each page, because the response carries every list and
       * whoever called it was the only component that saw it (#96). Muting from the
       * details page left the chat list showing it unmuted until a reload.
       */
      setChatState: async (chatId, stateKey, nextState, pin) => {
        const data = await chatAPI.updateChatState(chatId, stateKey, nextState, pin);
        dispatch({ type: "SET_PREFERENCES", payload: data });
        return data;
      },

      /**
       * Move the watermark back so the chat shows as unread again.
       *
       * The badge comes from the response, not from an assumed 1. The watermark
       * lands one millisecond before the newest inbound message, so anything sharing
       * that millisecond is unread too — the client showed 1 and the next
       * `/chats/unread-count` poll replaced it with 2, which is CF8. The endpoint
       * reports the real number now, so this renders it.
       */
      markConversationUnread: async (chatId) => {
        const response = await chatAPI.updateChatState(chatId, "unread", true);
        const count = Number.isInteger(response?.unreadCount) ? response.unreadCount : 1;
        dispatch({ type: "SET_UNREAD_COUNTS", payload: { counts: { [chatId]: count } } });
      },

      /**
       * Mark a chat read from the list, without opening it.
       *
       * The menu item for this used to send `unread: false`, which only removed
       * a *manual* unread flag — so on a chat that was genuinely unread it
       * changed nothing at all while the label claimed otherwise.
       */
      clearChatUnread: async (chatId) => {
        dispatch({ type: "CLEAR_UNREAD", payload: { conversationId: chatId } });
        await chatAPI.updateChatState(chatId, "read", true);
      },

      checkUserStatus: (userId) => {
        if (socketRef.current) {
          socketRef.current.emit("getUserStatus", { userId });
        }
      },

      setReplyMessage: (message) => {
        dispatch({ type: "SET_REPLY_MESSAGE", payload: message });
      },

      clearReplyMessage: () => {
        dispatch({ type: "CLEAR_REPLY_MESSAGE" });
      },
    }),
    // `emitWithAck` is memoised on [] and so is stable for the provider's
    // lifetime; listing it keeps this array honest without reintroducing the
    // identity churn that made every action change once on mount.
    [emitWithAck]
  );

  // Written during render, not in an effect: a socket event can land before
  // effects have run, and a null here would silently skip the refresh.
  loadConversationsRef.current = actions.loadConversations;

  /*
   * Preferences are loaded here, once per account (CF37).
   *
   * The provider held them but never fetched them — three pages each called
   * `loadPreferences` on their own mount, so anything rendered outside those pages saw
   * empty lists. That is what pushed the post card into keeping its own copy: the star in
   * the feed had to work before you had visited a chat page. Owning the state without
   * owning the fetch is only half an owner.
   *
   * Declared after `actions` because it uses one, and keyed on the account rather than the
   * token so an ordinary token refresh doesn't refetch. Sign-out clears via
   * `RESET_PREFERENCES` above, and the null id here lets the next sign-in load again.
   */
  const preferencesAccountRef = React.useRef(null);
  useEffect(() => {
    const id = userAuth?.token ? userAuth?.id || userAuth?._id || null : null;
    if (!id) {
      preferencesAccountRef.current = null;
      return;
    }
    if (preferencesAccountRef.current === id) return;
    preferencesAccountRef.current = id;
    actions.loadPreferences().catch(() => {});
  }, [userAuth?.token, userAuth?.id, userAuth?._id, actions]);

  /*
   * Keep the snapshots current as state changes, rather than only at fetch time.
   *
   * Watching the reduced state instead of instrumenting each mutation is what makes
   * this cheap to be correct: a live `receiveMessage`, an edit, a reaction, an
   * unsend and an optimistic send all land in `state.messages` or
   * `state.conversations`, so all of them are picked up here without a write at
   * every call site — and none can be forgotten when a new one is added.
   *
   * Debounced because a burst (a page of reactions, a rapid exchange) would
   * otherwise open a transaction per change.
   */
  useEffect(() => {
    const viewerId = viewerIdRef.current;
    const threadKey = activeThreadCacheKeyRef.current;
    /*
     * An empty thread is not persisted here. Switching conversations clears
     * `messages` before the next thread loads, and writing that would blank the
     * snapshot of the chat we just left. A genuinely emptied thread is still
     * overwritten — by the unconditional write in the loaders.
     */
    if (!viewerId || !threadKey || state.messages.length === 0) return undefined;

    const timer = setTimeout(() => {
      setCachedThread(viewerId, threadKey, {
        messages: state.messages,
        hasMore: state.hasMoreMessages,
        peerId: state.currentConversation,
      }).catch((error) => {
        console.error("Failed to update cached thread:", error);
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [state.messages, state.hasMoreMessages, state.currentConversation]);

  useEffect(() => {
    const viewerId = viewerIdRef.current;
    const cacheKey = listCacheKeyRef.current;
    /*
     * Not while a fresh load is in flight. Switching tabs points the key at the new
     * view immediately, but `conversations` still holds the old view's rows until
     * the response lands — and a live message arriving in that window mutates them,
     * which would otherwise write the previous tab's rows under the new tab's key.
     */
    if (!viewerId || !cacheKey || state.listLoading) return undefined;
    if (state.conversations.length === 0) return undefined;

    const timer = setTimeout(() => {
      setCachedChatList(viewerId, cacheKey, {
        chats: state.conversations,
        pageInfo: state.listPageInfo,
      }).catch((error) => {
        console.error("Failed to update cached chat list:", error);
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [state.conversations, state.listPageInfo, state.listLoading]);

  const value = React.useMemo(
    () => ({
      ...state,
      actions,
    }),
    [state, actions]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
