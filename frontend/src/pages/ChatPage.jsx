import React, {
  useContext,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { toast } from "react-hot-toast";
import { chatAPI } from "../services/api";
import {
  clearAllUnlockGrants,
  clearUnlockGrant,
  saveUnlockGrant,
} from "../services/chatUnlock";
import {
  BadgeCheck,
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  CircleDot,
  Check,
  FolderOpen,
  Inbox,
  Lock,
  LockOpen,
  MessageCircle,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  Star,
  Tag,
  Trash2,
  UserCheck,
  UserMinus,
  UserX,
  Users,
} from "lucide-react";
import { UserContext } from "../contexts/UserContext";
import { useChat } from "../contexts/ChatContext";
import { useBlock } from "../contexts/BlockContext";
import { userAPI } from "../services/api";
import { useNavigate } from "react-router-dom";
import SiteHeader from "../components/layouts/site-header";
import MobileNavbar from "../components/layouts/mobile-navbar";
import { Icons } from "../components/icons";
import CreatePost from "../components/CreatePost";
import ResponsiveMenu from "../components/ui/ResponsiveMenu";
import ResponsiveSheet from "../components/ui/responsive-sheet";
import { useLongPress } from "../hooks/useLongPress";
import { useDebounce } from "../hooks/useDebounce";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import ReconnectBanner from "../components/Chat/ReconnectBanner";

/*
 * ── Conversation row furniture ────────────────────────────────────────────────
 *
 * Module scope, not declared inside ChatPage's render body. A component declared
 * in a render body is a new *type* on every render, so React unmounts and rebuilds
 * the whole subtree — round 5 was entirely that bug.
 */

/**
 * The per-chat state the row was computing and never showing (#114).
 *
 * `isMuted`, `isFavorite` and `categoryId` were all resolved for every row and then
 * used only to decide what the menu should say, so muting a chat produced no visible
 * change anywhere and users had no way to tell the action had done anything. Lock
 * and pin were given icons in 8b; these are the three that were left.
 */
const ChatRowBadges = ({ item }) => (
  <>
    {item.isLocked && (
      <span className="shrink-0 inline-flex items-center" title="Locked">
        <Lock className="w-3.5 h-3.5 text-neutral-400" aria-hidden="true" />
      </span>
    )}
    {item.isPinned && (
      <span className="shrink-0 inline-flex items-center" title="Pinned">
        <Pin className="w-3.5 h-3.5 text-neutral-300" aria-hidden="true" />
      </span>
    )}
    {item.isMuted && (
      <span className="shrink-0 inline-flex items-center" title="Muted">
        <BellOff className="w-3.5 h-3.5 text-neutral-500" aria-hidden="true" />
      </span>
    )}
    {item.isFavorite && (
      <span className="shrink-0 inline-flex items-center" title="Favourite">
        <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" aria-hidden="true" />
      </span>
    )}
    {item.categoryId && (
      <span className="shrink-0 inline-flex items-center" title="In a list">
        <Tag className="w-3.5 h-3.5 text-neutral-500" aria-hidden="true" />
      </span>
    )}
  </>
);

/**
 * The `⋮` trigger.
 *
 * Was 24×24 with only a `title` and a literal `⋮` character as its label: under the
 * 44px minimum touch target, and announced by a screen reader as "vertical
 * ellipsis" (#51). The glyph is now decorative and the button carries the name;
 * `p-2.5` on a 5×5 icon gets it to 44px without changing how the row looks, because
 * the padding overlaps the row's own.
 */
const ChatRowMenuButton = ({ item, onOpen }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      onOpen(event, item);
    }}
    // The row is itself a button; a keystroke here must not also open the chat.
    onKeyDown={(event) => event.stopPropagation()}
    className="w-11 h-11 -mr-2 rounded-full flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
    aria-label="Chat options"
  >
    <MoreVertical className="w-5 h-5" aria-hidden="true" />
  </button>
);

/**
 * What a screen reader reads for a row.
 *
 * The row was a bare div, so it announced its children as a run of loose text with
 * no indication it was one activatable thing — and the state icons are all
 * `aria-hidden`, being decoration, so they have to be said here instead.
 */
const rowAccessibleName = (title, item, unreadCount) => {
  const parts = [title];
  if (unreadCount > 0) {
    parts.push(`${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`);
  }
  if (item.isPinned) parts.push("pinned");
  if (item.isMuted) parts.push("muted");
  if (item.isFavorite) parts.push("favourite");
  if (item.isLocked) parts.push("locked");
  return parts.join(", ");
};


const DEFAULT_BUILT_IN_TABS = [
  { id: "all", label: "All" },
  { id: "requests", label: "Requests" },
  { id: "groups", label: "Groups" },
  { id: "unread", label: "Unread" },
  { id: "favorites", label: "Favorites" },
  { id: "archived", label: "Archived" },
];

