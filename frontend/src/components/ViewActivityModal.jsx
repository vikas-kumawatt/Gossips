import React, { useState, useEffect, useRef, useCallback, useContext } from "react";
import axios from "axios";
import { useNavigate } from "react-router";
import { Icons } from "./icons";
import FollowButton from "./FollowButton";
import ResponsivePanel from "./ui/responsive-panel";
import SortMenu from "./ui/SortMenu";
import { UserContext } from "../contexts/UserContext";
import { useFollow } from "../contexts/FollowContext.jsx";

const formatCreatedAt = (createdAt) => {
  const date = new Date(createdAt);
  const diffInSeconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return `${diffInSeconds}s`;
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays}d`;
  const diffInWeeks = Math.floor(diffInDays / 7);
  if (diffInWeeks < 52) return `${diffInWeeks}w`;
  return `${Math.floor(diffInWeeks / 52)}y`;
};

/** Whichever timestamp the list in question carries. */
const actionTimestamp = (user) =>
  user.likedAt || user.repostedAt || user.createdAt;

const ACTIVITY_BADGE = {
  likes: <Icons.activityheart className="absolute -bottom-1 -right-1 border-2 border-neutral-950 bg-rose-500 rounded-full h-5 w-5" />,
  reposts: <Icons.activityrepost className="absolute -bottom-1 -right-1 border-2 border-neutral-950 bg-[#c329bf] rounded-full h-5 w-5" />,
  quotes: <Icons.activityquote className="absolute -bottom-1 -right-1 bg-[#fe7900] border-2 border-neutral-950 rounded-full h-5 w-5" />,
  like: <Icons.activityheart className="absolute -bottom-1 -right-1 border-2 border-neutral-950 bg-rose-500 rounded-full h-5 w-5" />,
  repost: <Icons.activityrepost className="absolute -bottom-1 -right-1 border-2 border-neutral-950 bg-[#c329bf] rounded-full h-5 w-5" />,
  quote: <Icons.activityquote className="absolute -bottom-1 -right-1 bg-[#fe7900] border-2 border-neutral-950 rounded-full h-5 w-5" />,
};

/** One person in any of the activity lists. */
const ActivityRow = ({
  user,
  badgeKey,
  timestamp,
  quoteContent,
  quotePostId,
  onProfileClick,
  onQuoteClick,
  onFollowStatusChange,
  currentUsername,
  currentFollowing,
}) => (
  <div
    className={`flex relative items-center justify-between py-4 px-4 border-b border-neutral-800 ${
      quotePostId ? "cursor-pointer hover:bg-neutral-900" : ""
    }`}
    onClick={quotePostId ? () => onQuoteClick(user.username, quotePostId) : undefined}
  >
    <div className="flex items-center space-x-3 w-full min-w-0">
      <div
        className="relative cursor-pointer shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onProfileClick(user.username);
        }}
      >
        <img
          src={user.profilePic || "/default-profile.png"}
          alt={user.username}
          className="h-10 w-10 rounded-full object-cover bg-neutral-800"
        />
        {ACTIVITY_BADGE[badgeKey]}
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center space-x-1 max-w-[calc(100%-110px)]">
          <p
            className="text-white font-medium cursor-pointer hover:underline truncate"
            onClick={(e) => {
              e.stopPropagation();
              onProfileClick(user.username);
            }}
          >
            {user.username}
          </p>
          {user.isVerified && (
            <span className="inline-flex items-center mt-0.5 flex-shrink-0">
              <Icons.verified />
            </span>
          )}
          <p className="text-neutral-500 text-sm ml-1 mt-0.5 flex-shrink-0">
            {formatCreatedAt(timestamp)}
          </p>
        </div>
        <p className="text-neutral-400 text-sm truncate">{user.name}</p>
        {quoteContent && (
          <p className="text-white text-sm line-clamp-1 mt-1">{quoteContent}</p>
        )}
      </div>
    </div>

    {currentUsername !== user.username && (
      <div
        className="absolute right-4 flex items-center justify-center bg-neutral-800 rounded-xl font-medium h-10 w-24 flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <FollowButton
          username={user.username}
          currentUserFollowing={currentFollowing || []}
          isPrivate={user.isPrivate}
          initialState={user.relationship}
          disableStatusFetch={Boolean(user.relationship)}
          onFollowStatusChange={onFollowStatusChange}
        />
      </div>
    )}
  </div>
);

/** The quoted post shown at the top of every activity screen. */
const PostPreview = ({ post, onProfileClick }) => (
  <div className="border mx-4 mt-4 border-neutral-800 p-4 rounded-xl">
    <div className="flex items-center mb-2">
      <div className="cursor-pointer" onClick={() => onProfileClick(post.author.username)}>
        <img
          src={post.author.profilePic || "/default-profile.png"}
          alt={post.author.username}
          className="h-6 w-6 rounded-full mr-2 object-cover bg-neutral-800"
        />
      </div>
      <div className="flex min-w-0">
        <p
          className="text-white font-medium line-clamp-1 flex items-center hover:underline cursor-pointer"
          onClick={() => onProfileClick(post.author.username)}
        >
          {post.author.username}
        </p>
        {post.author.isVerified && (
          <span className="pl-1.5 pt-0.75 inline-flex items-center">
            <Icons.verified />
          </span>
        )}
        <p className="min-w-fit text-neutral-500 ml-2 flex items-center">
          {formatCreatedAt(post.createdAt)}
        </p>
      </div>
    </div>
    <p className="text-white line-clamp-1">{post.content}</p>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Likes / Reposts / Quotes
// ─────────────────────────────────────────────────────────────────────────────

const UserListPanel = ({ onClose, title, endpoint, token, post }) => {
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const { followUpdates } = useFollow();

  const [sort, setSort] = useState("default");
  const [userList, setUserList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);

  const scrollRef = useRef(null);
  const cursorRef = useRef(null);
  const [loadMoreTrigger, setLoadMoreTrigger] = useState(0);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // Changing the sort invalidates the cursor — it addresses a position in the
  // old ordering — so the list restarts from the top.
  useEffect(() => {
    cursorRef.current = null;
    setCursor(null);
    setHasMore(true);
    setUserList([]);
    setTotal(0);
    setLoadMoreTrigger(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [sort]);

  useEffect(() => {
    let active = true;

    const fetchUsers = async () => {
      const isFirstPage = !cursorRef.current;
      if (isFirstPage) setLoading(true);
      else setIsFetchingMore(true);

      try {
        const { data } = await axios.get(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          params: { cursor: cursorRef.current, limit: 10, sort },
        });
        if (!active) return;

        const fetched = data.users || [];
        setUserList((prev) => (isFirstPage ? fetched : [...prev, ...fetched]));
        setTotal((prev) => (isFirstPage ? fetched.length : prev + fetched.length));
        setCursor(data.pageInfo?.nextCursor || null);
        setHasMore(data.pageInfo?.hasNextPage ?? false);
      } catch (err) {
        console.error(`Error fetching ${title.toLowerCase()}:`, err);
      } finally {
        if (active) {
          setLoading(false);
          setIsFetchingMore(false);
        }
      }
    };

    fetchUsers();
    return () => {
      active = false;
    };
  }, [endpoint, token, sort, loadMoreTrigger, followUpdates, title]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
      if (nearBottom && !loading && !isFetchingMore && hasMore) {
        setLoadMoreTrigger((n) => n + 1);
      }
    };

    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [loading, isFetchingMore, hasMore]);

  const goToProfile = (username) => {
    navigate(`/${username}`);
    onClose();
  };

  const goToQuote = (username, postId) => {
    navigate(`/${username}/post/${postId}`);
    onClose();
  };

  const handleFollowStatusChange = (next) => {
    if (!next?.username) return;
    setUserList((prev) =>
      prev.map((user) =>
        user.username === next.username
          ? {
              ...user,
              relationship: {
                ...(user.relationship || {}),
                isFollowing: Boolean(next.isFollowing),
                isPending: Boolean(next.isPending),
                canFollowBack: Boolean(next.canFollowBack),
              },
            }
          : user
      )
    );
  };

  const listKey = title.toLowerCase();

  return (
    <ResponsivePanel
      onClose={onClose}
      onBack={onClose}
      title={`${total} ${title}`}
      headerRight={<SortMenu value={sort} onChange={setSort} />}
      scrollBody={false}
    >
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar"
      >
        <PostPreview post={post} onProfileClick={goToProfile} />

        {loading ? (
          <div className="flex justify-center py-8">
            <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
          </div>
        ) : userList.length > 0 ? (
          userList.map((user) => (
            <ActivityRow
              key={`${user._id}-${user.quotePostId || ""}`}
              user={user}
              badgeKey={listKey}
              timestamp={actionTimestamp(user)}
              quoteContent={listKey === "quotes" ? user.content : null}
              quotePostId={listKey === "quotes" ? user.quotePostId : null}
              onProfileClick={goToProfile}
              onQuoteClick={goToQuote}
              onFollowStatusChange={handleFollowStatusChange}
              currentUsername={userAuth?.username}
              currentFollowing={userAuth?.following}
            />
          ))
        ) : (
          <p className="text-neutral-400 text-center py-10">
            No {listKey} yet.
          </p>
        )}

        {isFetchingMore && (
          <div className="flex justify-center py-4">
            <Icons.spinner className="animate-spin h-6 w-6 text-neutral-400" />
          </div>
        )}
      </div>
    </ResponsivePanel>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Post activity
// ─────────────────────────────────────────────────────────────────────────────

const StatRow = ({ icon, label, value, onClick, disabled, showChevron }) => (
  <div
    className={`flex items-center p-2 py-4 border-b border-neutral-800 relative ${
      disabled ? "cursor-not-allowed opacity-60" : onClick ? "cursor-pointer" : ""
    }`}
    onClick={disabled ? undefined : onClick}
  >
    {icon}
    <p className="font-medium">
      {label} <span className="absolute right-10 text-end">{value}</span>
    </p>
    {showChevron && <Icons.chevronRight className="h-6 w-6 absolute right-0 ml-1" />}
  </div>
);

const ViewActivityModal = ({ isOpen, onClose, post, token }) => {
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);

  const [sort, setSort] = useState("default");
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openList, setOpenList] = useState(null); // "Likes" | "Reposts" | "Quotes"

  const postId = post?._id;

  const fetchActivity = useCallback(async () => {
    if (!postId) return;
    setLoading(true);
    try {
      const { data } = await axios.get(
        `${import.meta.env.VITE_SERVER}/posts/activity/${postId}`,
        { headers: { Authorization: `Bearer ${token}` }, params: { sort } }
      );
      setActivity(data.activity || []);
    } catch (err) {
      console.error("Error fetching activity:", err);
    } finally {
      setLoading(false);
    }
  }, [postId, token, sort]);

  useEffect(() => {
    if (isOpen) fetchActivity();
  }, [isOpen, fetchActivity]);

  if (!isOpen || !post) return null;

  const isCountHidden = post.hideLikeShareCount === true;
  const viewCount = post.counts?.views || 0;
  const likeCount = post.counts?.likes || 0;
  const repostCount = post.counts?.reposts || 0;
  const quoteCount = post.counts?.quotes || 0;

  const goToProfile = (username) => {
    navigate(`/${username}`);
    onClose();
  };

  const goToQuote = (username, quoteId) => {
    navigate(`/${username}/post/${quoteId}`);
    onClose();
  };

  const handleFollowStatusChange = (next) => {
    if (!next?.username) return;
    setActivity((prev) =>
      prev.map((item) =>
        item?.user?.username === next.username
          ? {
              ...item,
              user: {
                ...item.user,
                relationship: {
                  ...(item.user.relationship || {}),
                  isFollowing: Boolean(next.isFollowing),
                  isPending: Boolean(next.isPending),
                  canFollowBack: Boolean(next.canFollowBack),
                },
              },
            }
          : item
      )
    );
  };

  const lists = {
    Likes: `${import.meta.env.VITE_SERVER}/posts/likes/${post._id}`,
    Reposts: `${import.meta.env.VITE_SERVER}/posts/reposts/${post._id}`,
    Quotes: `${import.meta.env.VITE_SERVER}/posts/quotes/${post._id}`,
  };

  // The sub-list replaces this panel rather than stacking on it — two nested
  // full-screen pages on a phone would trap the user behind two back buttons.
  if (openList) {
    return (
      <UserListPanel
        title={openList}
        endpoint={lists[openList]}
        token={token}
        post={post}
        onClose={() => setOpenList(null)}
      />
    );
  }

  return (
    <ResponsivePanel
      onClose={onClose}
      title="Post activity"
      headerRight={<SortMenu value={sort} onChange={setSort} />}
      scrollBody={false}
    >
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar">
        <PostPreview post={post} onProfileClick={goToProfile} />

        <div className="p-4">
          <StatRow
            icon={<Icons.view className="h-6 w-6 text-neutral-400 mr-4" />}
            label="Views"
            value={viewCount}
          />
          <StatRow
            icon={<Icons.like className="h-6 w-6 mr-4" />}
            label="Likes"
            value={isCountHidden ? "Hidden" : likeCount}
            disabled={isCountHidden}
            onClick={() => setOpenList("Likes")}
            showChevron={!isCountHidden && likeCount > 0}
          />
          <StatRow
            icon={<Icons.repost className="h-6 w-6 mr-4" />}
            label="Reposts"
            value={isCountHidden ? "Hidden" : repostCount}
            disabled={isCountHidden}
            onClick={() => setOpenList("Reposts")}
            showChevron={!isCountHidden && repostCount > 0}
          />
          <StatRow
            icon={<Icons.quote className="h-6 w-6 mr-4" />}
            label="Quotes"
            value={isCountHidden ? "Hidden" : quoteCount}
            disabled={isCountHidden}
            onClick={() => setOpenList("Quotes")}
            showChevron={!isCountHidden && quoteCount > 0}
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
          </div>
        ) : activity.length > 0 ? (
          activity.map((item, index) => (
            <ActivityRow
              key={`${item.type}-${item.user?._id}-${index}`}
              user={item.user}
              badgeKey={item.type}
              timestamp={item.timestamp}
              quoteContent={item.type === "quote" ? item.content : null}
              quotePostId={item.type === "quote" ? item.quotePostId : null}
              onProfileClick={goToProfile}
              onQuoteClick={goToQuote}
              onFollowStatusChange={handleFollowStatusChange}
              currentUsername={userAuth?.username}
              currentFollowing={userAuth?.following}
            />
          ))
        ) : (
          <p className="text-neutral-400 text-center py-10">No activity yet.</p>
        )}
      </div>
    </ResponsivePanel>
  );
};

export default ViewActivityModal;
