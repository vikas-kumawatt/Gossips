import React, {
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { useNavigate } from "react-router-dom";
import { UserContext } from "../contexts/UserContext";
import { usePostInteraction } from "../contexts/PostInteractionContext";
import axios from "axios";
import PostHeader from "./PostHeader";
import PostContent from "./PostContent";
import PostMedia from "./PostMedia";
import PollCard from "./PollCard";
import LocationChip from "./LocationChip";
import PostActions from "./PostActions";
import MediaModal from "./MediaModal";
import Reply from "./Reply";
import CreatePost from "./CreatePost";
import Modal from "react-modal";
import toast from "react-hot-toast";
import { Icons } from "./icons";
import NoDataMessage from "./NoDataMessage";
import ProfileCard from "./ProfileCard";
import { chatAPI, postAPI } from "../services/api";
import { useReport } from "../contexts/ReportContext";
import EditContentSheet from "./EditContentSheet";
import EditHistorySheet from "./EditHistorySheet";
import ShareSheet from "./ShareSheet";
import { useFollow } from "../contexts/FollowContext";
import { REPLY_RESTRICTED_TEXT } from "../lib/replyAudience";
import { useMute } from "../contexts/MuteContext";
import { useBlock } from "../contexts/BlockContext";


Modal.setAppElement("#root");
const viewedPostsInSession = new Set();
const pendingViewedPostIds = new Set();
let bulkFlushTimer = null;
let bulkListenersAttached = false;

const flushQueuedPostViews = async (token, useKeepalive = false) => {
  if (!token || pendingViewedPostIds.size === 0) return;

  const postIds = Array.from(pendingViewedPostIds);
  pendingViewedPostIds.clear();

  try {
    await fetch(`${import.meta.env.VITE_SERVER}/posts/views/bulk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ postIds }),
      keepalive: useKeepalive,
    });
  } catch (error) {
    postIds.forEach((postId) => pendingViewedPostIds.add(postId));
    console.error("Error flushing post views:", error);
  }
};

const queuePostViewForBulkTracking = (postId, token) => {
  if (!postId || !token) return;
  pendingViewedPostIds.add(postId);

  if (pendingViewedPostIds.size >= 20) {
    flushQueuedPostViews(token);
    return;
  }

  if (!bulkFlushTimer) {
    bulkFlushTimer = window.setTimeout(async () => {
      bulkFlushTimer = null;
      await flushQueuedPostViews(token);
    }, 4000);
  }
};

const ensureBulkViewListeners = (token) => {
  if (bulkListenersAttached || !token) return;
  bulkListenersAttached = true;

  const flushOnHidden = () => {
    if (document.visibilityState === "hidden") {
      flushQueuedPostViews(token, true);
    }
  };

  document.addEventListener("visibilitychange", flushOnHidden);
  window.addEventListener("beforeunload", () => {
    flushQueuedPostViews(token, true);
  });
};

/** Dedupe getPreferences across post cards; epoch avoids stale GET overwriting after toggle. */
let favoriteChatIdsCache = null;
let favoriteChatIdsPromise = null;
let favoriteChatIdsEpoch = 0;

const bumpFavoriteChatIdsFromToggle = (response) => {
  favoriteChatIdsEpoch += 1;
  if (Array.isArray(response?.favoriteChats)) {
    favoriteChatIdsCache = new Set(response.favoriteChats);
    // Also patch the IndexedDB cachedGet entry so a hard-refresh within the
    // 60 s TTL window still returns the correct favourites list.
    chatAPI.patchCachedPreferencesFavorites(response.favoriteChats).catch(() => {});
  }
};

const resetFavoriteChatIdsCache = () => {
  favoriteChatIdsCache = null;
  favoriteChatIdsPromise = null;
  favoriteChatIdsEpoch += 1;
};

const loadFavoriteChatIdsSet = () => {
  if (favoriteChatIdsCache && !favoriteChatIdsPromise) {
    return Promise.resolve(favoriteChatIdsCache);
  }
  if (!favoriteChatIdsPromise) {
    const epochAtFetch = favoriteChatIdsEpoch;
    favoriteChatIdsPromise = chatAPI
      .getPreferences()
      .then((data) => {
        if (epochAtFetch !== favoriteChatIdsEpoch) {
          favoriteChatIdsPromise = null;
          return favoriteChatIdsCache ?? new Set();
        }
        favoriteChatIdsCache = new Set(data.favoriteChats || []);
        favoriteChatIdsPromise = null;
        return favoriteChatIdsCache;
      })
      .catch((err) => {
        favoriteChatIdsPromise = null;
        throw err;
      });
  }
  return favoriteChatIdsPromise;
};

const PostCard = ({
  item,
  author,
  isReply = false,
  depth = 0,
  parentAuthor = null,
  disableNestedReplies = false,
  postId: propPostId,
  onDelete,
  onUpdate,
  isComment = false,
  hideActionsHeader = false,
  hideActions = false,
  isDraft = false,
  onCancel,
  maxQuoteDepth = 1,
  removeOnUnsave = false,
  removeOnUnlike = false,
  removeOnUnrepost = false,
  onNewPost,
  // Called by a rendered reply when the viewer replies to it, so the new reply
  // is appended to this (top-level) comment's flat list rather than nested
  // under the reply. Undefined on a top-level comment, which handles its own.
  onReplyPosted,
}) => {
  const [data, setData] = useState(item || {});
  const {
    createdAt = "",
    content = "",
    media = [],
    counts = {},
    _id: id = "",
    isRepost = false,
    reposterUsername = "",
    quotedPost = null,
    quotedComment = null,
    isQuoteRepost = false,
    isQuoteComment = false,
    hideLikeShareCount = false,
    viewerHasLiked = false,
    viewerHasReposted = false,
    viewerHasSaved = false,
    viewerIsFollowingAuthor = false,
    viewerCanReply: viewerCanReplyFromServer,
  } = data || {};

  const [selectedImage, setSelectedImage] = useState(null);
  const [isReplyOpen, setIsReplyOpen] = useState(false);
  const [isQuoteOpen, setIsQuoteOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [showLiveQuote, setShowLiveQuote] = useState(false);
  const [nestedReplies, setNestedReplies] = useState([]);
  const [isRepliesLoaded, setIsRepliesLoaded] = useState(false);
  const [isLoadingReplies, setIsLoadingReplies] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  // Cursor pagination for the flat reply list under a top-level comment.
  const [repliesCursor, setRepliesCursor] = useState(null);
  const [repliesHasMore, setRepliesHasMore] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isAuthorFavorite, setIsAuthorFavorite] = useState(null);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [whoCanReply, setWhoCanReply] = useState(data?.whoCanReply || "anyone");
  const [isDismissed, setIsDismissed] = useState(false);
  const [dismissReason, setDismissReason] = useState("not-interested"); // or "muted"

  const videoRefs = useRef({});
  const cardRef = useRef(null);
  const [isMuted, setIsMuted] = useState({});
  const [previousStates, setPreviousStates] = useState({});

  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const { followUpdates } = useFollow();
  const { mute: muteAccount, unmute: unmuteAccount } = useMute();
  const { isBlocked, requestBlock, unblock: unblockAccount } = useBlock();
  const { openReport } = useReport();

  const [isLiking, setIsLiking] = useState(false);
  const [isReposting, setIsReposting] = useState(false);

  // Global interaction state — persists across page navigations within a session
  const { interactions, initPost, updateInteraction } = usePostInteraction();
  const interaction = interactions[id] ?? null;
  const isLiked = interaction != null ? interaction.isLiked : (removeOnUnlike ? true : viewerHasLiked);
  const likeCount = interaction != null ? interaction.likeCount : (counts?.likes ?? 0);
  const isReposted = interaction != null ? interaction.isReposted : (removeOnUnrepost ? true : viewerHasReposted);
  const repostCount = interaction != null ? interaction.repostCount : (counts?.reposts ?? 0);
  const replyCount = interaction != null ? interaction.replyCount : (counts?.replies ?? 0);
  const isSaved = interaction != null ? interaction.isSaved : (removeOnUnsave ? true : viewerHasSaved);
  const [isDeleting, setIsDeleting] = useState(false);
  const [reposterInfo, setReposterInfo] = useState(null);

  // Most recent follow/unfollow event for this author in the current session.
  // FollowContext appends to followUpdates on every socket event, so the last
  // entry for this username is the current real-time state.
  const sessionFollowUpdate = author?.username
    ? [...followUpdates].reverse().find((u) => u.username === author.username)
    : undefined;

  // Derive follow status:
  //  1. Session update overrides everything (handles follow/unfollow without refresh).
  //  2. Fall back to viewerIsFollowingAuthor sent by the backend (accurate at fetch time).
  const isFollowing = sessionFollowUpdate
    ? sessionFollowUpdate.action === "follow" && !sessionFollowUpdate.isPending
    : viewerIsFollowingAuthor;

  // Keep local who-can-reply in sync with incoming data
  useEffect(() => {
    setWhoCanReply(data?.whoCanReply || "anyone");
  }, [data?.whoCanReply]);

  const isPostAuthor = author?.username === userAuth?.username;

  // Whether the current user may reply/quote.
  // Prefer the authoritative `viewerCanReply` from the backend (covers all four
  // cases, including "following" which can't be derived on the client). Fall back
  // to a best-effort client check for views that don't send the flag (e.g. quoted
  // embeds). The author can always reply to their own content.
  const canReplyQuote = React.useMemo(() => {
    if (isPostAuthor) return true;
    if (typeof viewerCanReplyFromServer === "boolean") {
      return viewerCanReplyFromServer;
    }
    switch (whoCanReply) {
      case "anyone":
        return true;
      case "followers":
        return !!isFollowing; // current user follows the author
      case "mentioned": {
        const me = userAuth?.username?.toLowerCase();
        if (!me) return false;
        const mentioned = (content.match(/@([a-zA-Z0-9_]+)/g) || []).map((m) =>
          m.slice(1).toLowerCase()
        );
        return mentioned.includes(me);
      }
      // "following" (author follows you) can't be determined client-side;
      // stay optimistic and let the backend enforce.
      default:
        return true;
    }
  }, [
    isPostAuthor,
    viewerCanReplyFromServer,
    whoCanReply,
    isFollowing,
    content,
    userAuth?.username,
  ]);

  const handleNotInterested = useCallback(async () => {
    setDismissReason("not-interested");
    setIsDismissed(true); // optimistic
    try {
      await postAPI.notInterested(id);
    } catch {
      setIsDismissed(false);
      toast.error("Something went wrong");
    }
  }, [id]);

  const handleUndoNotInterested = useCallback(async () => {
    setIsDismissed(false); // optimistic
    try {
      if (dismissReason === "muted" && author?.username) {
        await unmuteAccount(author.username);
      } else {
        await postAPI.undoNotInterested(id);
      }
    } catch {
      toast.error("Couldn't undo");
    }
  }, [id, dismissReason, author?.username, unmuteAccount]);

  const handleMuteAuthor = useCallback(async () => {
    if (!author?.username) return;
    try {
      await muteAccount(author.username);
      setDismissReason("muted");
      setIsDismissed(true);
      toast.success(`Muted @${author.username}`);
    } catch {
      toast.error("Couldn't mute");
    }
  }, [author?.username, muteAccount]);

  const handleUnmuteAuthor = useCallback(async () => {
    if (!author?.username) return;
    try {
      await unmuteAccount(author.username);
      setIsDismissed(false);
      toast.success(`Unmuted @${author.username}`);
    } catch {
      toast.error("Couldn't unmute");
    }
  }, [author?.username, unmuteAccount]);

  const handleWhoCanReplyChange = useCallback(
    async (value) => {
      const prev = whoCanReply;
      if (value === prev) return;
      setWhoCanReply(value); // optimistic
      try {
        const endpoint = isComment
          ? `/reply/${id}/who-can-reply`
          : `/posts/${id}/who-can-reply`;
        const res = await axios.patch(
          import.meta.env.VITE_SERVER + endpoint,
          { whoCanReply: value },
          { headers: { Authorization: `Bearer ${userAuth?.token}` } }
        );
        const saved = res.data?.whoCanReply || value;
        setWhoCanReply(saved);
        setData((d) => ({ ...d, whoCanReply: saved }));
        toast.success("Reply audience updated");
      } catch {
        setWhoCanReply(prev); // revert
        toast.error("Failed to update reply audience");
      }
    },
    [whoCanReply, isComment, id, userAuth?.token]
  );

  // The edit response is the freshly populated document — merge rather than
  // replace so viewer-scoped fields (viewerHasLiked etc.) that the server
  // doesn't return survive.
  const handleEdited = useCallback(
    (updated) => {
      const merged = { ...data, ...updated };
      setData(merged);
      onUpdate?.(merged);
    },
    [data, onUpdate]
  );

  // ── Frozen quotes ──────────────────────────────────────────────────────────
  // A quote renders the version of the original that existed when it was
  // quoted, so editing an original can't silently rewrite what a quoter appears
  // to be responding to. If the original has changed since, offer the latest.
  const quotedTarget = quotedPost || quotedComment;
  const quotedSnapshot = data?.quotedSnapshot;

  const quotedHasNewerVersion = React.useMemo(() => {
    if (!quotedSnapshot?.versionAt || !quotedTarget) return false;
    const live = quotedTarget.editedAt || quotedTarget.createdAt;
    if (!live) return false;
    return new Date(live) > new Date(quotedSnapshot.versionAt);
  }, [quotedSnapshot, quotedTarget]);

  // Swap in the frozen text, but only for the document the snapshot was taken
  // of — the schema allows both quotedPost and quotedComment to be set.
  const applyQuoteSnapshot = React.useCallback(
    (target) => {
      if (!target || target !== quotedTarget) return target;
      // Quotes made before snapshots existed have nothing frozen to show.
      if (!quotedSnapshot || showLiveQuote) return target;
      return { ...target, content: quotedSnapshot.content };
    },
    [quotedTarget, quotedSnapshot, showLiveQuote]
  );

  const mediaArray = React.useMemo(
    () => (!media ? [] : Array.isArray(media) ? media : [media]),
    [media]
  );

  useEffect(() => {
    if (item && userAuth) {
      setData(item);
      // A recycled card must not carry the previous post's "show live quote"
      // toggle over to a different post.
      setShowLiveQuote(false);
      // Skip seeding for display-only quoted/embedded cards — their data lacks
      // viewerHas* flags and would overwrite the correct context state for the
      // same post ID that might already be correctly set in the interaction map.
      if (!hideActions) {
        initPost(id, {
          isLiked: removeOnUnlike ? true : (item.viewerHasLiked ?? false),
          likeCount: item.counts?.likes ?? 0,
          isReposted: removeOnUnrepost ? true : (item.viewerHasReposted ?? false),
          repostCount: item.counts?.reposts ?? 0,
          replyCount: item.counts?.replies ?? 0,
          isSaved: removeOnUnsave ? true : (item.viewerHasSaved ?? false),
        });
      }
    }
  }, [item, userAuth, id, removeOnUnlike, removeOnUnrepost, removeOnUnsave, initPost, hideActions]);

  useEffect(() => {
    if (isRepost && reposterUsername) {
      setReposterInfo({ username: reposterUsername });
    } else {
      setReposterInfo(null);
    }
  }, [isRepost, reposterUsername]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const video = entry.target;
          const mediaUrl = Object.keys(videoRefs.current).find(
            (key) => videoRefs.current[key] === video
          );
          if (entry.isIntersecting) {
            video.play().catch((err) => console.warn("Autoplay failed:", err));
            video.muted = isMuted[mediaUrl] ?? true;
          } else {
            video.pause();
            video.muted = true;
            setIsMuted((prev) => ({ ...prev, [mediaUrl]: true }));
          }
        });
      },
      { threshold: 0.5 }
    );

    const currentVideoRefs = videoRefs.current;
    Object.values(currentVideoRefs).forEach(
      (video) => video && observer.observe(video)
    );
    return () =>
      Object.values(currentVideoRefs).forEach(
        (video) => video && observer.unobserve(video)
      );
  }, [mediaArray, isMuted]);

  useEffect(() => {
    if (userAuth?.token) ensureBulkViewListeners(userAuth.token);
  }, [userAuth?.token]);

  useEffect(() => {
    if (!userAuth?.token) {
      resetFavoriteChatIdsCache();
    }
  }, [userAuth?.token]);

  useEffect(() => {
    if (
      !userAuth?.token ||
      !author?._id ||
      author.username === userAuth.username
    ) {
      setIsAuthorFavorite(null);
      return;
    }

    let cancelled = false;
    const chatKey = `user_${author._id}`;

    loadFavoriteChatIdsSet()
      .then((set) => {
        if (!cancelled) setIsAuthorFavorite(set.has(chatKey));
      })
      .catch(() => {
        if (!cancelled) setIsAuthorFavorite(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userAuth?.token, author?._id, author?.username, userAuth?.username]);

  useEffect(() => {
    if (
      !cardRef.current ||
      !id ||
      isComment ||
      isDraft ||
      hideActionsHeader ||
      hideActions ||
      !userAuth?.token ||
      viewedPostsInSession.has(id)
    ) {
      return;
    }

    let hasTracked = false;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting || hasTracked || viewedPostsInSession.has(id)) {
          return;
        }

        hasTracked = true;
        viewedPostsInSession.add(id);
        observer.disconnect();
        queuePostViewForBulkTracking(id, userAuth.token);
      },
      { threshold: 0.6 }
    );

    observer.observe(cardRef.current);

    return () => observer.disconnect();
  }, [
    id,
    isComment,
    isDraft,
    hideActionsHeader,
    hideActions,
    userAuth?.token,
  ]);

  const isQuotedContentVisible = () => {
    if (quotedPost) {
      if (
        !quotedPost ||
        typeof quotedPost === "string" ||
        !quotedPost._id ||
        !quotedPost.author
      ) {
        return false;
      }
      if (!quotedPost.author.isPrivate) {
        return true;
      }
      if (!userAuth || !userAuth.id) {
        return false;
      }
      const isAuthor = quotedPost.author._id.toString() === userAuth.id;
      const isViewerFollowing = quotedPost.author.followers?.some(
        (follower) =>
          follower._id?.toString() === userAuth.id ||
          follower.toString() === userAuth.id
      );
      return isAuthor || isViewerFollowing;
    } else if (quotedComment) {
      if (
        !quotedComment ||
        typeof quotedComment === "string" ||
        !quotedComment._id ||
        !quotedComment.author
      ) {
        return false;
      }
      if (!quotedComment.author.isPrivate) {
        return true;
      }
      if (!userAuth || !userAuth.id) {
        return false;
      }
      const isAuthor = quotedComment.author._id.toString() === userAuth.id;
      const isViewerFollowing = quotedComment.author.followers?.some(
        (follower) =>
          follower._id?.toString() === userAuth.id ||
          follower.toString() === userAuth.id
      );
      return isAuthor || isViewerFollowing;
    }
    return true;
  };

  // Fetch one page of replies (10 by default). `cursor` null = first page.
  // Replies come back oldest-first and are kept in that order; each page is
  // appended, so "Show more replies" walks the thread to the end.
  const fetchRepliesPage = useCallback(
    async (cursor) => {
      const response = await axios.get(
        `${import.meta.env.VITE_SERVER}/reply/comments/replies/${id}`,
        {
          headers: { Authorization: `Bearer ${userAuth?.token}` },
          params: { limit: 10, ...(cursor ? { cursor } : {}) },
        }
      );
      return response.data;
    },
    [id, userAuth?.token]
  );

  const loadReplies = useCallback(async () => {
    if (disableNestedReplies || isRepliesLoaded || isLoadingReplies || replyCount === 0)
      return;

    setIsLoadingReplies(true);
    try {
      const data = await fetchRepliesPage(null);
      setNestedReplies(data.comments || []);
      setRepliesCursor(data.pageInfo?.nextCursor || null);
      setRepliesHasMore(data.pageInfo?.hasNextPage ?? false);
      setIsRepliesLoaded(true);
      setShowReplies(true);
    } catch (error) {
      console.error("Error loading replies:", error);
    } finally {
      setIsLoadingReplies(false);
    }
  }, [
    fetchRepliesPage,
    disableNestedReplies,
    isRepliesLoaded,
    isLoadingReplies,
    replyCount,
  ]);

  const loadMoreReplies = useCallback(async () => {
    if (isLoadingReplies || !repliesHasMore || !repliesCursor) return;
    setIsLoadingReplies(true);
    try {
      const data = await fetchRepliesPage(repliesCursor);
      setNestedReplies((prev) => {
        const seen = new Set(prev.map((r) => r._id));
        return [...prev, ...(data.comments || []).filter((r) => !seen.has(r._id))];
      });
      setRepliesCursor(data.pageInfo?.nextCursor || null);
      setRepliesHasMore(data.pageInfo?.hasNextPage ?? false);
    } catch (error) {
      console.error("Error loading more replies:", error);
    } finally {
      setIsLoadingReplies(false);
    }
  }, [fetchRepliesPage, isLoadingReplies, repliesHasMore, repliesCursor]);

  const toggleReplies = (e) => {
    e.stopPropagation();
    if (disableNestedReplies) return;
    !isRepliesLoaded ? loadReplies() : setShowReplies(!showReplies);
  };

  // Add a freshly posted reply to this comment's flat list and bump the count.
  // Used both when the viewer replies to this top-level comment directly and,
  // via onReplyPosted, when they reply to one of its rendered replies.
  const addReplyLocally = useCallback(
    (newReply) => {
      const newReplyCount = replyCount + 1;
      updateInteraction(id, { replyCount: newReplyCount });
      const updatedData = {
        ...data,
        counts: { ...(data.counts || {}), replies: newReplyCount },
      };
      setData(updatedData);
      if (onUpdate) onUpdate(updatedData);
      if (isRepliesLoaded) {
        // Already showing the list — append in place.
        setNestedReplies((prev) =>
          prev.some((r) => r._id === newReply._id) ? prev : [...prev, newReply]
        );
        setShowReplies(true);
      } else if (replyCount === 0) {
        // The first reply: nothing older is hidden, so show it immediately
        // instead of behind a "Show 1 reply" button.
        setNestedReplies([newReply]);
        setRepliesHasMore(false);
        setIsRepliesLoaded(true);
        setShowReplies(true);
      }
      // Otherwise leave it for the "Show N replies" button to fetch in order.
    },
    [id, data, replyCount, isRepliesLoaded, updateInteraction, onUpdate]
  );

  const toggleMute = (e, mediaUrl) => {
    e.stopPropagation();
    setIsMuted((prev) => ({ ...prev, [mediaUrl]: !prev[mediaUrl] }));
    if (videoRefs.current[mediaUrl])
      videoRefs.current[mediaUrl].muted = !isMuted[mediaUrl];
  };

  const openModal = (e, imageSrc) => {
    e.stopPropagation();
    const states = {};
    Object.keys(videoRefs.current).forEach((mediaUrl) => {
      const video = videoRefs.current[mediaUrl];
      if (video) {
        states[mediaUrl] = { wasPlaying: !video.paused, wasMuted: video.muted };
        video.pause();
        video.muted = true;
      }
    });
    setPreviousStates(states);
    setIsMuted((prev) => ({
      ...prev,
      ...Object.keys(videoRefs.current).reduce(
        (acc, url) => ({ ...acc, [url]: true }),
        {}
      ),
    }));
    setSelectedImage(imageSrc);
  };

  const closeModal = (e) => {
    if (e) e.stopPropagation();
    Object.keys(videoRefs.current).forEach((mediaUrl) => {
      const video = videoRefs.current[mediaUrl];
      if (video && previousStates[mediaUrl]) {
        video.muted = previousStates[mediaUrl].wasMuted;
        if (previousStates[mediaUrl].wasPlaying)
          video.play().catch((err) => console.warn("Autoplay failed:", err));
      }
    });
    setIsMuted((prev) => ({
      ...prev,
      ...Object.keys(previousStates).reduce(
        (acc, url) => ({ ...acc, [url]: previousStates[url].wasMuted }),
        {}
      ),
    }));
    setSelectedImage(null);
    setPreviousStates({});
  };

  const handleProfileClick = (e) => {
    e.stopPropagation();
    if (author?.username) {
      setIsProfileModalOpen(true);
    }
  };

  const handleReposterClick = (e) => {
    e.stopPropagation();
    if (reposterUsername) {
      setIsProfileModalOpen(true);
      setReposterInfo({ username: reposterUsername });
    }
  };

  const handleQuotedContentClick = (e) => {
    e.stopPropagation();
    if (quotedPost?.author?.username && quotedPost?._id) {
      navigate(`/${quotedPost.author.username}/post/${quotedPost._id}`);
    } else if (quotedComment?.author?.username && quotedComment?._id) {
      const postId = quotedComment.post ? quotedComment.post.toString() : null;
      if (postId) {
        navigate(`/${quotedComment.author.username}/post/${postId}`);
      } else {
        console.warn("Quoted comment post ID is undefined:", quotedComment);
        toast.error("Cannot navigate: Comment post ID is missing.");
      }
    }
  };

  const handleCardClick = () => {
    if (author?.username && id) {
      if (isDraft) {
        setData((prev) => ({ ...prev, content: data.content || "" }));
        if (onUpdate) onUpdate(data);
      } else {
        navigate(`/${author.username}/post/${isComment ? propPostId : id}`);
      }
    }
  };

  const handleAction = async (e, action, endpoint, successMsg) => {
    e.stopPropagation();
    if (isLiking || isReposting || !userAuth?.id || !id) return;

    const setLoading = action === "like" ? setIsLiking : setIsReposting;
    const currentState = action === "like" ? isLiked : isReposted;
    const currentCount = action === "like" ? likeCount : repostCount;
    const newState = !currentState;

    try {
      setLoading(true);

      // Optimistic update — propagates to every PostCard showing this post
      if (action === "like") {
        updateInteraction(id, {
          isLiked: newState,
          likeCount: newState ? currentCount + 1 : Math.max(0, currentCount - 1),
        });
      } else {
        updateInteraction(id, {
          isReposted: newState,
          repostCount: newState ? currentCount + 1 : Math.max(0, currentCount - 1),
        });
      }

      const { data: responseData } = await axios.post(
        `${import.meta.env.VITE_SERVER}${endpoint}/${id}/${action}`,
        {},
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );

      let updatedPost = { ...data };

      // Confirm with server values
      if (action === "like") {
        const confirmedLiked = typeof responseData?.liked === "boolean" ? responseData.liked : newState;
        const updatedLikes = responseData?.counts?.likes !== undefined
          ? responseData.counts.likes
          : (confirmedLiked ? currentCount + 1 : Math.max(0, currentCount - 1));
        updateInteraction(id, { isLiked: confirmedLiked, likeCount: updatedLikes });
        updatedPost = {
          ...updatedPost,
          viewerHasLiked: confirmedLiked,
          counts: { ...(updatedPost.counts || {}), likes: updatedLikes },
        };
      } else if (action === "repost") {
        const confirmedReposted = typeof responseData?.reposted === "boolean" ? responseData.reposted : newState;
        const updatedReposts = responseData?.counts?.reposts !== undefined
          ? responseData.counts.reposts
          : (confirmedReposted ? currentCount + 1 : Math.max(0, currentCount - 1));
        updateInteraction(id, { isReposted: confirmedReposted, repostCount: updatedReposts });
        toast.success(confirmedReposted ? successMsg : "Repost removed");
        updatedPost = {
          ...updatedPost,
          viewerHasReposted: confirmedReposted,
          counts: { ...(updatedPost.counts || {}), reposts: updatedReposts },
        };
      }

      setData(updatedPost);
      if (onUpdate) onUpdate(updatedPost);
    } catch (error) {
      console.error(`Error ${action}ing:`, error);
      // Revert optimistic update
      if (action === "like") {
        updateInteraction(id, { isLiked: currentState, likeCount: currentCount });
      } else {
        updateInteraction(id, { isReposted: currentState, repostCount: currentCount });
      }
      toast.error(`Failed to ${action}. Please try again.`);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !userAuth?.token) {
      return;
    }
    setIsDeleting(true);
    try {
      const endpoint = isDraft
        ? "/posts/draft"
        : isComment
          ? "/reply"
          : "/posts";
      const response = await axios.delete(
        `${import.meta.env.VITE_SERVER}${endpoint}/${id}`,
        {
          headers: { Authorization: `Bearer ${userAuth.token}` },
        }
      );
      if (response.status === 200) {
        if (onDelete) onDelete(id);
        toast.success("Deleted");
      }
    } catch (error) {
      console.error(
        "handleDelete - Error deleting:",
        error.response ? error.response.data : error.message
      );
      toast.error(
        `Failed to delete: ${error.response?.data?.message || error.message}`
      );
    } finally {
      setIsDeleting(false);
      setIsDeleteModalOpen(false);
    }
  };

  const handleSave = async (e) => {
    e.stopPropagation();
    if (!id || !userAuth?.token || isSaving) return;

    const currentSaved = isSaved;
    const newSaveState = !currentSaved;

    setIsSaving(true);
    // Optimistic update — propagates to every PostCard showing this post
    updateInteraction(id, { isSaved: newSaveState });

    try {
      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}/posts/save/${id}`,
        {},
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );

      // Confirm with server value
      const confirmedSaved = typeof response.data?.saved === "boolean"
        ? response.data.saved
        : newSaveState;
      const updatedPost = { ...data, viewerHasSaved: confirmedSaved };
      updateInteraction(id, { isSaved: confirmedSaved });
      setData(updatedPost);
      if (onUpdate) onUpdate(updatedPost);

      if (!confirmedSaved && removeOnUnsave && onDelete) {
        onDelete(id);
      }

      toast.success(confirmedSaved ? "Post saved successfully" : "Post unsaved successfully");
    } catch (error) {
      console.error("Error toggling save:", error);
      // Revert optimistic update
      updateInteraction(id, { isSaved: currentSaved });
      toast.error("Failed to save/unsave post. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleHideCount = async (e) => {
    e.stopPropagation();
    if (!id || !userAuth?.token || author?.username !== userAuth?.username) return;

    const prevData = data;
    const newHiddenState = !hideLikeShareCount;

    // Optimistic update
    setData({ ...prevData, hideLikeShareCount: newHiddenState });

    try {
      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}/posts/${id}/toggle-hide-count`,
        {},
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );

      // Backend returns { hideLikeShareCount, message } — no post object
      const confirmedHidden =
        typeof response.data?.hideLikeShareCount === "boolean"
          ? response.data.hideLikeShareCount
          : newHiddenState;

      const updatedPost = { ...prevData, hideLikeShareCount: confirmedHidden };
      setData(updatedPost);
      if (onUpdate) onUpdate(updatedPost);

      toast.success(
        confirmedHidden
          ? "Like and share counts hidden"
          : "Like and share counts visible"
      );
    } catch (error) {
      console.error("Error toggling count visibility:", error);
      setData(prevData); // revert optimistic update
      toast.error("Failed to update count visibility.");
    }
  };

  const handleToggleFavoriteChat = useCallback(async () => {
    if (
      !userAuth?.token ||
      !author?._id ||
      author.username === userAuth.username ||
      isTogglingFavorite
    ) {
      return;
    }
    const chatId = `user_${author._id}`;
    const prevFavorite = isAuthorFavorite;
    const optimisticNext = !prevFavorite;

    // Optimistic update — instant UI feedback
    setIsAuthorFavorite(optimisticNext);
    if (favoriteChatIdsCache) {
      if (optimisticNext) {
        favoriteChatIdsCache.add(chatId);
      } else {
        favoriteChatIdsCache.delete(chatId);
      }
    }

    setIsTogglingFavorite(true);
    try {
      const response = await chatAPI.toggleFavoriteChat(
        encodeURIComponent(chatId)
      );
      const next = Boolean(response?.isFavorite);
      setIsAuthorFavorite(next);
      bumpFavoriteChatIdsFromToggle(response);
      toast.success(
        next ? "Added to favorites" : "Removed from favorites"
      );
    } catch (error) {
      console.error("Error toggling favorite chat:", error);
      // Revert optimistic update
      setIsAuthorFavorite(prevFavorite);
      if (favoriteChatIdsCache) {
        if (prevFavorite) {
          favoriteChatIdsCache.add(chatId);
        } else {
          favoriteChatIdsCache.delete(chatId);
        }
      }
      toast.error("Could not update favorites");
    } finally {
      setIsTogglingFavorite(false);
    }
  }, [
    userAuth?.token,
    userAuth?.username,
    author?._id,
    author?.username,
    isTogglingFavorite,
    isAuthorFavorite,
  ]);

  const handleReport = () => {
    openReport({
      targetType: isComment ? "comment" : "post",
      targetId: id,
      username: author?.username,
      name: author?.name,
      // Only posts have a "see fewer like this" affordance, and only while the
      // card is still on screen.
      onNotInterested:
        !isComment && !isDismissed ? handleNotInterested : undefined,
    });
  };

  const handleIconClick = (e, action) => {
    e.stopPropagation();
    switch (action) {
      case "like":
        handleAction(e, "like", isComment ? "/reply" : "/posts", "Liked");
        break;
      case "reply":
        if (!canReplyQuote) {
          toast.error(REPLY_RESTRICTED_TEXT);
          break;
        }
        setIsReplyOpen(true);
        break;
      case "repost":
      case "unrepost":
        handleAction(e, "repost", isComment ? "/reply" : "/posts", "Reposted");
        break;
      case "quote":
        if (!canReplyQuote) {
          toast.error(REPLY_RESTRICTED_TEXT);
          break;
        }
        setIsQuoteOpen(true);
        break;
      case "delete":
      case "delete-draft":
        setIsDeleteModalOpen(true);
        break;
      case "save":
        handleSave(e);
        break;
      case "hide-count":
        handleToggleHideCount(e);
        break;
      case "copy-link":
        if (id)
          navigator.clipboard.writeText(
            `https://gossipsss.netlify.app/${isComment ? "comment" : "post"}/${id}`
          );
        break;
      case "toggle-favorite-chat":
        handleToggleFavoriteChat();
        break;
      case "not-interested":
        handleNotInterested();
        break;
      case "mute":
        handleMuteAuthor();
        break;
      case "unmute":
        handleUnmuteAuthor();
        break;
      case "block":
        if (author?.username)
          requestBlock({ username: author.username, name: author.name });
        break;
      case "unblock-user":
        if (author?.username) unblockAccount(author.username);
        break;
      case "edit":
        setIsEditOpen(true);
        break;
      case "share":
        setIsShareOpen(true);
        break;
      case "report":
        handleReport();
        break;
      default:
        console.warn("Unhandled action:", action);
        break;
    }
  };

  if (!author || !id) {
    return null;
  }

  if (removeOnUnlike && !isLiked) {
    return null;
  }

  if (removeOnUnrepost && !isReposted) {
    return null;
  }

  // Reactively hide posts from accounts the viewer has blocked (feed surfaces only).
  if (!hideActions && !isPostAuthor && isBlocked(author?.username)) {
    return null;
  }

  const showFavoriteChatOption =
    Boolean(author._id) &&
    Boolean(userAuth?.username) &&
    author.username !== userAuth.username;

  // "Not interested" / mute confirmation card — replaces the post in the feed.
  if (isDismissed && !hideActions) {
    return (
      <div className="border-b border-neutral-800 px-3 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-neutral-300">
            <Icons.notinterested />
            <span className="text-[15px]">
              {dismissReason === "muted"
                ? `You'll see fewer posts from @${author.username}.`
                : "You'll see fewer posts like this."}
            </span>
          </div>
          <button
            onClick={handleUndoNotInterested}
            className="font-semibold text-white hover:underline cursor-pointer"
          >
            Undo
          </button>
        </div>
        <div className="mt-1 divide-y divide-neutral-800">
          {dismissReason !== "muted" &&
            author.username !== userAuth?.username && (
              <button
                onClick={handleMuteAuthor}
                className="w-full flex items-center gap-3 py-3 text-left text-[15px] text-white hover:opacity-80 cursor-pointer"
              >
                <Icons.mute />
                <span>Mute @{author.username}</span>
              </button>
            )}
          <button
            onClick={handleReport}
            className="w-full flex items-center gap-3 py-3 text-left text-[15px] text-red-500 hover:opacity-80 cursor-pointer"
          >
            <Icons.report />
            <span>Report post</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div ref={cardRef} className="relative cursor-pointer" onClick={handleCardClick}>
        {reposterInfo && (
          <div className="flex items-center gap-2 text-neutral-400 text-sm mb-2 ml-6">
            <Icons.repost className="w-4 h-4" />
            <span
              onClick={handleReposterClick}
              className="cursor-pointer hover:underline font-medium"
            >
              {reposterInfo.username}
            </span>{" "}
            <span>reposted</span>
          </div>
        )}
        <div className={`text-white w-full pb-2 ${isReply ? "pt-2" : ""}`}>
          {hideActionsHeader ? (
            <div
              className={`flex flex-col ${
                depth > 0 ? "ml-10 border-neutral-700" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  onClick={handleProfileClick}
                  className="cursor-pointer relative"
                >
                  <img
                    className={`rounded-full bg-neutral-800 object-cover border border-neutral-800 hover:opacity-80 transition ${
                      hideActionsHeader ? "w-6 h-6" : "w-10 h-10"
                    }`}
                    src={author.profilePic || ""}
                    alt="Profile"
                  />
                  
                </div>
                <PostHeader
                  author={author}
                  createdAt={createdAt}
                  handleIconClick={handleIconClick}
                  handleProfileClick={(e) => {
                    e.stopPropagation();
                    navigate(`/${author.username}`);
                  }}
                  hideActions={hideActionsHeader}
                  isSaved={isSaved}
                  isSaving={isSaving}
                  isDraft={isDraft}
                  currentUserFollowing={userAuth?.following}
                  isPrivate={author.isPrivate}
                  hideLikeShareCount={hideLikeShareCount}
                  showHideCountOption={!isComment && !isDraft}
                  showFavoriteChatOption={showFavoriteChatOption}
                  isAuthorFavorite={isAuthorFavorite}
                  isTogglingFavorite={isTogglingFavorite}
                  whoCanReply={whoCanReply}
                  onWhoCanReplyChange={handleWhoCanReplyChange}
                  isEdited={data?.isEdited}
                  onViewEditHistory={() => setIsHistoryOpen(true)}
                  isAiGenerated={data?.isAiGenerated}
                />
              </div>
              <div className="mt-1">
                {data?.location && <LocationChip location={data.location} />}
                <PostContent content={content} />
                {data?.poll?.question && (
                  <PollCard
                    type={isComment ? "comment" : "post"}
                    id={data._id}
                    poll={data.poll}
                    isAuthor={isPostAuthor}
                  />
                )}
                <PostMedia
                  mediaArray={mediaArray}
                  videoRefs={videoRefs}
                  isMuted={isMuted}
                  toggleMute={toggleMute}
                  openModal={openModal}
                  hideActions={hideActionsHeader}
                />
              </div>
              {(isQuoteRepost || isQuoteComment) &&
                (quotedPost || quotedComment) &&
                maxQuoteDepth > 0 && (
                  <div className="my-2 py-3 px-3 md:px-5 border border-neutral-700 text-neutral-500 rounded-lg">
                    {quotedHasNewerVersion && isQuotedContentVisible() && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowLiveQuote((v) => !v);
                        }}
                        className="mb-2 w-full text-left text-[13px] text-blue-400 hover:underline cursor-pointer"
                      >
                        {showLiveQuote
                          ? "Showing the latest version · Show the quoted version"
                          : "A new version of this post is available"}
                      </button>
                    )}
                    {isQuotedContentVisible() ? (
                      <div
                        onClick={handleQuotedContentClick}
                        className="cursor-pointer"
                      >
                        {quotedPost && (
                          <PostCard
                            item={applyQuoteSnapshot(quotedPost)}
                            author={quotedPost.author}
                            hideActionsHeader={true}
                            hideActions={true}
                            maxQuoteDepth={maxQuoteDepth - 1}
                            removeOnUnsave={removeOnUnsave}
                          />
                        )}
                        {quotedComment && (
                          <PostCard
                            item={applyQuoteSnapshot(quotedComment)}
                            author={quotedComment.author}
                            hideActionsHeader={true}
                            hideActions={true}
                            maxQuoteDepth={maxQuoteDepth - 1}
                            removeOnUnsave={removeOnUnsave}
                            isComment={true}
                            postId={quotedComment.post}
                          />
                        )}
                      </div>
                    ) : (
                      <div>
                        <NoDataMessage message="This quoted content is unavailable" />
                      </div>
                    )}
                  </div>
                )}
              {!hideActions && (
                <PostActions
                  handleIconClick={handleIconClick}
                  isLiked={isLiked}
                  isLiking={isLiking}
                  likeCount={likeCount}
                  replyCount={replyCount}
                  repostCount={repostCount}
                  isReposted={isReposted}
                  isReposting={isReposting}
                  hideLikeShareCount={hideLikeShareCount}
                  canReplyQuote={canReplyQuote}
                />
              )}
              {isComment && !disableNestedReplies && replyCount > 0 && (
                <button
                  onClick={toggleReplies}
                  className="text-blue-500 text-sm mt-2 hover:underline flex items-center"
                >
                  {isLoadingReplies
                    ? "Loading replies..."
                    : showReplies
                      ? "Hide replies"
                      : `Show ${replyCount} replies`}
                </button>
              )}
            </div>
          ) : (
            <div
              className={`flex gap-2 ${
                depth > 0 ? "ml-10 border-neutral-700" : ""
              }`}
            >
              <div
                onClick={handleProfileClick}
                className="cursor-pointer relative"
              >
                <img
                  className={`rounded-full bg-neutral-800 object-cover border border-neutral-800 hover:opacity-80 transition ${
                    hideActionsHeader ? "w-6 h-6" : "w-10 h-10"
                  }`}
                  src={author.profilePic || ""}
                  alt="Profile"
                />
                {!isFollowing && userAuth?.username !== author?.username && (
                  <span className="absolute top-6 right-0 bg-white rounded-full border-2 w-5 h-5 flex items-center justify-center text-black">
                    <Icons.profileplus />
                  </span>
                )}
              </div>
              <div className="flex-1">
                <PostHeader
                  author={author}
                  createdAt={createdAt}
                  handleIconClick={handleIconClick}
                  handleProfileClick={(e) => {
                    e.stopPropagation();
                    navigate(`/${author.username}`);
                  }}
                  hideActions={hideActionsHeader}
                  isSaved={isSaved}
                  isSaving={isSaving}
                  isDraft={isDraft}
                  currentUserFollowing={userAuth?.following}
                  isPrivate={author.isPrivate}
                  hideLikeShareCount={hideLikeShareCount}
                  showHideCountOption={!isComment && !isDraft}
                  showFavoriteChatOption={showFavoriteChatOption}
                  isAuthorFavorite={isAuthorFavorite}
                  isTogglingFavorite={isTogglingFavorite}
                  whoCanReply={whoCanReply}
                  onWhoCanReplyChange={handleWhoCanReplyChange}
                  isEdited={data?.isEdited}
                  onViewEditHistory={() => setIsHistoryOpen(true)}
                  isAiGenerated={data?.isAiGenerated}
                />
                {depth > 0 && parentAuthor && (
                  <div className="text-sm text-neutral-500 mb-1">
                    Replying to{" "}
                    <span className="text-blue-500">
                      @{parentAuthor.username}
                    </span>
                  </div>
                )}
                {data?.location && <LocationChip location={data.location} />}
                <PostContent content={content} />
                {data?.poll?.question && (
                  <PollCard
                    type={isComment ? "comment" : "post"}
                    id={data._id}
                    poll={data.poll}
                    isAuthor={isPostAuthor}
                  />
                )}
                <PostMedia
                  mediaArray={mediaArray}
                  videoRefs={videoRefs}
                  isMuted={isMuted}
                  toggleMute={toggleMute}
                  openModal={openModal}
                  hideActions={hideActionsHeader}
                />
                {(isQuoteRepost || isQuoteComment) &&
                  (quotedPost || quotedComment) &&
                  maxQuoteDepth > 0 && (
                    <div className="my-2 pt-3 px-3 md:px-5 border border-neutral-700 rounded-lg">
                      {quotedHasNewerVersion && isQuotedContentVisible() && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowLiveQuote((v) => !v);
                          }}
                          className="mb-2 w-full text-left text-[13px] text-blue-400 hover:underline cursor-pointer"
                        >
                          {showLiveQuote
                            ? "Showing the latest version · Show the quoted version"
                            : "A new version of this post is available"}
                        </button>
                      )}
                      {isQuotedContentVisible() ? (
                        <div
                          onClick={handleQuotedContentClick}
                          className="cursor-pointer"
                        >
                          {quotedPost && (
                            <PostCard
                              item={applyQuoteSnapshot(quotedPost)}
                              author={quotedPost.author}
                              hideActionsHeader={true}
                              hideActions={true}
                              maxQuoteDepth={maxQuoteDepth - 1}
                              removeOnUnsave={removeOnUnsave}
                            />
                          )}
                          {quotedComment && (
                            <PostCard
                              item={applyQuoteSnapshot(quotedComment)}
                              author={quotedComment.author}
                              hideActionsHeader={true}
                              hideActions={true}
                              maxQuoteDepth={maxQuoteDepth - 1}
                              removeOnUnsave={removeOnUnsave}
                              isComment={true}
                              postId={quotedComment.post}
                            />
                          )}
                        </div>
                      ) : (
                        <div className="text-neutral-500 p-4 pb-6">
                          <NoDataMessage message="This quoted content is unavailable" />
                        </div>
                      )}
                    </div>
                  )}
                {!hideActions && (
                  <PostActions
                    handleIconClick={handleIconClick}
                    isLiked={isLiked}
                    isLiking={isLiking}
                    likeCount={likeCount}
                    replyCount={replyCount}
                    repostCount={repostCount}
                    isReposted={isReposted}
                    isReposting={isReposting}
                    hideLikeShareCount={hideLikeShareCount}
                    canReplyQuote={canReplyQuote}
                  />
                )}
                {isComment && !disableNestedReplies && replyCount > 0 && (
                  <button
                    onClick={toggleReplies}
                    className="text-blue-500 text-sm mt-2 hover:underline flex items-center"
                  >
                    {isLoadingReplies
                      ? "Loading replies..."
                      : showReplies
                        ? "Hide replies"
                        : `Show ${replyCount} replies`}
                  </button>
                )}
              </div>
            </div>
          )}
          {isComment &&
            !disableNestedReplies &&
            showReplies &&
            nestedReplies.length > 0 && (
              <div className="nested-replies">
                {nestedReplies.map((reply) => (
                  <PostCard
                    key={reply._id}
                    item={reply}
                    author={reply.author}
                    isReply={true}
                    // Fixed one level deep — the thread is flat. A reply shows
                    // "Replying to @user" (whoever it answered) but renders no
                    // replies of its own.
                    depth={1}
                    parentAuthor={reply.replyTo?.author || author}
                    disableNestedReplies={true}
                    postId={propPostId}
                    onDelete={onDelete}
                    isComment={true}
                    hideActionsHeader={hideActionsHeader}
                    hideActions={hideActions}
                    removeOnUnsave={removeOnUnsave}
                    // Replying to a reply appends to this comment's flat list.
                    onReplyPosted={addReplyLocally}
                  />
                ))}
                {repliesHasMore && (() => {
                  // Exact number still hidden = total on the comment minus what's
                  // already shown. Falls back to a generic label if the cached
                  // count is momentarily behind the loaded rows.
                  const remaining = Math.max(0, replyCount - nestedReplies.length);
                  return (
                    <button
                      onClick={loadMoreReplies}
                      disabled={isLoadingReplies}
                      className="text-blue-500 text-sm mt-2 ml-10 hover:underline flex items-center disabled:opacity-60"
                    >
                      {isLoadingReplies
                        ? "Loading..."
                        : remaining > 0
                          ? `Show ${remaining} more ${remaining === 1 ? "reply" : "replies"}`
                          : "Show more replies"}
                    </button>
                  );
                })()}
              </div>
            )}
        </div>
      </div>

      {isReplyOpen && (
        <Reply
          isOpen={isReplyOpen}
          onClose={() => setIsReplyOpen(false)}
          postId={isComment ? propPostId : id}
          commentId={isComment ? id : null}
          onReplyAdded={(newReply) => {
            // A rendered reply bubbles up to its top-level comment; a top-level
            // comment adds the reply to its own flat list.
            if (onReplyPosted) onReplyPosted(newReply);
            else addReplyLocally(newReply);
          }}
        />
      )}
      {isQuoteOpen && (
        <CreatePost
          isOpen={isQuoteOpen}
          onClose={() => setIsQuoteOpen(false)}
          onPostCreated={(newPost) => {
            setIsQuoteOpen(false);
            if (onNewPost) onNewPost(newPost);
          }}
          quotedPost={isComment ? null : data}
          quotedComment={isComment ? data : null}
          quotedAuthor={author}
        />
      )}
      {selectedImage && (
        <MediaModal selectedImage={selectedImage} closeModal={closeModal} />
      )}
      <Modal
        isOpen={isDeleteModalOpen}
        onRequestClose={() => {
          setIsDeleteModalOpen(false);
          if (onCancel) onCancel();
        }}
        className="bg-[#1A1A1A] rounded-lg max-w-[300px] mx-auto border border-neutral-700 z-[1000]"
        overlayClassName="fixed inset-0 bg-black/90 flex items-center justify-center z-[1000]"
      >
        <div className="flex flex-col">
          <h2 className="text-lg font-bold text-center px-4 pt-4">
            Delete {isDraft ? "draft" : isComment ? "comment" : "post"}?
          </h2>
          <p className="mt-2 text-neutral-400 text-center px-4 border-b border-neutral-700 pb-4">
            If you delete this{" "}
            {isDraft ? "draft" : isComment ? "comment" : "post"}, you won’t be
            able to restore it.
          </p>
          <div className="flex justify-between mx-2">
            <button
              onClick={() => {
                setIsDeleteModalOpen(false);
                if (onCancel) onCancel();
              }}
              className="flex-1 py-2 my-2 font-medium rounded-lg hover:bg-neutral-700"
              disabled={isDeleting}
            >
              Cancel
            </button>
            <span className="border-r border-neutral-700 mx-2" />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              className="flex-1 py-2 my-2 text-red-500 font-medium rounded-lg hover:bg-neutral-800"
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </Modal>

      {isProfileModalOpen && author && (
        <ProfileCard
          name={author.name}
          username={author.username}
          bio={author.bio || ""}
          followers={author.followers?.length || 0}
          following={userAuth?.following || []}
          profilePic={author.profilePic || "https://via.placeholder.com/96"}
          isPrivate={author.isPrivate || false}
          isVerified={author.isVerified || false}
          isModal={true}
          onClose={() => setIsProfileModalOpen(false)}
        />
      )}

      {isEditOpen && (
        <EditContentSheet
          isComment={isComment}
          targetId={id}
          initialContent={content || ""}
          initialAiGenerated={data?.isAiGenerated}
          onSaved={handleEdited}
          onClose={() => setIsEditOpen(false)}
        />
      )}

      {isHistoryOpen && (
        <EditHistorySheet
          isComment={isComment}
          targetId={id}
          onClose={() => setIsHistoryOpen(false)}
        />
      )}

      {isShareOpen && (
        <ShareSheet
          targetType={isComment ? "comment" : "post"}
          targetId={id}
          // A comment has no page of its own; links point at its parent post.
          postId={isComment ? propPostId || data?.post : id}
          authorUsername={author?.username}
          previewText={content}
          onClose={() => setIsShareOpen(false)}
        />
      )}
    </>
  );
};

export default PostCard;