const ChatPage = ({ embedded = false }) => {
  const { userAuth } = useContext(UserContext);
  const {
    conversations: chats,
    listLoading: chatLoading,
    listLoadingMore: chatLoadingMore,
    listError: chatError,
    listPageInfo,
    onlineUsers,
    unreadCounts,
    preferences,
    actions: {
      loadConversations,
      loadMoreConversations,
      clearChatUnread,
      markConversationUnread,
      loadPreferences,
      applyPreferences,
      setChatState,
      toggleFavoriteChat,
      deleteChat,
    },
  } = useChat();

  /*
   * Block state from the one place that owns it.
   *
   * This page used to call `userAPI.block/unblock` itself and read `isBlocked` off
   * the fetched row, which is a third representation of the same fact — so the list,
   * the feed and the profile could all disagree about whether an account was blocked.
   */
  const {
    isBlocked: isUserBlocked,
    unblock: unblockUser,
    requestBlock,
  } = useBlock();

  /*
   * Preferences come from the provider, not from local state (#96).
   *
   * This page used to hold seven `useState` mirrors of the same account-wide data
   * that the details page and the conversation page each fetched separately, so
   * muting a chat from its details page left this list showing it unmuted. They are
   * derived here so the rest of the file reads unchanged.
   */
  const {
    loaded: prefsLoaded,
    categories: customCategories,
    categoryAssignments,
    favoriteChats,
    mutedChats,
    pinnedChats,
    lockedChats,
    hasLockPin,
  } = preferences;

  const [filteredUsers, setFilteredUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState("all");
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [tabMenu, setTabMenu] = useState(null);
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false);
  const [filterDropdownPosition, setFilterDropdownPosition] = useState({ x: 24, y: 24 });
  const [advancedFilters, setAdvancedFilters] = useState({
    verifiedProfiles: false,
    following: false,
    followers: false,
    unanswered: false,
  });
  const [draggingCategoryId, setDraggingCategoryId] = useState(null);
  const [dragOverCategoryId, setDragOverCategoryId] = useState(null);
  const [chatMenu, setChatMenu] = useState(null);
  /*
   * The chat whose "Add to list" sheet is open, and the chat a newly created list
   * should be assigned to.
   *
   * The list picker used to render inline inside the options menu, which meant a
   * scrolling nested panel inside an already-scrolling floating menu, and on a phone
   * the whole thing overflowed the sheet. It is its own sheet now.
   * `pendingListChatId` survives the hop from that sheet to the "New list" sheet,
   * which is what lets a created list actually contain the chat you started from.
   */
  const [listSheetItem, setListSheetItem] = useState(null);
  const [pendingListChatId, setPendingListChatId] = useState(null);
  const [lockPinInput, setLockPinInput] = useState("");
  // The existing PIN when changing, or the account password when resetting.
  const [lockPinCurrent, setLockPinCurrent] = useState("");
  const [isPinModalOpen, setIsPinModalOpen] = useState(false);
  const [pendingLockItem, setPendingLockItem] = useState(null);
  const [pinAction, setPinAction] = useState("toggle");
  const [builtInTabs, setBuiltInTabs] = useState(DEFAULT_BUILT_IN_TABS);
  const navigate = useNavigate();
  const tabLongPressTimerRef = useRef(null);
  const filterTriggerRef = useRef(null);
  const filterDropdownRef = useRef(null);
  const filterButtonRef = useRef(null);
  const searchInputRef = useRef(null);
  const tabMenuRef = useRef(null);
  const listSentinelRef = useRef(null);

  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);
  const layoutContext = { openCreateModal, closeCreateModal };

  /*
   * Delegated to the provider, which owns preferences now (#96).
   *
   * This page held seven `useState` mirrors and re-read them itself; the details page
   * and the conversation page each did their own fetch. One owner means a change made
   * anywhere is visible everywhere, which is the bug the duplication caused.
   */
  const loadChatPreferences = useCallback(async () => {
    if (!userAuth?.token) return;
    await loadPreferences();
  }, [userAuth?.token, loadPreferences]);

  const getConversationParamsForFilter = useCallback((filter) => {
    /*
     * `archived` was never sent, so the server never filtered on it and
     * archiving a chat removed it from precisely nothing. Every view except the
     * archive itself now excludes archived chats, which is the whole point of
     * the feature — and the Archived tab is the way back, which is why Hide
     * (same idea, no way back) was removed rather than finished.
     */
    if (filter === "archived") return { view: "all", archived: "true" };
    if (filter === "all") return { view: "all", archived: "false" };
    if (filter === "requests") return { view: "requests", archived: "false" };
    if (filter === "groups") return { view: "groups", archived: "false" };
    if (filter === "unread") return { view: "unread", archived: "false" };
    if (filter === "favorites") return { view: "favorites", archived: "false" };
    if (filter.startsWith("category:")) {
      return {
        view: "category",
        categoryId: filter.replace("category:", ""),
        archived: "false",
      };
    }
    return { view: "all", archived: "false" };
  }, []);

  useEffect(() => {
    if (!userAuth?.token) return;
    loadChatPreferences();
  }, [userAuth?.token, loadChatPreferences]);

  useEffect(() => {
    if (!userAuth?.token) return;
    loadConversations(getConversationParamsForFilter(activeFilter));
  }, [userAuth?.token, activeFilter, loadConversations, getConversationParamsForFilter]);

  /*
   * The rest of the list, a page at a time (CF23/CF24).
   *
   * The endpoint used to return up to 500 conversations and stop without saying so, and
   * this page rendered whatever arrived — so a heavy account's older chats were
   * unreachable and searching them found nothing. It is cursored now, and the sentinel
   * below asks for the next page as it comes into view.
   *
   * `chats.length` is in the dependencies so the observer is rebound after each page:
   * without it the sentinel keeps the same registration while the element moves down the
   * document, and on a list that grows past the viewport it never intersects again.
   *
   * Re-entry is the provider's problem, not this effect's — the sentinel fires repeatedly
   * while visible, and `loadMoreConversations` drops calls that arrive while one is in
   * flight or when there is no cursor left.
   */
  useEffect(() => {
    const sentinel = listSentinelRef.current;
    if (!sentinel || !listPageInfo.hasNextPage) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreConversations();
      },
      { rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [listPageInfo.hasNextPage, loadMoreConversations, chats.length]);

  // fetchChats removed - handled by ChatContext

  // fetchUnreadCounts removed - handled by ChatContext

  /*
   * Search state is derived from the query, not tracked alongside it.
   *
   * There used to be a `showSearchResults` boolean set independently of
   * `searchQuery`, and the request had no staleness guard. Clearing the box while a
   * request was in flight went: the box empties and the flag goes false, then the
   * old response lands and sets it back to true — so the chat list stayed hidden
   * behind a results panel headed `Search for ""`, listing whatever the abandoned
   * query had matched, with no spinner to explain it. Typing again was the only way
   * out. The same two-sources-of-truth also meant that during the 300ms debounce
   * neither render branch was taken and the page below the search bar went blank.
   *
   * Deriving the panel from the query makes both states unrepresentable, and the
   * `cancelled` flag drops responses for queries the user has moved on from. This
   * is the shape the in-conversation search already used.
   */
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const trimmedQuery = searchQuery.trim();
  const showSearchResults = trimmedQuery !== "";

  /*
   * Results in hand are for `debouncedSearchQuery`; the panel is headed with
   * `searchQuery`. While those disagree the results on screen belong to a query
   * the user has already edited, so they're withheld rather than shown as if they
   * answered the new one.
   */
  const searchPending =
    showSearchResults &&
    (searchLoading || debouncedSearchQuery.trim() !== trimmedQuery);

  useEffect(() => {
    const query = debouncedSearchQuery.trim();
    if (!query) {
      setFilteredUsers([]);
      setSearchLoading(false);
      return undefined;
    }

    let cancelled = false;
    setSearchLoading(true);

    userAPI
      .searchUsers(query)
      .then((data) => {
        if (!cancelled) setFilteredUsers(data.users || []);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Error searching users:", error);
        setFilteredUsers([]);
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });

    // Covers both a superseded query and unmount, so no response can land on a
    // page that has moved on or gone away.
    return () => {
      cancelled = true;
    };
  }, [debouncedSearchQuery]);

  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value);
  };

  const clearSearch = () => {
    setSearchQuery("");
    setFilteredUsers([]);
    searchInputRef.current?.focus();
  };

  // handleNewMessage removed - handled by ChatContext

  // handleNewGroupMessage removed - to be handled by ChatContext
  // fetchUserById removed - unused

  const handleUserSelect = (user) => {
    navigate(`/chat/${user.username}`);
  };

  /*
   * A ref, not a document-wide query for the placeholder text (#151).
   *
   * This was `document.querySelector('input[placeholder="Search users to chat"]')`,
   * which reaches outside the component into the whole page, breaks the moment
   * anyone edits the copy — including a translation — and would find the wrong input
   * if a second one ever carried the same placeholder. It also finds nothing on the
   * embedded layout if the search box is scrolled out of the DOM.
   */
  const handleStartConversation = () => {
    searchInputRef.current?.focus();
  };

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (
        !filterTriggerRef.current?.contains(event.target) &&
        !filterDropdownRef.current?.contains(event.target)
      ) {
        setIsFilterDropdownOpen(false);
      }

      if (tabMenuRef.current && !tabMenuRef.current.contains(event.target)) {
        setTabMenu(null);
      }
      setChatMenu((prev) => {
        if (!prev) return prev;
        const target = event.target;
        if (target?.closest?.("[data-chat-menu]")) return prev;
        return null;
      });
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!userAuth?.id) return;
    try {
      const saved = JSON.parse(
        localStorage.getItem(`chat-built-in-tabs-order-${userAuth.id}`) || "[]"
      );
      if (Array.isArray(saved) && saved.length) {
        // From the shared default, not a second hardcoded copy. The copy here
        // was never updated when a tab was added, so any user with a saved
        // order — which is everyone, the persist effect writes on mount —
        // would never see a new tab, and the stale order got written back.
        const byId = new Map(DEFAULT_BUILT_IN_TABS.map((item) => [item.id, item]));
        const reordered = saved.map((id) => byId.get(id)).filter(Boolean);
        const missing = [...byId.values()].filter(
          (item) => !reordered.some((entry) => entry.id === item.id)
        );
        setBuiltInTabs([...reordered, ...missing]);
      }
    } catch {
      // Keep default order
    }
  }, [userAuth?.id]);

  useEffect(() => {
    if (!userAuth?.id) return;
    localStorage.setItem(
      `chat-built-in-tabs-order-${userAuth.id}`,
      JSON.stringify(builtInTabs.map((tab) => tab.id))
    );
  }, [builtInTabs, userAuth?.id]);

  const formatMessageTime = (dateString) => {
    // Guarded: every comparison below is NaN for an invalid date and the
    // fallthrough renders the literal string "Invalid Date".
    if (!dateString) return "";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return "Now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const formatSentTime = (dateString, prefix = "Sent") => {
    if (!dateString) return prefix;
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return `${prefix} just now`;
    if (diffMins < 60) return `${prefix} ${diffMins}m ago`;
    if (diffHours < 24) return `${prefix} ${diffHours}h ago`;

    return `${prefix} ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  };

  const getMessagePreview = (message, { locked = false } = {}) => {
    // The server withholds the preview for a locked chat rather than trusting
    // the client to hide it, so `message` is genuinely absent here.
    if (locked) return "Locked chat";
    if (!message) return "";

    if (message.isDeleted) return "This message was deleted";
    /*
     * `deletedFor` — hidden for *this* reader.
     *
     * Delete-for-me leaves the message in place with the reader's id in
     * `deletedFor`, and the list showed its text regardless: a message you had
     * deliberately hidden went on being the preview at the top of your chat list.
     */
    const myId = String(userAuth?.id || userAuth?._id || "");
    if (
      myId &&
      Array.isArray(message.deletedFor) &&
      message.deletedFor.some((id) => String(id?._id ?? id) === myId)
    ) {
      return "";
    }

    if (message.messageType === "media") {
      const mediaType = message.media?.[0]?.type;
      // `document` is the case the media branch missed — a PDF previewed as
      // "Sent a photo" because the branch only distinguished video from everything
      // else.
      if (mediaType === "video") return "Sent a video";
      if (mediaType === "document") return "Sent a file";
      if (mediaType === "audio") return "Sent an audio file";
      return "Sent a photo";
    }
    if (message.messageType === "voice") return "Sent a voice message";
    if (message.messageType === "gif") return "Sent a gif";
    if (message.messageType === "poll") {
      // The question, when there is one. "Sent a poll" over a poll everyone in the
      // group is looking at is strictly less useful than its text.
      return message.poll?.question ? `📊 ${message.poll.question}` : "Sent a poll";
    }
    if (message.messageType === "sticker") return "Sent a sticker";
    /*
     * `post_share` — unhandled, so it fell through to "Sent a message".
     *
     * The envelope covers three kinds (see Message.sharedContent), and the marker
     * survives even when the snapshot has been stripped for this reader.
     */
    if (message.messageType === "post_share") {
      const kind = message.sharedContent?.kind;
      if (kind === "profile") return "Shared a profile";
      if (kind === "comment") return "Shared a comment";
      return "Shared a post";
    }
    if (message.messageType === "file") return "Sent a file";
    if (message.messageType === "location") return "Shared a location";
    if (message.messageType === "call") {
      return message.call?.type === "video" ? "Video call" : "Voice call";
    }

    return message.content || "Sent a message";
  };

  const chatItems = useMemo(
    () =>
      chats.map((chat) => ({
        type: chat.isGroup ? "group" : "chat",
        key: chat.id,
        id: chat.id,
        // lastMessageTime, not updatedAt — the server doesn't send updatedAt,
        // so a chat with no latestMessage (locked, or never messaged) sorted to
        // the epoch and fell to the bottom of the list.
        timestamp: new Date(
          chat.latestMessage?.createdAt || chat.lastMessageTime || 0
        ).getTime(),
        // The context is the live source once it's seeded from the fetch —
        // socket bumps and clears land there, and the fetched `chat.unreadCount`
        // goes stale the moment a message arrives.
        unreadCount: unreadCounts[chat.id] ?? chat.unreadCount ?? 0,
        /*
         * Preferences win once loaded — they are not OR'd with the fetched flag.
         *
         * These read `Boolean(chat.isFavorite) || favoriteChats.includes(chat.id)`,
         * and an OR can only ever turn a flag *on*. Both sides derive from the same
         * server state so they agreed most of the time, but the moment preferences
         * moved ahead — which is exactly what an optimistic toggle does — the stale
         * fetched flag held the value up. So un-favouriting, unmuting, unpinning and
         * unlocking could not update until the list itself was refetched, which is
         * the "stays stale until refresh" behaviour.
         *
         * Preferences are the thing every mutation writes to, so they are the
         * authority. The fetched flag is only a seed for the window before
         * `/chats/preferences` has answered.
         */
        isFavorite: prefsLoaded
          ? favoriteChats.includes(chat.id)
          : Boolean(chat.isFavorite),
        isMuted: prefsLoaded ? mutedChats.includes(chat.id) : Boolean(chat.isMuted),
        isPinned: prefsLoaded ? pinnedChats.includes(chat.id) : Boolean(chat.isPinned),
        isLocked: prefsLoaded ? lockedChats.includes(chat.id) : Boolean(chat.isLocked),
        // Unread is now one fact — the watermark — rather than a real count
        // crossed with two flag arrays that could contradict each other.
        isMarkedUnread: (unreadCounts[chat.id] ?? chat.unreadCount ?? 0) > 0,
        seen: Boolean(chat.seen),
        categoryId: prefsLoaded
          ? categoryAssignments[chat.id] ?? null
          : chat.categoryId || null,
        data: chat,
      })),
    [
      chats,
      unreadCounts,
      prefsLoaded,
      favoriteChats,
      mutedChats,
      pinnedChats,
      lockedChats,
      categoryAssignments,
    ]
  );

  const groupItems = useMemo(
    () =>
      chatItems
        .filter((item) => item.type === "group")
        .sort((a, b) => {
          const pinDiff = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
          if (pinDiff !== 0) return pinDiff;
          return b.timestamp - a.timestamp;
        }),
    [chatItems]
  );

  const allItems = useMemo(() => [...chatItems].sort((a, b) => b.timestamp - a.timestamp), [chatItems]);
  const sortedItems = useMemo(
    () =>
      [...allItems].sort((a, b) => {
        const pinDiff = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
        if (pinDiff !== 0) return pinDiff;
        return b.timestamp - a.timestamp;
      }),
    [allItems]
  );

  /*
   * The open menu's row, re-read from live state each render.
   *
   * `chatMenu.item` is a snapshot taken when the menu opened, and every label in the
   * menu was reading it — so toggling Favorite left the item saying "Add to
   * Favorites" even after the star had flipped on the row underneath, which is what
   * made an optimistic update look like it hadn't happened. Falling back to the
   * snapshot matters for the archive case, where the row legitimately leaves the
   * filtered list.
   */
  const activeMenuItem = useMemo(() => {
    if (!chatMenu?.item) return null;
    return allItems.find((entry) => entry.id === chatMenu.item.id) || chatMenu.item;
  }, [chatMenu, allItems]);

  /**
   * The name of the list the open menu's chat is filed under, or null.
   *
   * Resolved from `customCategories` rather than stored on the row, so renaming a
   * list is reflected without a refetch. Null also covers a `categoryId` pointing at
   * a list that has since been deleted — in which case the menu correctly offers to
   * add rather than to remove from something that no longer exists.
   */
  const activeMenuItemListName = useMemo(() => {
    if (!activeMenuItem?.categoryId) return null;
    return (
      customCategories.find((category) => category.id === activeMenuItem.categoryId)
        ?.name || null
    );
  }, [activeMenuItem, customCategories]);

  /** Whose chat the "New list" sheet will file, for the hint inside it. */
  const pendingListChatName = useMemo(() => {
    if (!pendingListChatId) return null;
    const entry = allItems.find((item) => item.id === pendingListChatId);
    return entry?.data?.user?.name || entry?.data?.user?.username || null;
  }, [pendingListChatId, allItems]);

  const filteredItems = useMemo(() => {
    let items = sortedItems;
    if (activeFilter === "all") items = sortedItems;
    /*
     * The Groups tab used to `return` here, before the advanced filters below ran.
     *
     * So a filter left on from another tab was silently ignored on this one — the
     * trigger still showed it as active and the list disagreed with it (#116). The
     * profile-shaped filters (verified, following, followers) are about a *person*
     * and can't apply to a group, so they pass groups through by construction; going
     * through the same code path is what keeps that a deliberate answer rather than
     * an accident of where the early return sat.
     */
    if (activeFilter === "groups") items = groupItems;
    if (activeFilter === "unread") {
      items = sortedItems.filter((item) => item.isMarkedUnread || item.unreadCount > 0);
    }
    if (activeFilter === "favorites") items = sortedItems.filter((item) => item.isFavorite);
    if (activeFilter.startsWith("category:")) {
      const categoryId = activeFilter.replace("category:", "");
      items = sortedItems.filter((item) => item.categoryId === categoryId);
    }

    if (advancedFilters.verifiedProfiles) {
      items = items.filter((item) => item.type !== "chat" || Boolean(item.data?.user?.isVerified));
    }

    if (advancedFilters.following) {
      items = items.filter(
        (item) => item.type !== "chat" || Boolean(item.data?.relationship?.isFollowing)
      );
    }

    if (advancedFilters.followers) {
      items = items.filter(
        (item) => item.type !== "chat" || Boolean(item.data?.relationship?.isFollower)
      );
    }

    if (advancedFilters.unanswered) {
      const myUserId = String(userAuth?.id || userAuth?._id || "");
      items = items.filter((item) => {
        if (item.type !== "chat") return false;
        const senderId = String(item.data?.latestMessage?.sender?._id || "");
        return Boolean(senderId) && Boolean(myUserId) && senderId !== myUserId;
      });
    }

    return items;
  }, [activeFilter, sortedItems, groupItems, advancedFilters, userAuth?.id, userAuth?._id]);

  /*
   * Loaded conversations matching the search box.
   *
   * Local, over `sortedItems`, rather than a `GET /chats?search=` round trip: the results
   * are instant on every keystroke, and the server's own `search` is the same substring
   * match applied to a page it has already fetched — it matches peer usernames and group
   * names, which aren't on the row the query pages over, so it cannot be a predicate.
   *
   * The limit is therefore the same on both sides and it is now honest: this searches the
   * conversations that have been paged in, and scrolling pages in more. It used to search
   * a set the server had silently truncated at 500, which no amount of scrolling would
   * extend (CF24).
   */
  const matchingChats = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return sortedItems.filter((item) => {
      const peer = item.data?.user;
      const group = item.data?.group;
      return [peer?.name, peer?.username, group?.name].some((field) =>
        field?.toLowerCase().includes(q)
      );
    });
  }, [searchQuery, sortedItems]);

  const toggleAdvancedFilter = (key) => {
    setAdvancedFilters((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const activeAdvancedFilterCount = useMemo(
    () => Object.values(advancedFilters).filter(Boolean).length,
    [advancedFilters]
  );

  const clearAdvancedFilters = useCallback(() => {
    setAdvancedFilters({
      verifiedProfiles: false,
      following: false,
      followers: false,
      unanswered: false,
    });
  }, []);

  /*
   * Filters reset when the tab changes.
   *
   * They persisted across tabs, so switching to Requests with "Verified Profiles"
   * still on showed an empty list and the generic "Start a conversation" copy — the
   * filter was invisible on the new tab and the emptiness looked like the truth
   * (#116). Resetting is the behaviour that can't mislead; the alternative is
   * showing the filter state on every tab, which is the same information in four
   * more places.
   */
  useEffect(() => {
    clearAdvancedFilters();
  }, [activeFilter, clearAdvancedFilters]);

  const toggleFilterDropdown = (event) => {
    event.stopPropagation();
    const rect = filterButtonRef.current?.getBoundingClientRect?.();
    if (rect) {
      setFilterDropdownPosition({
        x: rect.left,
        y: rect.bottom + 8,
      });
    }
    setIsFilterDropdownOpen((prev) => !prev);
  };

  const createCustomCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    const exists = customCategories.some(
      (category) => category.name.toLowerCase() === name.toLowerCase()
    );
    if (exists) return;
    try {
      const data = await chatAPI.createCategory(name);
      const createdCategory = (data?.categories || []).find(
        (category) => category.name.toLowerCase() === name.toLowerCase()
      );

      /*
       * If the list was created from a chat's "Add to list", put that chat in it.
       *
       * Creating a list from there used to drop the chat entirely — the menu was
       * closed and its item discarded before the naming sheet even opened — so you
       * named a list, were switched to it, and found it empty, with no indication
       * that the chat you started from had anything to do with it. `pendingListChatId`
       * is the chat, remembered across the two sheets.
       */
      if (createdCategory?.id && pendingListChatId) {
        await chatAPI.assignCategory(pendingListChatId, createdCategory.id);
      }

      await loadChatPreferences();
      if (createdCategory?.id) {
        setActiveFilter(`category:${createdCategory.id}`);
        // The row has to exist under the new filter, and the filter is server-side.
        loadConversations(getConversationParamsForFilter(`category:${createdCategory.id}`));
      }
      setNewCategoryName("");
      setPendingListChatId(null);
      setIsCategoryModalOpen(false);
    } catch (createError) {
      console.error("Error creating category:", createError);
      toast.error(
        createError?.response?.data?.error || "Couldn't create that list."
      );
    }
  };

  /*
   * One dismiss path for the naming sheet.
   *
   * `pendingListChatId` has to be cleared on cancel as well as on create, or it
   * outlives the flow — the next list created from anywhere would silently file a
   * chat the user never mentioned into it.
   */
  const closeCategorySheet = () => {
    setIsCategoryModalOpen(false);
    setNewCategoryName("");
    setPendingListChatId(null);
  };

  /**
   * Assign or clear a chat's list, then close the sheet.
   *
   * Shared by the sheet's rows and its "Remove from current list" action, which
   * previously duplicated this and disagreed — the remove path skipped
   * `loadConversations`, so removing a chat from a list left it visible in that
   * list's tab until something else refetched.
   */
  const assignChatToList = async (chatId, categoryId) => {
    try {
      await chatAPI.assignCategory(chatId, categoryId);
      await loadChatPreferences();
      loadConversations(getConversationParamsForFilter(activeFilter));
    } catch (error) {
      console.error("Error assigning list:", error);
      toast.error(error?.response?.data?.error || "Couldn't update that list.");
    } finally {
      setListSheetItem(null);
    }
  };

  /*
   * Through the provider, which owns the list and patches the cached copy (CF37).
   *
   * This used to call the endpoint itself, apply the response, and then patch the
   * IndexedDB entry separately — because post cards kept their own module-level copy of
   * `favoriteChats` and read it from there. They don't any more: `ChatProvider` wraps the
   * whole route tree, so the feed reads the same list this does and one action serves
   * both.
   */
  const toggleFavorite = async (item) => {
    const data = await toggleFavoriteChat(item.key);
    if (data && activeFilter === "favorites") {
      loadConversations(getConversationParamsForFilter(activeFilter));
    }
  };

  const updateItemState = async (item, stateKey, nextState, pin = "") => {
    try {
      // Through the provider, so the details page and the conversation page see the
      // change too rather than only this list (#96).
      const data = await setChatState(item.id, stateKey, nextState, pin);
      /*
       * Locking a chat invalidates any grant this tab was holding for it.
       *
       * Without this, locking a conversation you had open a moment ago would
       * leave it readable for the rest of the grant's fifteen minutes — the lock
       * would appear to have done nothing.
       */
      if (stateKey === "lock") clearUnlockGrant(item.id);
      loadConversations(getConversationParamsForFilter(activeFilter));
      return data;
    } catch (error) {
      console.error(`Error updating ${stateKey}:`, error);
      throw error;
    }
  };

  const handleArchiveToggle = async (item) => {
    /*
     * Closed first, and unconditionally.
     *
     * The menu used to stay open on top of a row that was about to leave the list —
     * every filter except Archived excludes archived chats — leaving a floating menu
     * anchored to nothing, still labelled with the pre-toggle state because its `item`
     * is a snapshot taken when it opened. Nothing about the archived state is worth
     * keeping the menu open for.
     */
    setChatMenu(null);
    try {
      await chatAPI.archiveChat(item.id, !item.data?.isArchived);
      loadConversations(getConversationParamsForFilter(activeFilter));
    } catch (error) {
      console.error("Error toggling archive:", error);
      toast.error(error?.response?.data?.error || "Couldn't update that chat.");
    }
  };

  /*
   * Block from the list, through BlockContext.
   *
   * This called `userAPI.block/unblock` directly, which meant the app's blocked set
   * never heard about it: block someone here and their posts kept rendering in the
   * feed, their profile still offered "Block", and this row only corrected itself
   * because it refetched. It also skipped the confirmation dialog every other entry
   * point uses. Going through the context makes one mutation update every surface,
   * and `requestBlock` restores the confirm step.
   */
  const handleBlockToggle = async (item) => {
    if (item.type !== "chat") return;
    // The row's peer object, so both the lookup and the mutation carry the id.
    const peer = item.data?.user;
    if (!peer?.username) return;

    setChatMenu(null);
    if (isUserBlocked(peer)) {
      try {
        await unblockUser(peer);
      } catch {
        // BlockContext has already rolled back and toasted.
        return;
      }
      loadConversations(getConversationParamsForFilter(activeFilter));
      return;
    }
    requestBlock({ _id: peer._id, username: peer.username, name: peer.name });
  };

  /*
   * `ConfirmDialog`, not `window.confirm` (#120).
   *
   * A native confirm is unstyled, unbrandable, blocks the whole tab, and on iOS
   * Safari names the site in the prompt — but the reason it matters here is that it
   * can be suppressed by the browser ("prevent this page from creating additional
   * dialogs"), after which the destructive action either always fires or never does
   * depending on the browser. The project has a dialog component for exactly this.
   */
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [deletingCategory, setDeletingCategory] = useState(false);

  const handleDeleteItem = (item) => {
    if (item.type !== "chat") return;
    setDeleteTarget(item);
    setChatMenu(null);
  };

  /*
   * Through the provider, which removes the row itself.
   *
   * The delete used to depend entirely on the refetch that followed it to make the
   * row disappear — and with a warm-start cache now painting the list from
   * IndexedDB, the deleted row could be drawn again before that refetch landed, so
   * deleting looked like it had failed. `deleteChat` drops the row optimistically,
   * puts it back if the request fails, and clears the thread's cached snapshot.
   */
  const confirmDeleteItem = async () => {
    if (!deleteTarget) return;
    setDeletingChat(true);
    try {
      const ok = await deleteChat(deleteTarget.data?.user?.username, deleteTarget.id);
      if (ok) setDeleteTarget(null);
    } finally {
      setDeletingChat(false);
    }
  };

  const openChatMenu = (event, item) => {
    event.preventDefault();
    const rect = event.currentTarget?.getBoundingClientRect?.();
    const menuWidth = 260;
    const estimatedMenuHeight = 560;
    const viewportHeight = window.innerHeight || 800;
    const preferredY = (rect?.bottom || event.clientY || 24) + 8;
    const maxY = Math.max(12, viewportHeight - estimatedMenuHeight - 12);
    setChatMenu({
      item,
      x: rect ? Math.max(12, rect.right - menuWidth) : event.clientX || 24,
      y: Math.min(preferredY, maxY),
    });
  };

  /*
   * `openChatMenu` reached through a ref.
   *
   * The long-press callback has to be stable — `useLongPress` memoises on it, and
   * an identity that changes every render would rebuild the timer machinery on each
   * one. `openChatMenu` is redeclared every render because it closes over setState,
   * so the ref is the indirection that keeps the callback stable without making the
   * menu logic stale.
   */
  const openChatMenuRef = useRef(openChatMenu);
  openChatMenuRef.current = openChatMenu;

  /*
   * Close the menu when the list moves under it (#150).
   *
   * Its position is a `getBoundingClientRect()` snapshot taken when it opened, so
   * scrolling left it floating over an unrelated row — still acting on the chat it
   * was opened for, which is the dangerous half. Repositioning on every scroll frame
   * would be the fuller fix; dismissing is what a native menu does and is the
   * behaviour nobody has to learn.
   */
  useEffect(() => {
    // All three hand-positioned popovers, not just the chat menu — the tab menu and
    // the filter dropdown snapshot a rect the same way and detach the same way.
    if (!chatMenu && !tabMenu && !isFilterDropdownOpen) return undefined;
    const dismiss = () => {
      setChatMenu(null);
      setTabMenu(null);
      setIsFilterDropdownOpen(false);
    };
    // Capture phase, so a scroll inside the list container is caught too — a
    // bubbling scroll listener on window never sees it.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [chatMenu, tabMenu, isFilterDropdownOpen]);

  /*
   * The tab long-press timer, cleared on unmount (#149).
   *
   * It is already a ref rather than state, but nothing cancelled it — navigating away
   * mid-press fired `setTabMenu` into an unmounted component. `useLongPress` handles
   * this for the row press; this one is hand-rolled because it also has to
   * distinguish a fixed tab from a category.
   */
  useEffect(
    () => () => {
      if (tabLongPressTimerRef.current) clearTimeout(tabLongPressTimerRef.current);
    },
    []
  );

  /*
   * Long press, through the shared hook.
   *
   * This was hand-rolled and had both of the problems `useLongPress` exists to
   * solve. The timer lived in `useState`, so every touchstart re-rendered the whole
   * list, and it was never cleared on unmount — navigating away mid-press fired
   * setState into a dead component. And nothing suppressed the click that ends the
   * press, so holding a row opened the menu *and* navigated into the conversation
   * behind it (#101); the hook's `consumeClick` is exactly that suppression, and it
   * also kills the iOS callout that was hijacking the gesture.
   *
   * One hook instance for the whole list rather than one per row — the row being
   * pressed goes in a ref, because the hook's callback is stable by design.
   */
  const pressedItemRef = useRef(null);

  const openMenuForPressedItem = useCallback((event) => {
    const item = pressedItemRef.current;
    if (item) openChatMenuRef.current?.(event, item);
  }, []);

  const chatLongPress = useLongPress(openMenuForPressedItem);

  /**
   * Props for a conversation row: long-press handlers, the click that has to know
   * whether it was a long press, and the keyboard equivalents.
   */
  const chatRowProps = (item, onOpen) => ({
    ...chatLongPress.handlers,
    onPointerDown: (event) => {
      pressedItemRef.current = item;
      chatLongPress.handlers.onPointerDown(event);
    },
    onClick: (event) => {
      if (chatLongPress.consumeClick(event)) return;
      onOpen();
    },
    /*
     * `role="listitem"`, not `role="button"` (#51).
     *
     * The row was a bare `<div onClick>` — unreachable by keyboard, announced as
     * nothing. `role="button"` was the obvious repair and the wrong one: the row
     * *contains* a real `<button>` for the ⋮ menu, and ARIA treats interactive
     * content inside a `button` role as presentational, so screen readers may not
     * expose that menu at all. Fixing the row by hiding a control isn't a fix.
     *
     * A list item that happens to be activatable is what this is. It keeps its own
     * name, stays in the tab order, answers Enter and Space, and leaves the nested
     * button exposed — and the list container carries `role="list"`.
     */
    role: "listitem",
    tabIndex: 0,
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen();
        return;
      }
      // The same menu the long press and the right-click open, from the keyboard.
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        openChatMenu(event, item);
      }
    },
    onContextMenu: (event) => {
      chatLongPress.handlers.onContextMenu?.(event);
      openChatMenu(event, item);
    },
  });

  const runToggleAction = async (item, stateKey) => {
    // Read and unread aren't a flag any more, they're the read watermark, so
    // they go through the context rather than the preferences endpoint.
    if (stateKey === "unread") {
      setChatMenu(null);
      try {
        if (item.isMarkedUnread) await clearChatUnread(item.id);
        else await markConversationUnread(item.id);
      } catch (error) {
        console.error("Error changing read state:", error);
      }
      return;
    }

    // Only mute and pin reach here now; hide and flag are gone and read/unread
    // returned above.
    const current = stateKey === "mute" ? item.isMuted : item.isPinned;
    await updateItemState(item, stateKey, !current);
    setChatMenu(null);
  };

  const handleLockToggle = async (item) => {
    setPendingLockItem(item);
    setPinAction("toggle");
    setLockPinInput("");
    setIsPinModalOpen(true);
  };

  const closePinModal = () => {
    setIsPinModalOpen(false);
    setPendingLockItem(null);
    setLockPinInput("");
    setLockPinCurrent("");
    setPinAction("toggle");
  };

  const openPinSetup = (action) => {
    setPinAction(action);
    setPendingLockItem(null);
    setLockPinInput("");
    setLockPinCurrent("");
    setIsPinModalOpen(true);
  };

  const submitLockPinAction = async () => {
    if (!pendingLockItem) return;
    try {
      if (pinAction === "open") {
        /*
         * Opening a locked chat asks a question; it doesn't write anything.
         *
         * This used to call `PUT /preferences/state/:chatId` with `nextState` set
         * to the value the chat already had, purely so the server would compare
         * the PIN — a write pretending to be a question, and it produced nothing
         * the thread endpoint could use. The lock is enforced server-side now, so
         * proving the PIN returns a short-lived grant instead and the reads verify
         * it. See services/chatUnlock.js.
         */
        const data = await chatAPI.verifyChatLockPin(pendingLockItem.id, lockPinInput);
        saveUnlockGrant(data.chatId, data.grant, data.expiresAt);
        if (pendingLockItem.type === "group") {
          navigate(`/chat/group/${pendingLockItem.data?.group?._id}`);
        } else {
          navigate(`/chat/${pendingLockItem.data?.user?.username}`);
        }
      } else {
        await updateItemState(
          pendingLockItem,
          "lock",
          !pendingLockItem.isLocked,
          lockPinInput
        );
      }
      setIsPinModalOpen(false);
      setPendingLockItem(null);
      setChatMenu(null);
      setLockPinInput("");
      setPinAction("toggle");
    } catch (error) {
      toast.error(
        error?.response?.data?.error || "Couldn't update the lock. Try again."
      );
    }
  };

  /*
   * Setting, changing and resetting the PIN.
   *
   * There was one path — `window.prompt("Set chat lock PIN")` — reachable only
   * when no PIN existed. So a PIN could be created and then never changed, and
   * a forgotten one locked those conversations for the life of the account:
   * `setChatLockPin` requires the current PIN, and nothing anywhere could
   * supply it. The reset goes through the account password instead, which is
   * the credential the lock sits behind anyway.
   */
  const submitPinSetup = async () => {
    if (pinAction === "reset") {
      try {
        const data = await chatAPI.resetChatLockPin(lockPinCurrent);
        // The list of locked chats went with the PIN, so both come from a reload
        // rather than being patched a field at a time.
        applyPreferences({ hasLockPin: false, lockedChats: [] });
        // Every chat is unlocked now, so every grant is meaningless — and holding
        // one for a chat that gets locked again later would open it without a PIN.
        clearAllUnlockGrants();
        closePinModal();
        toast.success(
          data?.unlocked
            ? `PIN removed. ${data.unlocked} chat${data.unlocked === 1 ? "" : "s"} unlocked.`
            : "PIN removed."
        );
        // With the current tab's params: bare, this replaced a filtered list with
        // the unfiltered one while the tab still claimed to be filtered.
        loadConversations(getConversationParamsForFilter(activeFilter));
      } catch (error) {
        toast.error(error?.response?.data?.error || "Couldn't reset your PIN.");
      }
      return;
    }

    if (!/^\d{4,8}$/.test(lockPinInput)) {
      toast.error("PIN must be 4-8 digits");
      return;
    }
    try {
      await chatAPI.setChatLockPin(lockPinInput, lockPinCurrent || undefined);
      applyPreferences({ hasLockPin: true });
      closePinModal();
      toast.success(pinAction === "change" ? "PIN changed" : "PIN set");
    } catch (error) {
      // The input is left alone — a wrong current PIN shouldn't cost the user
      // the new one they just typed.
      toast.error(error?.response?.data?.error || "Couldn't save your PIN.");
    }
  };

  /*
   * The four blocks below are chunks of this component's JSX, not components.
   *
   * Declared as `const X = (props) => ...` inside the render body and used as
   * `<X />`, React treats each as a component *type* that is redefined every
   * render — so the entire conversation list unmounted and remounted whenever
   * anything on the page changed: a keystroke in the search box, a menu
   * opening, an incoming message. Avatars re-requested and hover state was lost
   * each time.
   *
   * None of them uses hooks and each has exactly one call site, so calling them
   * as functions puts their JSX directly in this component's tree. The `key`
   * moves onto the root element, which is where React wants it for an item in
   * a list.
   */
  const renderChatResultCard = (chat, item) => {
    const isOnline = onlineUsers.has(chat.user._id.toString());
    const unreadCount = item.unreadCount || 0;

    const myId = String(userAuth?.id || userAuth?._id || "");
    const latestMsg = chat.latestMessage;
    const senderId = String(latestMsg?.sender?._id || latestMsg?.sender || "");
    const isSentByMe = myId && senderId && senderId === myId;

    let previewText;
    let showTimestamp = true;

    /*
     * An unread chat shows the message, not the count.
     *
     * It used to replace the preview with "3 new messages" — which throws away the
     * one thing that tells you whether to open it, and duplicates the badge
     * that is already sitting on the same row. Every messaging app shows the
     * latest message and puts the number in the badge; this showed the number
     * twice and the message never.
     */
    if (isSentByMe && unreadCount === 0) {
      // From the peer's read watermark, computed server-side. `status` was a
      // single field shared by every recipient and never reached "read" here.
      const isSeen = Boolean(item.seen);
      previewText = formatSentTime(latestMsg?.createdAt, isSeen ? "Seen" : "Sent");
      showTimestamp = false;
    } else {
      previewText = getMessagePreview(latestMsg, { locked: item.isLocked });
    }

    // Falls back to lastMessageTime: a locked chat has no latestMessage, and
    // formatMessageTime(undefined) renders the literal string "Invalid Date".
    const previewTime = showTimestamp
      ? formatMessageTime(latestMsg?.createdAt || chat.lastMessageTime)
      : null;

    const handleCardClick = () => {
      // Clearing the badge is the context's job — the watermark advances when
      // the conversation opens. This used to persist a "forced read" flag that
      // was only ever cleared by an explicit mark-as-unread, so a chat you had
      // opened once could never show a badge again.
      // Fire-and-forget, but the rejection has to be caught: the badge is
      // already zeroed optimistically, so a failure here is invisible — and
      // uncaught it becomes an unhandled rejection on every offline tap.
      /*
       * The lock first, before anything is marked read.
       *
       * `clearChatUnread` advances the server-side read watermark, so tapping a locked
       * chat and then cancelling the PIN sheet zeroed the badge on every device and
       * marked the conversation read — for messages nobody was ever shown.
       */
      if (item.isLocked) {
        setPendingLockItem(item);
        setPinAction("open");
        setLockPinInput("");
        setIsPinModalOpen(true);
        return;
      }
      if (unreadCount > 0) {
        clearChatUnread(item.id).catch((err) =>
          console.error("Failed to mark chat read:", err)
        );
      }
      navigate(`/chat/${chat.user.username}`);
    };

    return (
      <div
        key={item.key}
        {...chatRowProps(item, handleCardClick)}
        aria-label={rowAccessibleName(chat.user.name || chat.user.username, item, unreadCount)}
        className={`${chatLongPress.className} text-white w-full px-3 py-3 cursor-pointer hover:bg-neutral-900 transition-colors focus:outline-none focus-visible:bg-neutral-900 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-600`}
      >
        <div className="flex gap-3">
          <div className="cursor-pointer relative">
            <img
              className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
              src={chat.user.profilePic || "/default-avatar.png"}
              alt=""
            />
            {isOnline && (
              <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-black"></div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-row justify-between items-center gap-2">
              <div className="cursor-pointer flex-1 min-w-0">
                {/*
                  `line-clamp-1` and `flex` were on the same element, and they
                  collide: line-clamp sets `display:-webkit-box`, which `flex`
                  overrides, so the clamp did nothing and a long display name pushed
                  the timestamp and the menu off the row (#113). The flex row keeps
                  its layout job and the text node inside it does the truncating.
                */}
                <p className="text-white font-medium flex items-center gap-1 min-w-0">
                  <span className="truncate min-w-0">
                    {chat.user.name || chat.user.username}
                  </span>
                  {chat.user.isVerified && (
                    <span className="shrink-0 inline-flex items-center">
                      <Icons.verified />
                    </span>
                  )}
                  <ChatRowBadges item={item} />
                </p>
                <p
                  className={`text-sm flex items-center gap-1 min-w-0 ${
                    unreadCount > 0 ? "text-white font-semibold" : "text-neutral-500"
                  }`}
                >
                  <span className="truncate min-w-0">{previewText}</span>
                  {showTimestamp && (
                    <>
                      <span className={`shrink-0 ${unreadCount > 0 ? "text-white font-bold" : "text-neutral-500"}`}>•</span>
                      <span className="shrink-0">{previewTime}</span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {unreadCount > 0 && (
                  <span
                    className="min-w-5 h-5 px-1.5 rounded-full bg-blue-600 text-[11px] font-semibold text-white flex items-center justify-center"
                    // The count is already in the row's accessible name.
                    aria-hidden="true"
                  >
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
                <ChatRowMenuButton item={item} onOpen={openChatMenu} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderGroupCard = (conversation, item) => {
    const group = conversation.group || {};
    const unreadCount = item.unreadCount || conversation.unreadCount || 0;
    const lastMessage = conversation.latestMessage || {
      createdAt: conversation.lastMessageTime,
      content: "No messages yet",
    };

    const myId = String(userAuth?.id || userAuth?._id || "");
    const groupSenderId = String(lastMessage?.sender?._id || lastMessage?.sender || "");
    const isSentByMe = myId && groupSenderId && groupSenderId === myId;

    let previewText;
    let showTimestamp = true;

    // Same as the DM card: the message, with the count in the badge beside it.
    if (isSentByMe && unreadCount === 0) {
      // Same watermark compare the DM card uses; `status` never reaches "read".
      const isSeen = Boolean(item.seen);
      previewText = formatSentTime(lastMessage?.createdAt, isSeen ? "Seen" : "Sent");
      showTimestamp = false;
    } else {
      previewText = getMessagePreview(lastMessage, { locked: item.isLocked });
    }

    const previewTime = showTimestamp ? formatMessageTime(lastMessage?.createdAt) : null;

    const handleCardClick = () => {
      // The local `unreadCount`, not item.unreadCount — a group whose badge came
      // from the server payload rather than the context map would render the
      // badge and then never clear it on open.
      // Fire-and-forget, but the rejection has to be caught: the badge is
      // already zeroed optimistically, so a failure here is invisible — and
      // uncaught it becomes an unhandled rejection on every offline tap.
      /*
       * The lock first, before anything is marked read.
       *
       * `clearChatUnread` advances the server-side read watermark, so tapping a locked
       * chat and then cancelling the PIN sheet zeroed the badge on every device and
       * marked the conversation read — for messages nobody was ever shown.
       */
      if (item.isLocked) {
        setPendingLockItem(item);
        setPinAction("open");
        setLockPinInput("");
        setIsPinModalOpen(true);
        return;
      }
      if (unreadCount > 0) {
        clearChatUnread(item.id).catch((err) =>
          console.error("Failed to mark chat read:", err)
        );
      }
      navigate(`/chat/group/${group._id}`);
    };

    return (
      <div
        key={item.key}
        {...chatRowProps(item, handleCardClick)}
        aria-label={rowAccessibleName(group.name || "Group", item, unreadCount)}
        className={`${chatLongPress.className} text-white w-full px-3 py-3 cursor-pointer hover:bg-neutral-900 transition-colors focus:outline-none focus-visible:bg-neutral-900 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-600`}
      >
        <div className="flex gap-3">
          <div className="cursor-pointer">
            <img
              className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
              src={group.avatar || "/default-group-avatar.png"}
              alt=""
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-row justify-between items-center gap-2">
              <div className="cursor-pointer flex-1 min-w-0">
                {/* Same line-clamp/flex collision as the DM row — see #113 there. */}
                <p className="text-white font-medium flex items-center gap-1 min-w-0">
                  <span className="truncate min-w-0">{group.name}</span>
                  <ChatRowBadges item={item} />
                </p>
                <p
                  className={`text-sm flex items-center gap-1 min-w-0 ${
                    unreadCount > 0 ? "text-white font-semibold" : "text-neutral-500"
                  }`}
                >
                  <span className="truncate min-w-0">{previewText}</span>
                  {showTimestamp && (
                    <>
                      <span className={`shrink-0 ${unreadCount > 0 ? "text-white font-bold" : "text-neutral-500"}`}>•</span>
                      <span className="shrink-0">{previewTime}</span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {unreadCount > 0 && (
                  <span
                    className="min-w-5 h-5 px-1.5 rounded-full bg-blue-600 text-[11px] font-semibold text-white flex items-center justify-center"
                    aria-hidden="true"
                  >
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
                <ChatRowMenuButton item={item} onOpen={openChatMenu} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderUserCard = (user, onClick) => (
    <div
      key={user._id}
      // Same reasoning as the conversation rows: a div that behaves like a button
      // has to say so and answer the keyboard (#51).
      role="button"
      tabIndex={0}
      aria-label={`Start a chat with ${user.name || user.username}`}
      className="text-white w-full border-b border-neutral-800 px-3 py-3 cursor-pointer hover:bg-neutral-900 transition-colors focus:outline-none focus-visible:bg-neutral-900 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-600"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick(event);
        }
      }}
    >
      <div className="flex gap-3">
        <div className="cursor-pointer relative">
          <img
            className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
            src={user.profilePic || "/default-avatar.png"}
            alt=""
          />
          {onlineUsers.has(user._id.toString()) && (
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-black"></div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-row justify-start items-center relative min-w-0">
            <div className="cursor-pointer min-w-0">
              {/* line-clamp and flex collide — see #113 on the DM row. */}
              <p className="text-white font-medium flex items-center gap-1 min-w-0 hover:underline">
                <span className="truncate min-w-0">{user.name || user.username}</span>
                {user.isVerified && (
                  <span className="shrink-0 inline-flex items-center">
                    <Icons.verified />
                  </span>
                )}
              </p>
              <p className="text-neutral-500 truncate">{user.username}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const sortedCustomCategories = useMemo(
    () => [...customCategories].sort((a, b) => (a.order || 0) - (b.order || 0)),
    [customCategories]
  );

  const getEmptyStateConfig = useCallback(() => {
    if (activeFilter === "groups") {
      return {
        title: "No groups yet",
        description: "Create a group to start chatting with multiple people.",
        icon: <Users className="w-12 h-12 text-neutral-400" strokeWidth={1.8} />,
        actionLabel: "Create a Group",
        action: () => navigate("/create-group"),
        actionIcon: <Users className="w-5 h-5" strokeWidth={2} />,
      };
    }

    if (activeFilter === "archived") {
      return {
        title: "Nothing archived",
        description: "Archived chats are hidden from your list and kept here.",
        icon: <Archive className="w-12 h-12 text-neutral-400" strokeWidth={1.8} />,
      };
    }

    if (activeFilter === "requests") {
      return {
        title: "No request chats",
        description: "Message requests from people you do not follow appear here.",
        icon: <MessageCircle className="w-12 h-12 text-neutral-400" strokeWidth={1.8} />,
      };
    }

    if (activeFilter === "unread") {
      return {
        title: "No unread chats",
        description: "You are all caught up. New unread chats will show here.",
        icon: <Inbox className="w-12 h-12 text-neutral-400" strokeWidth={1.8} />,
      };
    }

    if (activeFilter === "favorites") {
      return {
        title: "No favorites yet",
        description: "Star chats to pin your important conversations here.",
        icon: <Star className="w-12 h-12 text-neutral-400" strokeWidth={1.8} />,
      };
    }

    if (activeFilter.startsWith("category:")) {
      const activeCategoryId = activeFilter.replace("category:", "");
      const currentCategory = sortedCustomCategories.find(
        (category) => category.id === activeCategoryId
      );
      return {
        title: `No chats in ${currentCategory?.name || "this category"}`,
        description: "Assign chats to this category from the chat list menu.",
        icon: <FolderOpen className="w-12 h-12 text-neutral-400" strokeWidth={1.8} />,
      };
    }

    return {
      title: "Start a conversation",
      description:
        "Send gossips, share moments, and connect with friends through private messages.",
      icon: <MessageCircle className="w-12 h-12 text-neutral-400" strokeWidth={1.8} />,
      actionLabel: "Find people to chat with",
      action: handleStartConversation,
      actionIcon: <Icons.search className="w-5 h-5" strokeColor="#404040" />,
    };
  }, [activeFilter, navigate, sortedCustomCategories]);

  const renderEmptyState = () => {
    const config = getEmptyStateConfig();
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <div className="w-24 h-24 bg-neutral-800 rounded-full flex items-center justify-center mb-6">
          {config.icon}
        </div>
        <h3 className="text-white text-xl font-semibold mb-2">{config.title}</h3>
        <p className="text-neutral-400 mb-6 max-w-md">{config.description}</p>
        {config.action && (
          <button
            onClick={config.action}
            className="bg-white hover:bg-neutral-200 text-black font-medium py-3 px-6 rounded-full transition-colors flex items-center gap-2"
          >
            {config.actionIcon}
            {config.actionLabel}
          </button>
        )}
      </div>
    );
  };

  const openTabMenu = (event, tabItem, isFixed = false) => {
    event.preventDefault();
    const rect = event.currentTarget?.getBoundingClientRect?.();
    setTabMenu({
      category: tabItem,
      isFixed,
      x: rect?.left || event.clientX || 24,
      y: (rect?.bottom || event.clientY || 24) + 8,
    });
  };

  const handleCategoryLongPressStart = (event, tabItem, isFixed = false) => {
    if (tabLongPressTimerRef.current) clearTimeout(tabLongPressTimerRef.current);
    const touch = event.touches?.[0];
    const rect = event.currentTarget?.getBoundingClientRect?.();
    tabLongPressTimerRef.current = setTimeout(() => {
      setTabMenu({
        category: tabItem,
        isFixed,
        x: rect?.left || touch?.clientX || 24,
        y: (rect?.bottom || touch?.clientY || 24) + 8,
      });
    }, 450);
  };

  const handleCategoryLongPressEnd = () => {
    if (tabLongPressTimerRef.current) clearTimeout(tabLongPressTimerRef.current);
  };

  const reorderCategory = async (direction) => {
    if (!tabMenu?.category) return;
    if (tabMenu?.isFixed) {
      const current = [...builtInTabs];
      const index = current.findIndex((item) => item.id === tabMenu.category.id);
      if (index === -1) return;
      const nextIndex = direction === "left" ? index - 1 : index + 1;
      if (nextIndex < 0 || nextIndex >= current.length) return;
      [current[index], current[nextIndex]] = [current[nextIndex], current[index]];
      setBuiltInTabs(current);
      setTabMenu(null);
      return;
    }
    const current = sortedCustomCategories;
    const index = current.findIndex((item) => item.id === tabMenu.category.id);
    if (index === -1) return;
    const nextIndex = direction === "left" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= current.length) return;
    const next = [...current];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];

    try {
      await chatAPI.reorderCategories(next.map((item) => item.id));
      await loadChatPreferences();
    } catch (reorderError) {
      console.error("Error reordering categories:", reorderError);
    } finally {
      setTabMenu(null);
    }
  };

  const reorderCategoriesByIds = useCallback(
    async (sourceCategoryId, targetCategoryId) => {
      if (!sourceCategoryId || !targetCategoryId || sourceCategoryId === targetCategoryId) {
        return;
      }

      const current = sortedCustomCategories;
      const sourceIndex = current.findIndex((item) => item.id === sourceCategoryId);
      const targetIndex = current.findIndex((item) => item.id === targetCategoryId);
      if (sourceIndex === -1 || targetIndex === -1) return;

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);

      try {
        await chatAPI.reorderCategories(next.map((item) => item.id));
        await loadChatPreferences();
      } catch (reorderError) {
        console.error("Error drag-reordering categories:", reorderError);
      }
    },
    [sortedCustomCategories, loadChatPreferences]
  );

  const handleCategoryDragStart = (event, categoryId) => {
    setDraggingCategoryId(categoryId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", categoryId);
  };

  const handleCategoryDragOver = (event, categoryId) => {
    event.preventDefault();
    if (dragOverCategoryId !== categoryId) {
      setDragOverCategoryId(categoryId);
    }
    event.dataTransfer.dropEffect = "move";
  };

  const handleCategoryDrop = async (event, categoryId) => {
    event.preventDefault();
    const sourceCategoryId = event.dataTransfer.getData("text/plain") || draggingCategoryId;
    await reorderCategoriesByIds(sourceCategoryId, categoryId);
    setDraggingCategoryId(null);
    setDragOverCategoryId(null);
  };

  const handleCategoryDragEnd = () => {
    setDraggingCategoryId(null);
    setDragOverCategoryId(null);
  };

  /*
   * Deleting a list asks first (#120).
   *
   * It was the most destructive action on this screen and the only one with no
   * confirmation whatsoever: one tap removed the list and every chat's assignment
   * to it, with no undo. The count is in the message because that is the part
   * people would want back.
   */
  const requestRemoveCategory = () => {
    if (!tabMenu?.category) return;
    setCategoryToDelete(tabMenu.category);
    setTabMenu(null);
  };

  const confirmRemoveCategory = async () => {
    if (!categoryToDelete) return;
    setDeletingCategory(true);
    try {
      await chatAPI.deleteCategory(categoryToDelete.id);
      await loadChatPreferences();
      if (activeFilter === `category:${categoryToDelete.id}`) {
        setActiveFilter("all");
      }
      setCategoryToDelete(null);
    } catch (deleteError) {
      console.error("Error deleting category:", deleteError);
      toast.error(deleteError?.response?.data?.error || "Couldn't delete that list.");
    } finally {
      setDeletingCategory(false);
    }
  };

  if (!userAuth?.token) return <div>Please log in to chat.</div>;

  return (
    <div className={embedded ? "h-full flex flex-col bg-neutral-950 overflow-hidden" : "w-full bg-neutral-950 min-h-screen"}>
      {!embedded && <SiteHeader layoutContext={layoutContext} />}
      <ReconnectBanner />
      {/*
        `pb-20 sm:pb-4` — the mobile navbar is `fixed bottom-0 h-16` and this
        container had no bottom padding, so it sat on top of the last conversation
        row: the bottom chat in the list could not be tapped at all. 20 (5rem) clears
        the 4rem bar with a little room, and `sm:` drops it because the bar is
        `sm:hidden`.
      */}
      <main className={embedded ? "flex-1 overflow-y-auto px-4 py-4 pb-20 sm:pb-4 min-h-0" : "container max-w-[620px] px-4 sm:px-6 bg-neutral-950 mx-auto py-4 pb-20 sm:pb-4"}>
        {/* Search Bar */}
        <div className="flex justify-center items-center relative">
          <input
            ref={searchInputRef}
            aria-label="Search chats and users"
            className="border border-neutral-800 rounded-xl outline-0 flex items-center justify-center w-full mx-auto py-3 sm:py-5 px-12 mt-4 bg-neutral-950 text-white placeholder-neutral-500"
            placeholder="Search users to chat"
            value={searchQuery}
            onChange={handleSearchChange}
          />
          <Icons.search
            className="absolute left-0 ml-4 mt-4 w-5 h-5 "
            strokeColor="#404040"
          />
          {/*
            A way out of the search that isn't "select all and delete". There was
            none — no clear button, and no `type="search"` either, so the browser's
            own affordance wasn't there to fall back on. Sized to 44px, and it takes
            the place of the spinner rather than sitting beside it.
          */}
          {searchLoading ? (
            <Icons.spinner className="absolute right-0 mr-4 mt-4 w-5 h-5 animate-spin text-neutral-500" />
          ) : (
            searchQuery !== "" && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Clear search"
                className="absolute right-0 mr-1 mt-4 w-11 h-11 flex items-center justify-center text-neutral-500 hover:text-white transition-colors"
              >
                <Icons.close className="w-4 h-4" />
              </button>
            )
          )}
        </div>

        {/* Instagram-like rounded DM filters */}
        <div className="flex items-center gap-2 mt-6 overflow-x-auto scrollbar-hide pb-1">
          <div ref={filterTriggerRef} className="relative shrink-0">
            <button
              ref={filterButtonRef}
              type="button"
              /*
               * The trigger says whether anything is filtered (#116).
               *
               * It looked identical whether four filters were on or none were, so a
               * filter left on from an earlier session showed an empty list with the
               * generic "Start a conversation" copy and no clue why. The border and
               * the count are the smallest honest signal.
               */
              className={`h-9 px-3 rounded-xl flex items-center justify-center cursor-pointer border ${
                activeAdvancedFilterCount > 0
                  ? "bg-neutral-800 border-neutral-500 text-white"
                  : "bg-neutral-900 border-neutral-800"
              }`}
              aria-label={
                activeAdvancedFilterCount > 0
                  ? `Filters, ${activeAdvancedFilterCount} active`
                  : "Filters"
              }
              aria-expanded={isFilterDropdownOpen}
              onClick={toggleFilterDropdown}
            >
              <div className="flex items-center gap-0.5">
                <Icons.filter className="w-4 h-4" />
                {activeAdvancedFilterCount > 0 ? (
                  <span className="text-[11px] font-semibold leading-none">
                    {activeAdvancedFilterCount}
                  </span>
                ) : (
                  <Icons.chevronbottom className="w-3 h-3" />
                )}
              </div>
            </button>
          </div>
          {builtInTabs.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`px-4 py-2 rounded-full text-sm font-medium border shrink-0 ${
                activeFilter === filter.id
                  ? "bg-white text-black border-white"
                  : "bg-neutral-900 text-neutral-300 border-neutral-800 hover:border-neutral-600"
              } cursor-pointer`}
              onClick={() => setActiveFilter(filter.id)}
              onContextMenu={(event) => openTabMenu(event, filter, true)}
              onTouchStart={(event) => handleCategoryLongPressStart(event, filter, true)}
              onTouchEnd={handleCategoryLongPressEnd}
              onTouchMove={handleCategoryLongPressEnd}
            >
              {filter.label}
            </button>
          ))}
          {sortedCustomCategories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={`px-4 py-2 rounded-full text-sm font-medium border shrink-0 ${
                activeFilter === `category:${category.id}`
                  ? "bg-white text-black border-white"
                  : "bg-neutral-900 text-neutral-300 border-neutral-800 hover:border-neutral-600"
              } ${
                draggingCategoryId === category.id ? "opacity-50" : ""
              } ${
                dragOverCategoryId === category.id ? "ring-1 ring-white/70" : ""
              } cursor-pointer`}
              onClick={() => setActiveFilter(`category:${category.id}`)}
              onContextMenu={(event) => openTabMenu(event, category, false)}
              onTouchStart={(event) => handleCategoryLongPressStart(event, category, false)}
              onTouchEnd={handleCategoryLongPressEnd}
              onTouchMove={handleCategoryLongPressEnd}
              draggable
              onDragStart={(event) => handleCategoryDragStart(event, category.id)}
              onDragOver={(event) => handleCategoryDragOver(event, category.id)}
              onDrop={(event) => handleCategoryDrop(event, category.id)}
              onDragEnd={handleCategoryDragEnd}
              title="Drag to reorder (desktop). Long-press for menu (mobile)."
            >
              {category.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setIsCategoryModalOpen(true)}
            className="w-9 h-9 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center shrink-0 hover:border-neutral-600 cursor-pointer"
            title="Create category"
          >
            <Icons.plus className="w-4 h-4" />
          </button>
        </div>
        <ResponsiveMenu
          open={isFilterDropdownOpen}
          onClose={() => setIsFilterDropdownOpen(false)}
          title="Filter chats"
          className="fixed z-[70] w-[220px] rounded-2xl border border-neutral-700 bg-[#181818] shadow-xl p-0"
          style={{ left: `${filterDropdownPosition.x}px`, top: `${filterDropdownPosition.y}px` }}
        >
          <div ref={filterDropdownRef} onClick={(event) => event.stopPropagation()}>
            {[
              { key: "verifiedProfiles", label: "Verified Profiles", icon: BadgeCheck },
              { key: "following", label: "Following", icon: UserCheck },
              { key: "followers", label: "Followers", icon: Users },
              { key: "unanswered", label: "Unanswered", icon: Icons.unansweredDot },
            ].map((option, index, arr) => (
              <button
                key={option.key}
                type="button"
                className={`w-[calc(100%-1rem)] mx-2 flex items-center justify-between gap-3 text-left p-3 rounded-xl text-[15px] text-white hover:bg-neutral-800 cursor-pointer ${
                  index === 0 ? "mt-2" : ""
                } ${index === arr.length - 1 ? "mb-2" : ""}`}
                onClick={() => toggleAdvancedFilter(option.key)}
              >
                  <span className="inline-flex items-center gap-2 font-semibold">
                  <option.icon className="w-6 h-6 text-neutral-100" strokeWidth={2.2} />
                  {option.label}
                </span>
                {advancedFilters[option.key] ? (
                  <span className="w-5 h-5 rounded-md bg-white/95 text-black flex items-center justify-center">
                    <Check className="w-3.5 h-3.5" strokeWidth={3} />
                  </span>
                ) : (
                  <span className="w-5 h-5 rounded-md border border-neutral-600" />
                )}
              </button>
            ))}
          </div>
        </ResponsiveMenu>

        {showSearchResults ? (
          <>
            {/*
              Your own chats first.

              Typing used to replace the entire list with *user* results, so
              there was no way to search the conversations you already have —
              the one thing a search box above a chat list is for. Finding an
              existing thread meant scrolling to it.
            */}
            {matchingChats.length > 0 && (
              <div className="mt-4 space-y-0">
                <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
                  Your chats
                </p>
                {/* role="list" because the rows are role="listitem" — a listitem with
                    no list ancestor is ignored by screen readers. */}
                <div role="list" aria-label="Matching chats">
                {matchingChats.map((item) =>
                  item.type === "chat"
                    ? renderChatResultCard(item.data, item)
                    : renderGroupCard(item.data, item)
                )}
                </div>
              </div>
            )}

            <div className="bg-neutral-950 border border-neutral-800 rounded-lg mt-2 overflow-hidden">
              <div className="p-4 border-b border-neutral-800 flex items-center">
                <Icons.search className="w-5 h-5 mr-2 " strokeColor="#404040" />
                <p className="font-medium mr-1 text-white">
                  {matchingChats.length > 0
                    ? "Other people"
                    : `Search for "${searchQuery}"`}
                </p>
              </div>
              {/*
                Three states, not two. "No users found" used to also stand in for
                "still searching" and for "the request failed", so a slow network and
                a genuine empty result were indistinguishable.
              */}
              {searchPending ? (
                <div className="p-4 text-center text-neutral-500" role="status">
                  <Icons.spinner className="animate-spin mx-auto w-5 h-5" />
                  <span className="sr-only">Searching</span>
                </div>
              ) : filteredUsers.length > 0 ? (
                filteredUsers
                  .slice(0, 5)
                  .map((user) => (
                    renderUserCard(user, () => handleUserSelect(user))
                  ))
              ) : (
                <div className="p-4 text-center text-neutral-400">
                  No users found matching "{searchQuery}"
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {filteredItems.length > 0 ? (
              <div className="mt-4 space-y-0" role="list" aria-label="Conversations">
                {filteredItems.map((item) =>
                  item.type === "chat" ? (
                    renderChatResultCard(item.data, item)
                  ) : (
                    renderGroupCard(item.data, item)
                  )
                )}
              </div>
            ) : !chatLoading && !listPageInfo.hasNextPage ? (
              /*
               * The empty state waits for the pages to run out.
               *
               * A page can be empty while later pages have matches: the Requests tab and
               * the search box filter the fetched page rather than the query, and the
               * Unread view's server-side predicate over-matches by a case the counts
               * then reject. Showing "no conversations" over a list that is still paging
               * is a lie the sentinel would silently correct a moment later.
               */
              renderEmptyState()
            ) : null}

            {/* Fetches the next page as it scrolls into view. */}
            {listPageInfo.hasNextPage && <div ref={listSentinelRef} aria-hidden="true" className="h-1" />}

            {chatLoadingMore && (
              <div className="py-6 text-center text-neutral-500" role="status">
                <Icons.spinner className="animate-spin mx-auto w-6 h-6" />
                <span className="sr-only">Loading more conversations</span>
              </div>
            )}
          </>
        )}

        {/*
          Only when there is nothing to show. The list renders from cache on open,
          so a spinner underneath a populated list is just noise — and it used to
          appear on every tab switch, below rows that were already on screen.
        */}
        {chatLoading && filteredItems.length === 0 && !showSearchResults && (
          <div className="text-center py-10 text-neutral-400">
            <Icons.spinner className="animate-spin mx-auto w-8 h-8" />
          </div>
        )}

        {chatError && (
          <div className="text-center py-10 text-red-400">
            {chatError}
          </div>
        )}
      </main>

      <CreatePost isOpen={isCreateModalOpen} onClose={closeCreateModal} />
      {isCategoryModalOpen && (
        <ResponsiveSheet title="New list" onClose={closeCategorySheet}>
          <div className="p-5">
        {/* Says what will happen, because it isn't obvious that naming a list here
            also files the chat you came from into it. */}
        {pendingListChatName && (
          <p className="mb-3 text-sm text-neutral-400">
            {pendingListChatName} will be added to this list.
          </p>
        )}
        <input
          autoFocus
          type="text"
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createCustomCategory();
          }}
          placeholder="Category name"
          className="w-full rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3 outline-none text-white placeholder-neutral-500"
        />
        <div className="flex items-center gap-2 mt-4">
          <button
            type="button"
            onClick={closeCategorySheet}
            className="w-full rounded-xl border border-neutral-800 bg-neutral-900 text-white py-2.5 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={createCustomCategory}
            className="w-full rounded-xl bg-white text-black py-2.5 font-medium hover:bg-neutral-200"
          >
            Create
          </button>
        </div>
          </div>
        </ResponsiveSheet>
      )}
      {/* Guarded outside the menu too: JSX children are evaluated eagerly, so
          the rows below would dereference a null tabMenu while it's closed. */}
      {tabMenu?.category && (
      <ResponsiveMenu
        open={Boolean(tabMenu?.category)}
        onClose={() => setTabMenu(null)}
        title="Category"
        className="fixed z-[70] w-[220px] rounded-2xl border border-neutral-700 bg-[#181818] shadow-xl p-0"
        style={{ left: `${tabMenu?.x}px`, top: `${tabMenu?.y}px` }}
      >
        <div ref={tabMenuRef} onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 mt-2 flex items-center gap-3 text-left p-3 rounded-xl text-[15px] text-white hover:bg-neutral-800 cursor-pointer"
            onClick={() => reorderCategory("left")}
          >
            <span className="inline-flex items-center gap-2 font-semibold">
              <Icons.arrowLeft className="w-6 h-6 text-white" />
              Move Left
            </span>
          </button>
          <button
            type="button"
            className={`w-[calc(100%-1rem)] mx-2 flex items-center gap-3 text-left p-3 rounded-xl text-[15px] text-white hover:bg-neutral-800 cursor-pointer ${
              tabMenu?.isFixed ? "mb-2" : ""
            }`}
            onClick={() => reorderCategory("right")}
          >
            <span className="inline-flex items-center gap-2 font-semibold">
              <Icons.arrowRight className="w-6 h-6 text-white" />
              Move Right
            </span>
          </button>
          {!tabMenu?.isFixed && (
            <>
              <div className="h-px bg-neutral-700 my-0" />
              <button
                type="button"
                className="w-[calc(100%-1rem)] mx-2 mb-2 mt-2 flex items-center gap-3 text-left p-3 rounded-xl text-[15px] text-red-400 hover:bg-neutral-800 cursor-pointer"
                onClick={requestRemoveCategory}
              >
                <span className="inline-flex items-center gap-2 font-semibold">
                  <Icons.trash className="w-6 h-6 text-red-400" />
                  Delete Tab
                </span>
              </button>
            </>
          )}
        </div>
      </ResponsiveMenu>
      )}
      {activeMenuItem && (
      <ResponsiveMenu
        open={Boolean(activeMenuItem)}
        onClose={() => setChatMenu(null)}
        title="Chat options"
        className="fixed z-[80] w-[260px] max-h-[78vh] overflow-y-auto scrollbar-hide rounded-2xl border border-neutral-700 bg-[#181818] shadow-xl p-0"
        style={{ left: `${chatMenu?.x}px`, top: `${chatMenu?.y}px` }}
      >
        <div data-chat-menu onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 mt-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(activeMenuItem, "unread")}
          >
            <span className="font-semibold text-[15px] text-white">
              Mark as {activeMenuItem.isMarkedUnread ? "read" : "unread"}
            </span>
            <CircleDot className="w-5 h-5 text-white" />
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(activeMenuItem, "mute")}
          >
            <span className="font-semibold text-[15px] text-white">
              {activeMenuItem.isMuted ? "Unmute" : "Mute"}
            </span>
            {activeMenuItem.isMuted ? (
              <Bell className="w-5 h-5 text-white" />
            ) : (
              <BellOff className="w-5 h-5 text-white" />
            )}
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(activeMenuItem, "pin")}
          >
            <span className="font-semibold text-[15px] text-white">
              {activeMenuItem.isPinned ? "Unpin" : "Pin"}
            </span>
            {activeMenuItem.isPinned ? (
              <PinOff className="w-5 h-5 text-white" />
            ) : (
              <Pin className="w-5 h-5 text-white" />
            )}
          </button>
          {/*
            Closes on tap, like every other action here. The toggle is optimistic now,
            so the star on the row underneath has already flipped by the time the menu
            is gone — which is the confirmation, and it doesn't need the menu to stay
            up to deliver it.
          */}
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => {
              toggleFavorite(activeMenuItem);
              setChatMenu(null);
            }}
          >
            <span className="font-semibold text-[15px] text-white">
              {activeMenuItem.isFavorite ? "Remove from Favorites" : "Add to Favorites"}
            </span>
            <Star
              className={`w-5 h-5 ${
                activeMenuItem.isFavorite
                  ? "text-yellow-400 fill-yellow-400"
                  : "text-white"
              }`}
            />
          </button>
          {/*
            Names the list it will remove the chat from.
            "Change list" said nothing about which list the chat was already in, so
            there was no way to tell from the menu whether it was filed at all, or
            where. When it is filed, this is a direct removal — the picker is for
            choosing, and choosing is already done.
          */}
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => {
              if (activeMenuItemListName) {
                setChatMenu(null);
                assignChatToList(activeMenuItem.id, null);
                return;
              }
              setListSheetItem(activeMenuItem);
              setChatMenu(null);
            }}
          >
            <span className="font-semibold text-[15px] text-white text-left">
              {activeMenuItemListName
                ? `Remove from "${activeMenuItemListName}"`
                : "Add to List"}
            </span>
            <FolderOpen className="w-5 h-5 text-white shrink-0" />
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => handleArchiveToggle(activeMenuItem)}
          >
            <span className="font-semibold text-[15px] text-white">
              {activeMenuItem.data?.isArchived ? "Unarchive" : "Archive"}
            </span>
            {activeMenuItem.data?.isArchived ? (
              <ArchiveRestore className="w-5 h-5 text-white" />
            ) : (
              <Archive className="w-5 h-5 text-white" />
            )}
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => {
              // `hasLockPin` comes from the server. This used to test
              // "are any chats locked", which is a different question — unlock
              // everything and it concluded you had no PIN, then silently
              // overwrote the one you had.
              if (!hasLockPin) {
                openPinSetup("set");
                return;
              }
              handleLockToggle(activeMenuItem);
            }}
          >
            <span className="font-semibold text-[15px] text-white">
              {activeMenuItem.isLocked ? "Unlock" : "Lock"}
            </span>
            {activeMenuItem.isLocked ? (
              <LockOpen className="w-5 h-5 text-white" />
            ) : (
              <Lock className="w-5 h-5 text-white" />
            )}
          </button>
          {activeMenuItem.type === "chat" && (
            <button
              type="button"
              className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
              onClick={() => handleBlockToggle(activeMenuItem)}
            >
              {/*
                From BlockContext, not the fetched row. The row's `isBlocked` is a
                snapshot from the last list fetch, so blocking the same account
                anywhere else in the app left this saying "Block user" — and acting
                on that offer used to fail.
              */}
              <span className="font-semibold text-[15px] text-white">
                {isUserBlocked(activeMenuItem.data?.user)
                  ? "Unblock user"
                  : "Block user"}
              </span>
              {isUserBlocked(activeMenuItem.data?.user) ? (
                <UserMinus className="w-5 h-5 text-white" />
              ) : (
                <UserX className="w-5 h-5 text-white" />
              )}
            </button>
          )}
          {/*
            * Hide and Flag used to sit here.
            *
            * Flag returned 400 on every call — the server had no `flag` state
            * and never returned a flagged list — and there was no surface
            * anywhere for looking at flagged chats, so it could not be finished
            * into anything meaningful. Hide persisted but nothing filtered on
            * it, and there was no "hidden" view, so a working version would
            * have made a chat vanish with no way to get it back. Archive
            * already does that job properly and now has a tab.
            *
            * Delete is gone for groups: it showed "Delete this chat?" and
            * quietly called hide. Leaving a group needs an endpoint that
            * doesn't exist yet.
            */}
          {activeMenuItem.type === "chat" && (
            <>
              <div className="h-px bg-neutral-700 my-0" />
              <button
                type="button"
                className="w-[calc(100%-1rem)] mx-2 mb-2 mt-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800 text-red-400"
                onClick={() => handleDeleteItem(activeMenuItem)}
              >
                <span className="font-semibold text-[15px]">Delete</span>
                <Trash2 className="w-5 h-5" />
              </button>
            </>
          )}
        </div>
      </ResponsiveMenu>
      )}

      {/*
        "Add to list" as its own sheet.

        It was a nested scrolling panel inside the already-scrolling options menu,
        which on a phone pushed the list of lists past the bottom of the sheet. A
        separate sheet also gives it a title and a back-out, and means creating a list
        from here can hand the chat over to the naming sheet.
      */}
      {listSheetItem && (
        <ResponsiveSheet
          title={listSheetItem.categoryId ? "Change list" : "Add to list"}
          onClose={() => setListSheetItem(null)}
        >
          <div className="p-2">
            {sortedCustomCategories.length === 0 && (
              <p className="px-3 py-2 text-sm text-neutral-400">
                You don't have any lists yet.
              </p>
            )}
            {sortedCustomCategories.map((category) => {
              const isCurrent = listSheetItem.categoryId === category.id;
              return (
                <button
                  key={category.id}
                  type="button"
                  className="w-full text-left px-3 py-3 rounded-xl hover:bg-neutral-800 text-[15px] text-white flex items-center justify-between gap-3"
                  onClick={() =>
                    assignChatToList(listSheetItem.id, isCurrent ? null : category.id)
                  }
                >
                  <span className="truncate">{category.name}</span>
                  {/* The chat's current list says what tapping it does, rather than
                      just showing a tick and leaving "so does that remove it?" open. */}
                  {isCurrent && (
                    <span className="shrink-0 inline-flex items-center gap-1.5 text-[13px] text-neutral-400">
                      Remove
                      <Check className="w-4 h-4 text-white" />
                    </span>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              className="w-full text-left px-3 py-3 rounded-xl hover:bg-neutral-800 text-[15px] text-white inline-flex items-center gap-2"
              onClick={() => {
                // The chat is remembered here; `createCustomCategory` assigns it once
                // the list exists.
                setPendingListChatId(listSheetItem.id);
                setListSheetItem(null);
                setIsCategoryModalOpen(true);
              }}
            >
              <Plus className="w-4 h-4" />
              Create new list
            </button>
          </div>
        </ResponsiveSheet>
      )}
      {isPinModalOpen && (
        <ResponsiveSheet title="Chat lock" onClose={closePinModal}>
          <div className="p-5">
            <h3 className="text-lg font-semibold mb-3">
              {
                {
                  open: "Enter PIN to open chat",
                  set: "Set a chat lock PIN",
                  change: "Change your PIN",
                  reset: "Reset your PIN",
                }[pinAction] ??
                (pendingLockItem?.isLocked ? "Unlock chat" : "Lock chat")
              }
            </h3>

            <p className="text-sm text-neutral-400 mb-3">
              {pinAction === "reset"
                ? "Confirm your account password. This removes the PIN and unlocks every locked chat."
                : pinAction === "set"
                  ? "4-8 digits. You'll need it to open a locked chat."
                  : "Enter your PIN to continue."}
            </p>

            {/* Changing needs the old PIN; resetting needs the password. */}
            {(pinAction === "change" || pinAction === "reset") && (
              <input
                type="password"
                value={lockPinCurrent}
                onChange={(e) => setLockPinCurrent(e.target.value)}
                placeholder={pinAction === "reset" ? "Account password" : "Current PIN"}
                autoComplete={pinAction === "reset" ? "current-password" : "off"}
                className="w-full rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3 mb-2 outline-none text-white placeholder-neutral-500"
              />
            )}

            {pinAction !== "reset" && (
              <input
                type="password"
                inputMode="numeric"
                value={lockPinInput}
                onChange={(e) => setLockPinInput(e.target.value)}
                placeholder={pinAction === "change" ? "New PIN" : "Enter PIN"}
                className="w-full rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3 outline-none text-white placeholder-neutral-500"
              />
            )}

            <div className="flex items-center gap-2 mt-4">
              <button
                type="button"
                onClick={closePinModal}
                className="w-full rounded-xl border border-neutral-800 bg-neutral-900 text-white py-2.5 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={
                  pinAction === "set" || pinAction === "change" || pinAction === "reset"
                    ? submitPinSetup
                    : submitLockPinAction
                }
                className="w-full rounded-xl bg-white text-black py-2.5 font-medium hover:bg-neutral-200"
              >
                {pinAction === "reset" ? "Remove PIN" : "Confirm"}
              </button>
            </div>

            {/*
              The two escape hatches, offered where they're needed. Without the
              first there was no way to change a PIN at all — `setChatLockPin`
              accepts a `currentPin` and nothing in the UI ever sent one.
            */}
            {(pinAction === "open" || pinAction === "toggle") && (
              <div className="mt-3 flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => openPinSetup("change")}
                  className="w-full text-sm text-neutral-400 hover:text-white"
                >
                  Change your PIN
                </button>
                <button
                  type="button"
                  onClick={() => openPinSetup("reset")}
                  className="w-full text-sm text-neutral-400 hover:text-white"
                >
                  Forgot your PIN?
                </button>
              </div>
            )}
          </div>
        </ResponsiveSheet>
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete your chat with ${
            deleteTarget.data?.user?.name || deleteTarget.data?.user?.username
          }?`}
          confirmLabel="Delete"
          busy={deletingChat}
          onConfirm={confirmDeleteItem}
          onCancel={() => setDeleteTarget(null)}
        >
          The conversation is removed from your list only — they keep their copy.
          Your pin, mute, list and disappearing-message settings for it are cleared.
        </ConfirmDialog>
      )}

      {categoryToDelete && (
        <ConfirmDialog
          title={`Delete the "${categoryToDelete.name}" list?`}
          confirmLabel="Delete"
          busy={deletingCategory}
          onConfirm={confirmRemoveCategory}
          onCancel={() => setCategoryToDelete(null)}
        >
          {(() => {
            const assigned = Object.values(categoryAssignments).filter(
              (id) => id === categoryToDelete.id
            ).length;
            return assigned
              ? `${assigned} chat${assigned === 1 ? "" : "s"} will go back to All. The chats themselves aren't deleted.`
              : "The chats themselves aren't deleted.";
          })()}
        </ConfirmDialog>
      )}

      {!embedded && <MobileNavbar layoutContext={layoutContext} />}
    </div>
  );
};

export default ChatPage;
