import React, {
  useContext,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  BadgeCheck,
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  CircleDot,
  Check,
  Eye,
  EyeOff,
  Flag,
  FlagOff,
  FolderOpen,
  Inbox,
  Lock,
  LockOpen,
  MessageCircle,
  Pin,
  PinOff,
  Plus,
  Star,
  Trash2,
  UserCheck,
  UserMinus,
  UserX,
  Users,
} from "lucide-react";
import { UserContext } from "../contexts/UserContext";
import { useChat } from "../contexts/ChatContext";
import axios from "axios";
// import { io } from "socket.io-client"; // Removed, handled by SocketContext
import { useNavigate } from "react-router-dom";
import SiteHeader from "../components/layouts/site-header";
import MobileNavbar from "../components/layouts/mobile-navbar";
import { Icons } from "../components/icons";
import CreatePost from "../components/CreatePost";
import Modal from "react-modal";

Modal.setAppElement("#root");

const ChatPage = ({ embedded = false }) => {
  const { userAuth } = useContext(UserContext);
  const {
    conversations: chats,
    loading: chatLoading,
    error: chatError,
    onlineUsers,
    unreadCounts,
    actions: { loadConversations },
  } = useChat();

  const [filteredUsers, setFilteredUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState("all");
  const [customCategories, setCustomCategories] = useState([]);
  const [categoryAssignments, setCategoryAssignments] = useState({});
  const [favoriteChats, setFavoriteChats] = useState([]);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [isAssignCategoryModalOpen, setIsAssignCategoryModalOpen] = useState(false);
  const [selectedItemForCategory, setSelectedItemForCategory] = useState(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
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
  const [chatLongPressTimer, setChatLongPressTimer] = useState(null);
  const [showListSubmenu, setShowListSubmenu] = useState(false);
  const [lockPinInput, setLockPinInput] = useState("");
  const [isPinModalOpen, setIsPinModalOpen] = useState(false);
  const [pendingLockItem, setPendingLockItem] = useState(null);
  const [pinAction, setPinAction] = useState("toggle");
  const [mutedChats, setMutedChats] = useState([]);
  const [pinnedChats, setPinnedChats] = useState([]);
  const [hiddenChats, setHiddenChats] = useState([]);
  const [flaggedChats, setFlaggedChats] = useState([]);
  const [lockedChats, setLockedChats] = useState([]);
  const [manualUnreadChats, setManualUnreadChats] = useState([]);
  const [forcedReadChats, setForcedReadChats] = useState([]);
  const [builtInTabs, setBuiltInTabs] = useState([
    { id: "all", label: "All" },
    { id: "requests", label: "Requests" },
    { id: "groups", label: "Groups" },
    { id: "unread", label: "Unread" },
    { id: "favorites", label: "Favorites" },
  ]);
  const navigate = useNavigate();
  const searchTimeoutRef = useRef(null);
  const tabLongPressTimerRef = useRef(null);
  const filterTriggerRef = useRef(null);
  const filterDropdownRef = useRef(null);
  const filterButtonRef = useRef(null);
  const tabMenuRef = useRef(null);

  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);
  const layoutContext = { openCreateModal, closeCreateModal };

  const loadChatPreferences = useCallback(async () => {
    if (!userAuth?.token) return;
    try {
      const response = await axios.get(`${import.meta.env.VITE_SERVER}/chats/preferences`, {
        headers: { Authorization: `Bearer ${userAuth.token}` },
      });
      setCustomCategories(Array.isArray(response.data?.categories) ? response.data.categories : []);
      setCategoryAssignments(
        response.data?.categoryAssignments && typeof response.data.categoryAssignments === "object"
          ? response.data.categoryAssignments
          : {}
      );
      setFavoriteChats(Array.isArray(response.data?.favoriteChats) ? response.data.favoriteChats : []);
      setMutedChats(Array.isArray(response.data?.mutedChats) ? response.data.mutedChats : []);
      setPinnedChats(Array.isArray(response.data?.pinnedChats) ? response.data.pinnedChats : []);
      setHiddenChats(Array.isArray(response.data?.hiddenChats) ? response.data.hiddenChats : []);
      setFlaggedChats(Array.isArray(response.data?.flaggedChats) ? response.data.flaggedChats : []);
      setLockedChats(Array.isArray(response.data?.lockedChats) ? response.data.lockedChats : []);
      setManualUnreadChats(
        Array.isArray(response.data?.manualUnreadChats) ? response.data.manualUnreadChats : []
      );
      setForcedReadChats(
        Array.isArray(response.data?.forcedReadChats) ? response.data.forcedReadChats : []
      );
    } catch (prefError) {
      console.error("Error loading chat preferences:", prefError);
      setCustomCategories([]);
      setCategoryAssignments({});
      setFavoriteChats([]);
      setMutedChats([]);
      setPinnedChats([]);
      setHiddenChats([]);
      setFlaggedChats([]);
      setLockedChats([]);
      setManualUnreadChats([]);
      setForcedReadChats([]);
    }
  }, [userAuth?.token]);

  const getConversationParamsForFilter = useCallback((filter) => {
    if (filter === "all") return { view: "all" };
    if (filter === "requests") return { view: "requests" };
    if (filter === "groups") return { view: "groups" };
    if (filter === "unread") return { view: "unread" };
    if (filter === "favorites") return { view: "favorites" };
    if (filter.startsWith("category:")) {
      return {
        view: "category",
        categoryId: filter.replace("category:", ""),
      };
    }
    return { view: "all" };
  }, []);

  useEffect(() => {
    if (!userAuth?.token) return;
    loadChatPreferences();
  }, [userAuth?.token, loadChatPreferences]);

  useEffect(() => {
    if (!userAuth?.token) return;
    loadConversations(getConversationParamsForFilter(activeFilter));
  }, [userAuth?.token, activeFilter, loadConversations, getConversationParamsForFilter]);

  // fetchChats removed - handled by ChatContext

  // fetchUnreadCounts removed - handled by ChatContext

  const searchUsers = async (query) => {
    if (!query.trim()) {
      setFilteredUsers([]);
      setShowSearchResults(false);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await axios.get(
        `${import.meta.env.VITE_SERVER}/user/search?q=${encodeURIComponent(query)}`,
        {
          headers: { Authorization: `Bearer ${userAuth.token}` },
        }
      );
      setFilteredUsers(response.data.users || []);
      setShowSearchResults(true);
    } catch (error) {
      console.error("Error searching users:", error);
      setFilteredUsers([]);
      setShowSearchResults(true);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSearchChange = (e) => {
    const query = e.target.value;
    setSearchQuery(query);

    // Clear previous timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (query.trim() === "") {
      setShowSearchResults(false);
      setFilteredUsers([]);
      return;
    }

    // Set new timeout for debouncing
    searchTimeoutRef.current = setTimeout(() => {
      searchUsers(query);
    }, 300);
  };

  // handleNewMessage removed - handled by ChatContext

  // handleNewGroupMessage removed - to be handled by ChatContext
  // fetchUserById removed - unused

  const handleUserSelect = (user) => {
    navigate(`/chat/${user.username}`);
  };

  // const handleGroupSelect = (group) => {
  //   navigate(`/group/${group._id}`);
  // };

  const handleStartConversation = () => {
    const searchInput = document.querySelector(
      'input[placeholder="Search users to chat"]'
    );
    if (searchInput) {
      searchInput.focus();
    }
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
        const byId = new Map(
          [
            { id: "all", label: "All" },
            { id: "requests", label: "Requests" },
            { id: "groups", label: "Groups" },
            { id: "unread", label: "Unread" },
            { id: "favorites", label: "Favorites" },
          ].map((item) => [item.id, item])
        );
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
    const date = new Date(dateString);
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

  const getMessagePreview = (message) => {
    if (!message) return "";

    if (message.isDeleted) return "This message was deleted";
    if (message.messageType === "media") {
      const mediaType = message.media?.[0]?.type;
      return mediaType === "video" ? "Sent a video" : "Sent a photo";
    }
    if (message.messageType === "voice") return "Sent a voice message";
    if (message.messageType === "gif") return "Sent a gif";
    if (message.messageType === "poll") return "Sent a poll";
    if (message.messageType === "sticker") return "Sent a sticker";

    return message.content || "Sent a message";
  };

  const chatItems = useMemo(
    () =>
      chats.map((chat) => ({
        type: chat.isGroup ? "group" : "chat",
        key: chat.id,
        id: chat.id,
        timestamp: new Date(chat.latestMessage?.createdAt || chat.updatedAt || 0).getTime(),
        unreadCount: chat.unreadCount || (!chat.isGroup && unreadCounts[chat.user?._id]) || 0,
        isFavorite: Boolean(chat.isFavorite) || favoriteChats.includes(chat.id),
        isMuted: Boolean(chat.isMuted) || mutedChats.includes(chat.id),
        isPinned: Boolean(chat.isPinned) || pinnedChats.includes(chat.id),
        isHidden: Boolean(chat.isHidden) || hiddenChats.includes(chat.id),
        isFlagged: Boolean(chat.isFlagged) || flaggedChats.includes(chat.id),
        isLocked: Boolean(chat.isLocked) || lockedChats.includes(chat.id),
        isMarkedUnread:
          manualUnreadChats.includes(chat.id) ||
          ((chat.unreadCount || 0) > 0 && !forcedReadChats.includes(chat.id)),
        categoryId: chat.categoryId || categoryAssignments[chat.id] || null,
        data: chat,
      })),
    [
      chats,
      unreadCounts,
      favoriteChats,
      mutedChats,
      pinnedChats,
      hiddenChats,
      flaggedChats,
      lockedChats,
      manualUnreadChats,
      forcedReadChats,
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

  const filteredItems = useMemo(() => {
    let items = sortedItems;
    if (activeFilter === "all") items = sortedItems;
    if (activeFilter === "groups") return groupItems;
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

  const toggleAdvancedFilter = (key) => {
    setAdvancedFilters((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

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
      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}/chats/preferences/categories`,
        { name },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      const createdCategory = (response.data?.categories || []).find(
        (category) => category.name.toLowerCase() === name.toLowerCase()
      );
      await loadChatPreferences();
      if (createdCategory?.id) {
        setActiveFilter(`category:${createdCategory.id}`);
      }
      setNewCategoryName("");
      setIsCategoryModalOpen(false);
    } catch (createError) {
      console.error("Error creating category:", createError);
    }
  };

  const saveCategoryAssignment = async () => {
    if (!selectedItemForCategory) return;
    try {
      await axios.put(
        `${import.meta.env.VITE_SERVER}/chats/preferences/assignments/${encodeURIComponent(selectedItemForCategory.key)}`,
        { categoryId: selectedCategoryId || null },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      await loadChatPreferences();
      if (activeFilter.startsWith("category:")) {
        loadConversations(getConversationParamsForFilter(activeFilter));
      }
      setIsAssignCategoryModalOpen(false);
      setSelectedItemForCategory(null);
      setSelectedCategoryId("");
    } catch (assignError) {
      console.error("Error assigning category:", assignError);
    }
  };

  const toggleFavorite = async (item) => {
    try {
      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}/chats/preferences/favorites/${encodeURIComponent(item.key)}/toggle`,
        {},
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      const nextFavorites = Array.isArray(response.data?.favoriteChats)
        ? response.data.favoriteChats
        : [];
      setFavoriteChats(nextFavorites);
      if (activeFilter === "favorites") {
        loadConversations(getConversationParamsForFilter(activeFilter));
      }
    } catch (favError) {
      console.error("Error toggling favorite chat:", favError);
    }
  };

  const syncPreferenceStateFromResponse = (responseData) => {
    if (Array.isArray(responseData?.favoriteChats)) setFavoriteChats(responseData.favoriteChats);
    if (Array.isArray(responseData?.mutedChats)) setMutedChats(responseData.mutedChats);
    if (Array.isArray(responseData?.pinnedChats)) setPinnedChats(responseData.pinnedChats);
    if (Array.isArray(responseData?.hiddenChats)) setHiddenChats(responseData.hiddenChats);
    if (Array.isArray(responseData?.flaggedChats)) setFlaggedChats(responseData.flaggedChats);
    if (Array.isArray(responseData?.lockedChats)) setLockedChats(responseData.lockedChats);
    if (Array.isArray(responseData?.manualUnreadChats)) {
      setManualUnreadChats(responseData.manualUnreadChats);
    }
    if (Array.isArray(responseData?.forcedReadChats)) {
      setForcedReadChats(responseData.forcedReadChats);
    }
  };

  const updateItemState = async (item, stateKey, nextState, pin = "") => {
    try {
      const response = await axios.put(
        `${import.meta.env.VITE_SERVER}/chats/preferences/state/${encodeURIComponent(item.id)}`,
        { stateKey, nextState, pin },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      syncPreferenceStateFromResponse(response.data);
      loadConversations(getConversationParamsForFilter(activeFilter));
      return response.data;
    } catch (error) {
      console.error(`Error updating ${stateKey}:`, error);
      throw error;
    }
  };

  const handleArchiveToggle = async (item) => {
    try {
      const chatId = item.id;
      await axios.post(
        `${import.meta.env.VITE_SERVER}/chats/${encodeURIComponent(chatId)}/archive`,
        { archive: !item.data?.isArchived },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      loadConversations(getConversationParamsForFilter(activeFilter));
    } catch (error) {
      console.error("Error toggling archive:", error);
    }
  };

  const handleBlockToggle = async (item) => {
    if (item.type !== "chat") return;
    const username = item.data?.user?.username;
    if (!username) return;
    const isBlocked = Boolean(item.data?.user?.isBlocked);
    const route = isBlocked ? "unblock" : "block";
    try {
      await axios.post(
        `${import.meta.env.VITE_SERVER}/user/${route}/${encodeURIComponent(username)}`,
        {},
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      loadConversations(getConversationParamsForFilter(activeFilter));
      setChatMenu(null);
    } catch (error) {
      console.error("Error toggling block:", error);
    }
  };

  const handleDeleteItem = async (item) => {
    if (!window.confirm("Delete this chat?")) return;
    try {
      if (item.type === "chat") {
        await axios.delete(
          `${import.meta.env.VITE_SERVER}/chats/${encodeURIComponent(item.data?.user?.username)}`,
          { headers: { Authorization: `Bearer ${userAuth.token}` } }
        );
      } else {
        await updateItemState(item, "hide", true);
      }
      loadConversations(getConversationParamsForFilter(activeFilter));
      setChatMenu(null);
    } catch (error) {
      console.error("Error deleting item:", error);
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
    setShowListSubmenu(false);
  };

  const handleChatLongPressStart = (event, item) => {
    const touch = event.touches?.[0];
    const rect = event.currentTarget?.getBoundingClientRect?.();
    const menuWidth = 260;
    const estimatedMenuHeight = 560;
    const viewportHeight = window.innerHeight || 800;
    const timer = setTimeout(() => {
      const preferredY = (rect?.bottom || touch?.clientY || 24) + 8;
      const maxY = Math.max(12, viewportHeight - estimatedMenuHeight - 12);
      setChatMenu({
        item,
        x: rect ? Math.max(12, rect.right - menuWidth) : touch?.clientX || 24,
        y: Math.min(preferredY, maxY),
      });
      setShowListSubmenu(false);
    }, 450);
    setChatLongPressTimer(timer);
  };

  const handleChatLongPressEnd = () => {
    if (chatLongPressTimer) {
      clearTimeout(chatLongPressTimer);
      setChatLongPressTimer(null);
    }
  };

  const runToggleAction = async (item, stateKey) => {
    const current =
      stateKey === "mute"
        ? item.isMuted
        : stateKey === "pin"
          ? item.isPinned
          : stateKey === "hide"
            ? item.isHidden
            : stateKey === "flag"
              ? item.isFlagged
              : stateKey === "unread"
                ? item.isMarkedUnread
                : false;
    await updateItemState(item, stateKey, !current);
    setChatMenu(null);
  };

  const handleLockToggle = async (item) => {
    setPendingLockItem(item);
    setPinAction("toggle");
    setLockPinInput("");
    setIsPinModalOpen(true);
  };

  const submitLockPinAction = async () => {
    if (!pendingLockItem) return;
    const nextState =
      pinAction === "open" ? pendingLockItem.isLocked : !pendingLockItem.isLocked;
    try {
      await updateItemState(pendingLockItem, "lock", nextState, lockPinInput);
      if (pinAction === "open") {
        if (pendingLockItem.type === "group") {
          navigate(`/group/${pendingLockItem.data?.group?._id}`);
        } else {
          navigate(`/chat/${pendingLockItem.data?.user?.username}`);
        }
      }
      setIsPinModalOpen(false);
      setPendingLockItem(null);
      setChatMenu(null);
      setLockPinInput("");
      setPinAction("toggle");
    } catch {
      alert("Invalid PIN or failed to update lock state.");
    }
  };

  const promptSetPinIfMissing = async () => {
    const pin = window.prompt("Set chat lock PIN (4-8 digits)");
    if (!pin) return;
    try {
      await axios.put(
        `${import.meta.env.VITE_SERVER}/chats/preferences/lock-pin`,
        { pin },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      alert("PIN set successfully.");
    } catch {
      alert("Failed to set PIN.");
    }
  };

  const ChatResultCard = ({ chat, item }) => {
    const isOnline = onlineUsers.has(chat.user._id.toString());
    const unreadCount = item.unreadCount || unreadCounts[chat.user._id] || 0;

    const myId = String(userAuth?.id || userAuth?._id || "");
    const latestMsg = chat.latestMessage;
    const senderId = String(latestMsg?.sender?._id || latestMsg?.sender || "");
    const isSentByMe = myId && senderId && senderId === myId;

    let previewText;
    let showTimestamp = true;

    if (unreadCount >= 1) {
      previewText = `${unreadCount} new message${unreadCount > 1 ? "s" : ""}`;
    } else if (isSentByMe) {
      const isSeen = latestMsg?.status === "read";
      previewText = formatSentTime(latestMsg?.createdAt, isSeen ? "Seen" : "Sent");
      showTimestamp = false;
    } else {
      previewText = getMessagePreview(latestMsg);
    }

    const previewTime = showTimestamp ? formatMessageTime(latestMsg?.createdAt) : null;

    const handleCardClick = () => {
      if (item.isMarkedUnread) {
        updateItemState(item, "read", true).catch((error) =>
          console.error("Error marking chat read on open:", error)
        );
      }
      if (item.isLocked) {
        setPendingLockItem(item);
        setPinAction("open");
        setLockPinInput("");
        setIsPinModalOpen(true);
        return;
      }
      navigate(`/chat/${chat.user.username}`);
    };

    return (
      <div
        className="text-white w-full px-3 py-3 cursor-pointer hover:bg-neutral-900 transition-colors"
        onClick={handleCardClick}
        onContextMenu={(event) => openChatMenu(event, item)}
        onTouchStart={(event) => handleChatLongPressStart(event, item)}
        onTouchEnd={handleChatLongPressEnd}
        onTouchMove={handleChatLongPressEnd}
      >
        <div className="flex gap-3">
          <div className="cursor-pointer relative">
            <img
              className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
              src={chat.user.profilePic || "/default-avatar.png"}
              alt="Profile"
            />
            {isOnline && (
              <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-black"></div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-row justify-between items-center">
              <div className="cursor-pointer flex-1 min-w-0">
                <p className="text-white font-medium line-clamp-1 flex items-center">
                  {chat.user.name || chat.user.username}
                  {chat.user.isVerified && (
                    <span className="pl-1 pt-0.5 inline-flex items-center">
                      <Icons.verified />
                    </span>
                  )}
                  {item.isPinned && (
                    <span className="pl-1 inline-flex items-center">
                      <Pin className="w-3.5 h-3.5 text-neutral-300" />
                    </span>
                  )}
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
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-4">
                  {unreadCount > 0 && (
                    <span className="w-2 h-2 rounded-full bg-blue-700 mr-1" />
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openChatMenu(e, item);
                    }}
                    className="w-6 h-6 rounded-full flex items-center justify-center text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors leading-none"
                    title="Chat actions"
                  >
                    ⋮
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const GroupCard = ({ conversation, item }) => {
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

    if (unreadCount >= 1) {
      previewText = `${unreadCount} new message${unreadCount > 1 ? "s" : ""}`;
    } else if (isSentByMe) {
      const isSeen = lastMessage?.status === "read";
      previewText = formatSentTime(lastMessage?.createdAt, isSeen ? "Seen" : "Sent");
      showTimestamp = false;
    } else {
      previewText = getMessagePreview(lastMessage);
    }

    const previewTime = showTimestamp ? formatMessageTime(lastMessage?.createdAt) : null;

    const handleCardClick = () => {
      if (item.isMarkedUnread) {
        updateItemState(item, "read", true).catch((error) =>
          console.error("Error marking group chat read on open:", error)
        );
      }
      if (item.isLocked) {
        setPendingLockItem(item);
        setPinAction("open");
        setLockPinInput("");
        setIsPinModalOpen(true);
        return;
      }
      navigate(`/group/${group._id}`);
    };

    return (
      <div
        className="text-white w-full px-3 py-3 cursor-pointer hover:bg-neutral-900 transition-colors"
        onClick={handleCardClick}
        onContextMenu={(event) => openChatMenu(event, item)}
        onTouchStart={(event) => handleChatLongPressStart(event, item)}
        onTouchEnd={handleChatLongPressEnd}
        onTouchMove={handleChatLongPressEnd}
      >
        <div className="flex gap-3">
          <div className="cursor-pointer">
            <img
              className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
              src={group.avatar || "/default-group-avatar.png"}
              alt="Group"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-row justify-between items-center">
              <div className="cursor-pointer flex-1 min-w-0">
                <p className="text-white font-medium line-clamp-1">
                  {group.name}
                  {item.isPinned && (
                    <span className="pl-1 inline-flex items-center align-middle">
                      <Pin className="w-3.5 h-3.5 text-neutral-300" />
                    </span>
                  )}
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
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-4">
                  {unreadCount > 0 && (
                    <span className="w-2 h-2 rounded-full bg-blue-700 mr-1" />
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openChatMenu(e, item);
                    }}
                    className="w-6 h-6 rounded-full flex items-center justify-center text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors leading-none"
                    title="Chat actions"
                  >
                    ⋮
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const UserCard = ({ user, onClick }) => (
    <div
      key={user._id}
      className="text-white w-full border-b border-neutral-800 px-3 py-3 cursor-pointer hover:bg-neutral-900 transition-colors"
      onClick={onClick}
    >
      <div className="flex gap-3">
        <div className="cursor-pointer relative">
          <img
            className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
            src={user.profilePic || "/default-avatar.png"}
            alt="Profile"
          />
          {onlineUsers.has(user._id.toString()) && (
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-black"></div>
          )}
        </div>
        <div className="flex-1">
          <div className="flex flex-row justify-start items-center relative">
            <div className="cursor-pointer">
              <p className="text-white font-medium line-clamp-1 flex items-center hover:underline">
                {user.name || user.username}
                {user.isVerified && (
                  <span className="pl-1 pt-0.5 inline-flex items-center">
                    <Icons.verified />
                  </span>
                )}
              </p>
              <p className="text-neutral-500">{user.username}</p>
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

  const EmptyState = () => {
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
      await axios.put(
        `${import.meta.env.VITE_SERVER}/chats/preferences/categories/reorder`,
        { orderedCategoryIds: next.map((item) => item.id) },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
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
        await axios.put(
          `${import.meta.env.VITE_SERVER}/chats/preferences/categories/reorder`,
          { orderedCategoryIds: next.map((item) => item.id) },
          { headers: { Authorization: `Bearer ${userAuth.token}` } }
        );
        await loadChatPreferences();
      } catch (reorderError) {
        console.error("Error drag-reordering categories:", reorderError);
      }
    },
    [sortedCustomCategories, userAuth?.token, loadChatPreferences]
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

  const removeCategory = async () => {
    if (!tabMenu?.category) return;
    try {
      await axios.delete(
        `${import.meta.env.VITE_SERVER}/chats/preferences/categories/${tabMenu.category.id}`,
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );
      await loadChatPreferences();
      if (activeFilter === `category:${tabMenu.category.id}`) {
        setActiveFilter("all");
      }
    } catch (deleteError) {
      console.error("Error deleting category:", deleteError);
    } finally {
      setTabMenu(null);
    }
  };

  if (!userAuth?.token) return <div>Please log in to chat.</div>;

  return (
    <div className={embedded ? "h-full flex flex-col bg-neutral-950 overflow-hidden" : "w-full bg-neutral-950 min-h-screen"}>
      {!embedded && <SiteHeader layoutContext={layoutContext} />}
      <main className={embedded ? "flex-1 overflow-y-auto px-4 py-4 min-h-0" : "container max-w-[620px] px-4 sm:px-6 bg-neutral-950 mx-auto py-4"}>
        {/* Search Bar */}
        <div className="flex justify-center items-center relative">
          <input
            className="border border-neutral-800 rounded-xl outline-0 flex items-center justify-center w-full mx-auto py-3 sm:py-5 px-12 mt-4 bg-neutral-950 text-white placeholder-neutral-500"
            placeholder="Search users to chat"
            value={searchQuery}
            onChange={handleSearchChange}
          />
          <Icons.search
            className="absolute left-0 ml-4 mt-4 w-5 h-5 "
            strokeColor="#404040"
          />
          {searchLoading && (
            <Icons.spinner className="absolute right-0 mr-4 mt-4 w-5 h-5 animate-spin text-neutral-500" />
          )}
        </div>

        {/* Instagram-like rounded DM filters */}
        <div className="flex items-center gap-2 mt-6 overflow-x-auto scrollbar-hide pb-1">
          <div ref={filterTriggerRef} className="relative shrink-0">
            <button
              ref={filterButtonRef}
              type="button"
              className="h-9 px-3 rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-center cursor-pointer"
              title="Filters"
              onClick={toggleFilterDropdown}
            >
              <div className="flex items-center gap-0.5">
                <Icons.filter className="w-4 h-4" />
                <Icons.chevronbottom className="w-3 h-3" />
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
        {isFilterDropdownOpen && (
          <div
            ref={filterDropdownRef}
            className="fixed z-[70] w-[220px] rounded-2xl border border-neutral-700 bg-[#181818] shadow-xl p-0"
            style={{ left: `${filterDropdownPosition.x}px`, top: `${filterDropdownPosition.y}px` }}
            onClick={(event) => event.stopPropagation()}
          >
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
        )}

        {showSearchResults ? (
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg mt-2 overflow-hidden">
            <div className="p-4 border-b border-neutral-800 flex items-center">
              <Icons.search className="w-5 h-5 mr-2 " strokeColor="#404040" />
              <p className="font-medium mr-1 text-white">
                Search for "{searchQuery}"
              </p>
            </div>
            {filteredUsers.length > 0 ? (
              filteredUsers
                .slice(0, 5)
                .map((user) => (
                  <UserCard
                    key={user._id}
                    user={user}
                    onClick={() => handleUserSelect(user)}
                  />
                ))
            ) : (
              <div className="p-4 text-center text-neutral-400">
                No users found matching "{searchQuery}"
              </div>
            )}
          </div>
        ) : searchQuery === "" ? (
          <>
            {filteredItems.length > 0 ? (
              <div className="mt-4 space-y-0">
                {filteredItems.map((item) =>
                  item.type === "chat" ? (
                    <ChatResultCard
                      key={item.key}
                      chat={item.data}
                      item={item}
                    />
                  ) : (
                    <GroupCard
                      key={item.key}
                      conversation={item.data}
                      item={item}
                    />
                  )
                )}
              </div>
            ) : !chatLoading ? (
              <EmptyState />
            ) : null}
          </>
        ) : null}

        {chatLoading && (
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
      <Modal
        isOpen={isCategoryModalOpen}
        onRequestClose={() => {
          setIsCategoryModalOpen(false);
          setNewCategoryName("");
        }}
        className="bg-neutral-950 text-white border border-neutral-800 rounded-2xl max-w-sm w-full mx-4 p-5 outline-none"
        overlayClassName="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Create category</h3>
          <button
            type="button"
            className="text-neutral-400 hover:text-white"
            onClick={() => {
              setIsCategoryModalOpen(false);
              setNewCategoryName("");
            }}
          >
            <Icons.close className="w-5 h-5" />
          </button>
        </div>
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
            onClick={() => {
              setIsCategoryModalOpen(false);
              setNewCategoryName("");
            }}
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
      </Modal>
      <Modal
        isOpen={isAssignCategoryModalOpen}
        onRequestClose={() => {
          setIsAssignCategoryModalOpen(false);
          setSelectedItemForCategory(null);
          setSelectedCategoryId("");
        }}
        className="bg-neutral-950 text-white border border-neutral-800 rounded-2xl max-w-sm w-full mx-4 p-5 outline-none"
        overlayClassName="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Move to category</h3>
          <button
            type="button"
            className="text-neutral-400 hover:text-white"
            onClick={() => {
              setIsAssignCategoryModalOpen(false);
              setSelectedItemForCategory(null);
              setSelectedCategoryId("");
            }}
          >
            <Icons.close className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2 max-h-56 overflow-y-auto">
          <button
            type="button"
            onClick={() => setSelectedCategoryId("")}
            className={`w-full rounded-xl border px-4 py-2 text-left ${
              selectedCategoryId === ""
                ? "bg-white text-black border-white"
                : "bg-neutral-900 text-white border-neutral-800"
            }`}
          >
            None (remove category)
          </button>
          {sortedCustomCategories.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => setSelectedCategoryId(category.id)}
              className={`w-full rounded-xl border px-4 py-2 text-left ${
                selectedCategoryId === category.id
                  ? "bg-white text-black border-white"
                  : "bg-neutral-900 text-white border-neutral-800"
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 mt-4">
          <button
            type="button"
            onClick={() => {
              setIsAssignCategoryModalOpen(false);
              setSelectedItemForCategory(null);
              setSelectedCategoryId("");
            }}
            className="w-full rounded-xl border border-neutral-800 bg-neutral-900 text-white py-2.5 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={saveCategoryAssignment}
            className="w-full rounded-xl bg-white text-black py-2.5 font-medium hover:bg-neutral-200"
          >
            Save
          </button>
        </div>
      </Modal>
      {tabMenu?.category && (
        <div
          ref={tabMenuRef}
          className="fixed z-[70] w-[220px] rounded-2xl border border-neutral-700 bg-[#181818] shadow-xl p-0"
          style={{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
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
                onClick={removeCategory}
              >
                <span className="inline-flex items-center gap-2 font-semibold">
                  <Icons.trash className="w-6 h-6 text-red-400" />
                  Delete Tab
                </span>
              </button>
            </>
          )}
        </div>
      )}
      {chatMenu?.item && (
        <div
          data-chat-menu
          className="fixed z-[80] w-[260px] max-h-[78vh] overflow-y-auto scrollbar-hide rounded-2xl border border-neutral-700 bg-[#181818] shadow-xl p-0"
          style={{ left: `${chatMenu.x}px`, top: `${chatMenu.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 mt-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(chatMenu.item, "unread")}
          >
            <span className="font-semibold text-[15px] text-white">
              Mark as {chatMenu.item.isMarkedUnread ? "read" : "unread"}
            </span>
            <CircleDot className="w-5 h-5 text-white" />
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(chatMenu.item, "mute")}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.isMuted ? "Unmute" : "Mute"}
            </span>
            {chatMenu.item.isMuted ? (
              <Bell className="w-5 h-5 text-white" />
            ) : (
              <BellOff className="w-5 h-5 text-white" />
            )}
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(chatMenu.item, "pin")}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.isPinned ? "Unpin" : "Pin"}
            </span>
            {chatMenu.item.isPinned ? (
              <PinOff className="w-5 h-5 text-white" />
            ) : (
              <Pin className="w-5 h-5 text-white" />
            )}
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={async () => {
              await toggleFavorite(chatMenu.item);
              setChatMenu(null);
            }}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.isFavorite ? "Remove from Favorites" : "Add to Favorites"}
            </span>
            <Star className="w-5 h-5 text-white" />
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => setShowListSubmenu((prev) => !prev)}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.categoryId ? "Remove from List" : "Add to List"}
            </span>
            <FolderOpen className="w-5 h-5 text-white" />
          </button>
          {showListSubmenu && (
            <div className="w-[calc(100%-1rem)] mx-2 mb-1 rounded-xl border border-neutral-700 p-2">
              {sortedCustomCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className="w-full text-left p-2 rounded-lg hover:bg-neutral-800 text-sm text-white"
                  onClick={async () => {
                    await axios.put(
                      `${import.meta.env.VITE_SERVER}/chats/preferences/assignments/${encodeURIComponent(chatMenu.item.id)}`,
                      { categoryId: category.id },
                      { headers: { Authorization: `Bearer ${userAuth.token}` } }
                    );
                    await loadChatPreferences();
                    setShowListSubmenu(false);
                    setChatMenu(null);
                    loadConversations(getConversationParamsForFilter(activeFilter));
                  }}
                >
                  {category.name}
                </button>
              ))}
              <button
                type="button"
                className="w-full text-left p-2 rounded-lg hover:bg-neutral-800 text-sm text-white inline-flex items-center gap-2"
                onClick={() => {
                  setIsCategoryModalOpen(true);
                  setShowListSubmenu(false);
                  setChatMenu(null);
                }}
              >
                <Plus className="w-4 h-4" />
                Create new list
              </button>
              {chatMenu.item.categoryId && (
                <button
                  type="button"
                  className="w-full text-left p-2 rounded-lg hover:bg-neutral-800 text-sm text-neutral-300"
                  onClick={async () => {
                    await axios.put(
                      `${import.meta.env.VITE_SERVER}/chats/preferences/assignments/${encodeURIComponent(chatMenu.item.id)}`,
                      { categoryId: null },
                      { headers: { Authorization: `Bearer ${userAuth.token}` } }
                    );
                    await loadChatPreferences();
                    setShowListSubmenu(false);
                    setChatMenu(null);
                  }}
                >
                  Remove from current list
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => handleArchiveToggle(chatMenu.item)}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.data?.isArchived ? "Unarchive" : "Archive"}
            </span>
            {chatMenu.item.data?.isArchived ? (
              <ArchiveRestore className="w-5 h-5 text-white" />
            ) : (
              <Archive className="w-5 h-5 text-white" />
            )}
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={async () => {
              if (!lockedChats.length) {
                await promptSetPinIfMissing();
              }
              handleLockToggle(chatMenu.item);
            }}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.isLocked ? "Unlock" : "Lock"}
            </span>
            {chatMenu.item.isLocked ? (
              <LockOpen className="w-5 h-5 text-white" />
            ) : (
              <Lock className="w-5 h-5 text-white" />
            )}
          </button>
          {chatMenu.item.type === "chat" && (
            <button
              type="button"
              className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
              onClick={() => handleBlockToggle(chatMenu.item)}
            >
              <span className="font-semibold text-[15px] text-white">
                {chatMenu.item.data?.user?.isBlocked ? "Unblock user" : "Block user"}
              </span>
              {chatMenu.item.data?.user?.isBlocked ? (
                <UserMinus className="w-5 h-5 text-white" />
              ) : (
                <UserX className="w-5 h-5 text-white" />
              )}
            </button>
          )}
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(chatMenu.item, "hide")}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.isHidden ? "Unhide" : "Hide"}
            </span>
            {chatMenu.item.isHidden ? (
              <Eye className="w-5 h-5 text-white" />
            ) : (
              <EyeOff className="w-5 h-5 text-white" />
            )}
          </button>
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800"
            onClick={() => runToggleAction(chatMenu.item, "flag")}
          >
            <span className="font-semibold text-[15px] text-white">
              {chatMenu.item.isFlagged ? "Unflag" : "Flag"}
            </span>
            {chatMenu.item.isFlagged ? (
              <FlagOff className="w-5 h-5 text-white" />
            ) : (
              <Flag className="w-5 h-5 text-white" />
            )}
          </button>
          <div className="h-px bg-neutral-700 my-0" />
          <button
            type="button"
            className="w-[calc(100%-1rem)] mx-2 mb-2 mt-2 flex justify-between items-center p-3 rounded-xl cursor-pointer hover:bg-neutral-800 text-red-400"
            onClick={() => handleDeleteItem(chatMenu.item)}
          >
            <span className="font-semibold text-[15px]">Delete</span>
            <Trash2 className="w-5 h-5" />
          </button>
        </div>
      )}
      <Modal
        isOpen={isPinModalOpen}
        onRequestClose={() => {
          setIsPinModalOpen(false);
          setPendingLockItem(null);
          setLockPinInput("");
          setPinAction("toggle");
        }}
        className="bg-neutral-950 text-white border border-neutral-800 rounded-2xl max-w-sm w-full mx-4 p-5 outline-none"
        overlayClassName="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
      >
        <h3 className="text-lg font-semibold mb-3">
          {pinAction === "open"
            ? "Enter PIN to open chat"
            : pendingLockItem?.isLocked
              ? "Unlock chat"
              : "Lock chat"}
        </h3>
        <p className="text-sm text-neutral-400 mb-3">Enter your PIN to continue.</p>
        <input
          type="password"
          value={lockPinInput}
          onChange={(e) => setLockPinInput(e.target.value)}
          placeholder="Enter PIN"
          className="w-full rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3 outline-none text-white placeholder-neutral-500"
        />
        <div className="flex items-center gap-2 mt-4">
          <button
            type="button"
            onClick={() => {
              setIsPinModalOpen(false);
              setPendingLockItem(null);
              setLockPinInput("");
            }}
            className="w-full rounded-xl border border-neutral-800 bg-neutral-900 text-white py-2.5 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submitLockPinAction}
            className="w-full rounded-xl bg-white text-black py-2.5 font-medium hover:bg-neutral-200"
          >
            Confirm
          </button>
        </div>
      </Modal>
      {!embedded && <MobileNavbar layoutContext={layoutContext} />}
    </div>
  );
};

export default ChatPage;
