import { useCallback, useContext, useState, useEffect, useRef } from "react";
import CreatePost from "../components/CreatePost";
import SiteHeader from "../components/layouts/site-header";
import MobileNavbar from "../components/layouts/mobile-navbar";
import { Icons } from "../components/icons";
import { useLocation, useNavigate } from "react-router-dom";
import { UserContext } from "../contexts/UserContext";
import { useSocket } from "../contexts/useSocket";
import { notificationAPI } from "../services/api";
import FollowButton from "../components/FollowButton";
import { Clock } from "lucide-react";
import NavigationMenu from "../menus/NavigationMenu";
import {
  emptyNotificationMessage,
  visibleNotificationTabs,
} from "../lib/notificationCategories";

const ActivityPage = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { userAuth, setUnreadNotificationCount } = useContext(UserContext);
  const { socket } = useSocket();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [loadMoreTrigger, setLoadMoreTrigger] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [category, setCategory] = useState("all");
  const cursorRef = useRef(null);
  const hasMoreRef = useRef(true);
  const isFetchingRef = useRef(false);
  /*
   * Which tab is live, written synchronously — the socket handler and the
   * scroll observer both read it in the same tick a tab change starts, when
   * state still holds the previous value.
   */
  const categoryRef = useRef("all");
  /*
   * A generation counter, bumped on every reset. Comparing tab names isn't
   * enough: switch A → B → A and a page-2 response from the *first* A still
   * matches, and would append onto a freshly emptied list while overwriting
   * the cursor. A number can only ever match the request that took it.
   */
  const generationRef = useRef(0);
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * Back to wherever you came from. `navigate(-1)` is right when there is a
   * previous entry, but on a direct link, a refresh, or a fresh tab there
   * isn't one and it silently does nothing — react-router marks that first
   * entry with key "default", so fall back to the feed.
   */
  const handleBack = () => {
    if (location.key !== "default") navigate(-1);
    else navigate("/");
  };

  const tabs = visibleNotificationTabs(Boolean(userAuth?.isPrivate));

  /*
   * Switching to a public account removes the Follow requests tab. If it was
   * the selected one, nothing would render as active while the list still
   * showed it.
   */
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === category)) setCategory("all");
    // tabs is rebuilt every render; the privacy flag is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAuth?.isPrivate, category]);

  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);
  const layoutContext = { openCreateModal, closeCreateModal };

  const fetchNotifications = useCallback(
    async ({ append = false } = {}) => {
      if (!userAuth?.token) return;
      if (isFetchingRef.current) return;
      if (append && !hasMoreRef.current) return;

      isFetchingRef.current = true;
      if (append) {
        setIsFetchingMore(true);
      } else {
        setLoading(true);
      }
      const generation = generationRef.current;

      try {
        const params = { limit: 20, category: categoryRef.current };
        if (append && cursorRef.current) {
          params.cursor = cursorRef.current;
        }

        /*
         * First page bypasses the 60s GET cache. A cached page predates any
         * notification that arrived since, yet still carries isRead:false on
         * its rows — so the auto mark-all-read below would clear the badge for
         * something that was never on screen. Subsequent pages are fine cached:
         * they're keyed by cursor and can't go stale in the same way.
         */
        const data = await notificationAPI.getNotifications(params, {
          bypassCache: !append,
        });
        // Superseded while in flight — these rows belong to a list that is
        // already gone.
        if (generationRef.current !== generation) return;
        const fetchedNotifications = data.notifications || [];

        setNotifications((prev) => {
          if (!append) return fetchedNotifications;
          const existingIds = new Set(prev.map((item) => item._id));
          const newNotifications = fetchedNotifications.filter(
            (item) => !existingIds.has(item._id)
          );
          return [...prev, ...newNotifications];
        });

        const nextCursor = data.pageInfo?.nextCursor || null;
        cursorRef.current = nextCursor;
        const nextHasMore = data.pageInfo?.hasNextPage ?? false;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
      } catch (error) {
        if (generationRef.current === generation) {
          console.error("Error fetching notifications:", error);
        }
      } finally {
        /*
         * Guarded too, not just the data. A superseded request clearing
         * `isFetchingRef` re-opens the door to a duplicate concurrent fetch,
         * and its `setLoading(false)` lands while the new tab's list is still
         * empty — which renders "No replies yet" for a moment before the rows
         * arrive.
         */
        if (generationRef.current === generation) {
          isFetchingRef.current = false;
          if (append) {
            setIsFetchingMore(false);
          } else {
            setLoading(false);
          }
        }
      }
    },
    [userAuth?.token]
  );

  // Reload from the top whenever the account or the tab changes.
  useEffect(() => {
    if (!userAuth?.token) return;
    generationRef.current += 1;
    categoryRef.current = category;
    cursorRef.current = null;
    hasMoreRef.current = true;
    isFetchingRef.current = false;
    setHasMore(true);
    setNotifications([]);
    setLoadMoreTrigger(0);
    fetchNotifications({ append: false });
  }, [userAuth?.token, category, fetchNotifications]);

  useEffect(() => {
    if (!userAuth?.token || loadMoreTrigger === 0) return;
    fetchNotifications({ append: true });
  }, [loadMoreTrigger, userAuth?.token, fetchNotifications]);

  // Infinite scroll handler
  useEffect(() => {
    const handleScroll = () => {
      if (
        window.innerHeight + document.documentElement.scrollTop + 1 >=
          document.documentElement.scrollHeight &&
        !loading &&
        !isFetchingMore &&
        hasMore
      ) {
        setLoadMoreTrigger((prev) => prev + 1);
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [loading, isFetchingMore, hasMore]);

  useEffect(() => {
    if (!socket) return;

    const handleNewNotification = (notification) => {
      /*
       * Only prepend it to a tab it belongs in. The categories are the
       * server's to define, so rather than reimplement the mapping here, the
       * narrow tabs simply don't take live rows — they pick it up on the next
       * load. "All" is the tab people watch, and it takes everything.
       *
       * The badge is handled by UnreadNotificationsSync, not here.
       */
      if (categoryRef.current !== "all") return;
      setNotifications((prev) => [notification, ...prev]);
    };

    socket.on("newNotification", handleNewNotification);

    return () => {
      socket.off("newNotification", handleNewNotification);
    };
  }, [socket]);

  useEffect(() => {
    const markAllAsRead = async () => {
      try {
        const unreadNotifications = notifications.filter((n) => !n.isRead);
        if (unreadNotifications.length > 0) {
          /*
           * markAllRead clears the whole inbox, not just this tab, so zeroing
           * the badge is correct even when a narrow tab is open.
           */
          await notificationAPI.markAllRead();
          setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
          setUnreadNotificationCount(0);
        }
      } catch (error) {
        console.error("Error marking notifications as read:", error);
      }
    };

    if (notifications.length > 0) {
      markAllAsRead();
    }
  }, [notifications, userAuth, setUnreadNotificationCount]);

  const handleFollowRequestButton = (e) => {
    e.preventDefault();
    navigate("/followrequests");
  };

  const handleProfileClick = (username) => {
    navigate(`/${username}`);
  };

  const handleNotificationClick = (notification) => {
    const { type, entity, entityType, sender } = notification;

    if (type === "follow" || type === "follow_request" || type === "follow_request_accepted") {
      handleProfileClick(sender.username);
      return;
    }

    // A failure is only actionable from the scheduled list, where it can be
    // rescheduled or cancelled.
    if (type === "scheduled_failed") {
      navigate("/scheduled");
      return;
    }

    if (entity && sender?.username) {
      if (entityType === "Comment") {
        // Navigate to the post that contains the comment — we only have the comment id here,
        // so navigate to the sender's profile as a fallback for now
        handleProfileClick(sender.username);
      } else {
        navigate(`/${sender.username}/post/${entity}`);
      }
    }
  };

  const handleFollowStatusChange = (nextStatus) => {
    if (!nextStatus?.username) return;
    setNotifications((prev) =>
      prev.map((notification) =>
        notification?.sender?.username === nextStatus.username
          ? {
              ...notification,
              sender: {
                ...notification.sender,
                relationship: {
                  ...(notification.sender.relationship || {}),
                  isFollowing: Boolean(nextStatus.isFollowing),
                  isPending: Boolean(nextStatus.isPending),
                  canFollowBack: Boolean(nextStatus.canFollowBack),
                },
              },
            }
          : notification
      )
    );
  };

  const formatCreatedAt = (createdAt) => {
    const postDate = new Date(createdAt);
    const now = new Date();
    const diffInSeconds = Math.floor((now - postDate) / 1000);

    if (diffInSeconds < 60) return `${diffInSeconds}s`;
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) return `${diffInMinutes}m`;
    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) return `${diffInHours}h`;
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) return `${diffInDays}d`;
    const diffInWeeks = Math.floor(diffInDays / 7);
    if (diffInWeeks < 52) return `${diffInWeeks}w`;
    const diffInYears = Math.floor(diffInWeeks / 52);
    return `${diffInYears}y`;
  };

  const getActivityText = (notification) => {
    switch (notification.type) {
      case "like":
        return notification.entityType === "Comment" ? "liked your reply" : "liked your gossip";
      case "comment_like":
        return "liked your reply";
      case "follow":
        return "followed you";
      case "follow_request":
        return "requested to follow you";
      case "mention":
        return notification.entityType === "Comment"
          ? "mentioned you in a reply"
          : "mentioned you in a gossip";
      case "follow_request_accepted":
        return "accepted your follow request";
      case "reply":
        return notification.entityType === "Comment" ? "replied to you" : "replied to your gossip";
      case "quote":
        return "quoted your gossip";
      case "quote_comment":
        return "quoted your reply";
      case "repost":
        return "reposted your gossip";
      case "welcome":
        return notification.sender?.username === "gossips" ? "" : "welcomed you";
      // Sender is the recipient for these — it's the app reporting back on
      // something they scheduled, so the phrasing is second-person.
      case "scheduled_published":
        return notification.entityType === "Comment"
          ? "Your scheduled reply was posted"
          : "Your scheduled gossip was posted";
      case "scheduled_failed":
        return notification.entityType === "Comment"
          ? "Your scheduled reply couldn't be posted"
          : "Your scheduled gossip couldn't be posted";
      default:
        return "";
    }
  };

  return (
    <div className="w-full bg-neutral-950 mb-16">
      {/*
        On a phone the site header is a logo and a menu button — on a page whose
        whole job is one list, that's a row of chrome telling you nothing. It's
        replaced by a bar that says where you are. On desktop the header carries
        the nav, so it stays and the page gets a heading instead.
      */}
      <div className="hidden sm:contents">
        <SiteHeader layoutContext={layoutContext} />
      </div>

      <div className="sm:hidden sticky top-0 z-[100] bg-[#101010D9] backdrop-blur-2xl border-b border-neutral-800">
        <div className="relative flex h-11 items-center justify-center px-2">
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className="absolute left-1 top-1/2 -translate-y-1/2 cursor-pointer rounded-full p-2 hover:bg-neutral-800"
          >
            <Icons.back className="h-5 w-5 text-white" />
          </button>

          <h1 className="text-[16px] font-semibold text-white">Activity</h1>

          {/* The header we just hid was the only way to reach the main menu on
              a phone — without this, /activity is a dead end. */}
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <NavigationMenu />
          </div>
        </div>
      </div>

      <main className="container max-w-[620px] px-4 sm:px-6 bg-neutral-950 mx-auto mt-2">
        <h1 className="hidden sm:block text-[26px] font-bold text-white mb-4">Activity</h1>

        {userAuth.isPrivate && (
          <button
            className="bg-neutral-900 rounded-xl w-full p-4 flex flex-row items-center justify-between font-medium mb-4"
            onClick={handleFollowRequestButton}
          >
            <span>Follow requests</span>
            <Icons.chevronRight />
          </button>
        )}

        {/*
          A scrolling pill row rather than the underlined InPageNavigation used
          elsewhere: that one measures tab widths to position a sliding rule and
          assumes they all fit, which eight labels don't on a phone.
          `scrollbar-none` keeps the strip clean; it still scrolls by drag.
        */}
        <div
          role="tablist"
          aria-label="Notification categories"
          className="flex gap-2 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            const active = category === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(tab.id)}
                className={`shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 text-[14px] font-medium transition-colors ${
                  active
                    ? "bg-white text-black"
                    : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col">
          {loading && notifications.length === 0 ? (
            <div className="flex justify-center py-4">
              <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
            </div>
          ) : notifications.length > 0 ? (
            <>
              {notifications.map((notification) => (
                <div
                  key={notification._id}
                  className="flex relative items-center justify-between py-4 px-3 border-b border-neutral-800 cursor-pointer hover:bg-neutral-900"
                  onClick={() => handleNotificationClick(notification)}
                >
                  <div className="flex space-x-3 w-full">
                    <div
                      className="relative"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleProfileClick(notification.sender.username);
                      }}
                    >
                      <img
                        src={
                          notification.sender.profilePic || "/default-profile.png"
                        }
                        alt={notification.sender.username}
                        className="h-10 w-10 rounded-full border border-neutral-800"
                        referrerPolicy="no-referrer"
                      />
                      {notification.type === "like" && (
                        <Icons.activityheart className="absolute -bottom-1 -right-1 border-2 border-neutral-950 bg-rose-500 rounded-full h-5 w-5" />
                      )}
                      {notification.type === "repost" && (
                        <Icons.activityrepost className="absolute -bottom-1 -right-1 border-2 border-neutral-950 bg-[#c329bf] rounded-full h-5 w-5" />
                      )}
                      {notification.type === "quote" && (
                        <Icons.activityquote className="absolute -bottom-1 -right-1 bg-[#fe7900] border-2 border-neutral-950 rounded-full h-5 w-5" />
                      )}
                      {notification.type === "follow" && (
                        <Icons.activityfollow className="absolute -bottom-1 -right-1 bg-[#6e3def] border-2 border-neutral-950 rounded-full h-5 w-5" />
                      )}
                      {notification.type === "reply" && (
                        <Icons.activityreply className="absolute -bottom-1 -right-1 bg-[#24c3ff] border-2 border-neutral-950 rounded-full h-5 w-5" />
                      )}
                      {notification.type === "welcome" && (
                        <Icons.activityheart className="absolute top-6 -right-1 bg-rose-600 border-2 border-neutral-950 rounded-full h-5 w-5" />
                      )}
                      {notification.type === "scheduled_published" && (
                        <Clock className="absolute -bottom-1 -right-1 bg-emerald-600 text-white border-2 border-neutral-950 rounded-full h-5 w-5 p-0.5" />
                      )}
                      {notification.type === "scheduled_failed" && (
                        <Clock className="absolute -bottom-1 -right-1 bg-rose-600 text-white border-2 border-neutral-950 rounded-full h-5 w-5 p-0.5" />
                      )}
                    </div>
                    <div className="flex flex-col flex-1 min-w-0">
                      <div className="flex space-x-1 max-w-[calc(100%-120px)]">
                        <p
                          className="text-white font-medium hover:underline truncate"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleProfileClick(notification.sender.username);
                          }}
                        >
                          {notification.sender.username}
                        </p>
                        {(notification.type === "like" &&
                          (notification.groupedLikeCount || 1) > 1) && (
                          <p className="text-white font-medium truncate">
                            and {(notification.groupedLikeCount || 1) - 1} others
                          </p>
                        )}
                        {notification.sender.isVerified && (
                          <span className="inline-flex items-center mt-0.5 flex-shrink-0">
                            <Icons.verified />
                          </span>
                        )}
                        <p className="text-neutral-500 text-sm ml-1 mt-0.5 flex-shrink-0">
                          {formatCreatedAt(notification.createdAt)}
                        </p>
                      </div>
                      <p className="text-neutral-400 text-sm truncate">
                        {getActivityText(notification)}
                      </p>
                      {notification.type === "welcome" && (
                        <p className="text-white mt-1">
                          Hey {userAuth.name}! Welcome to Gossips. I hope you like
                          this project. If so, please make sure to give it a star
                          on GitHub and share your views on Twitter. Thanks.
                        </p>
                      )}
                    </div>
                  </div>
                  {notification.type === "follow" && (
                    <div className="absolute right-2 flex items-center justify-center bg-neutral-800 rounded-xl font-medium h-10 w-26">
                      <FollowButton
                        username={notification.sender.username}
                        currentUserFollowing={userAuth?.following}
                        initialState={notification.sender?.relationship}
                        disableStatusFetch={Boolean(
                          notification.sender?.relationship
                        )}
                        onFollowStatusChange={handleFollowStatusChange}
                      />
                    </div>
                  )}
                </div>
              ))}

              {isFetchingMore && (
                <div className="flex justify-center py-4">
                  <Icons.spinner className="animate-spin h-6 w-6 text-neutral-400" />
                </div>
              )}
            </>
          ) : (
            <p className="text-neutral-400 text-center py-10">
              {emptyNotificationMessage(category)}
            </p>
          )}
        </div>
      </main>
      <CreatePost isOpen={isCreateModalOpen} onClose={closeCreateModal} />
      <MobileNavbar layoutContext={layoutContext} />
    </div>
  );
};

export default ActivityPage;
