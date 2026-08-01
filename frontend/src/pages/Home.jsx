import { useContext, useState, useEffect, useRef, useCallback } from "react";
import { Home, Users, Clock, Star, Bookmark, Heart } from "lucide-react";
import MobileNavbar from "../components/layouts/mobile-navbar";
import SiteHeader from "../components/layouts/site-header";
import CreatePost from "../components/CreatePost";
import { UserContext } from "../contexts/UserContext";
import PostCard from "../components/PostCard";
import { postAPI } from "../services/api";
import { Icons } from "../components/icons";
import StarOnGithubCard from "../components/StarOnGithubCard";
import {
  getFeedCacheSnapshot,
  setFeedCacheSnapshot,
} from "../utils/feedCache";

const FEED_TABS = [
  { id: "all", label: "All" },
  { id: "following", label: "Following" },
  { id: "latest", label: "Latest" },
  { id: "favorites", label: "Favorites" },
  { id: "saved", label: "Saved" },
  { id: "liked", label: "Liked" },
];

const FEED_EMPTY_CONFIG = {
  all: {
    title: "Nothing in your feed yet",
    description:
      "When people you follow share something new, it will show up here.",
    Icon: Home,
  },
  following: {
    title: "No posts from people you follow",
    description:
      "Follow more accounts to grow this feed, or check back when they post.",
    Icon: Users,
  },
  latest: {
    title: "No recent posts",
    description:
      "Latest shows recent posts from people you follow. Check back soon.",
    Icon: Clock,
  },
  favorites: {
    title: "No favorites yet",
    description:
      "Star chats in Messages or use Add to favorites on a post — posts from those chats show here.",
    Icon: Star,
  },
  saved: {
    title: "No saved posts yet",
    description:
      "Save posts from the ··· menu to keep them here for later.",
    Icon: Bookmark,
  },
  liked: {
    title: "No liked posts yet",
    description:
      "Posts you like will appear here so you can revisit them anytime.",
    Icon: Heart,
  },
};

function FeedEmptyState({ tab }) {
  const cfg = FEED_EMPTY_CONFIG[tab] ?? FEED_EMPTY_CONFIG.all;
  const EmptyIcon = cfg.Icon;
  return (
    <div className="text-neutral-400">
      <EmptyIcon
        className="w-16 h-16 mx-auto mb-4 text-neutral-500"
        strokeWidth={1.35}
        aria-hidden
      />
      <p className="font-medium text-neutral-200 text-[15px]">{cfg.title}</p>
      <p className="text-sm text-neutral-500 mt-2 max-w-sm mx-auto leading-relaxed">
        {cfg.description}
      </p>
    </div>
  );
}

export default function PagesLayout() {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { userAuth } = useContext(UserContext);
  const { token, profilePic, id: authId, _id: authMongoId } = userAuth || {};
  const userId = authId || authMongoId;
  const [posts, setPosts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadMoreTrigger, setLoadMoreTrigger] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [feedTab, setFeedTab] = useState("all");
  const [isRefetching, setIsRefetching] = useState(false);
  const observer = useRef();
  const postIds = useRef(new Set());
  /*
   * A feed entry's identity, decided by the server.
   *
   * Every feed endpoint stamps `feedId`: the post's id for an original, the
   * repost's id for a repost. That's what lets the same post appear both on
   * its own and as somebody's repost without one silently replacing the other.
   *
   * The fallback is only for a post the client made itself — the create
   * response is a Post, not a feed entry, so it has never been through an
   * endpoint that assigns one.
   */
  const entryKey = (post) => post?.feedId || post?._id;
  const shouldFetch = useRef(false);
  const requestEpochRef = useRef(0);
  const refetchInFlightRef = useRef(0);

  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);

  const fetchPage = useCallback(
    async (cursorVal, { bypassCache = false } = {}) => {
      if (feedTab === "saved") {
        return postAPI.getSavedPosts(
          { limit: 10, cursor: cursorVal || undefined },
          { bypassCache }
        );
      }
      if (feedTab === "liked") {
        return postAPI.getLikedPosts(
          { limit: 10, cursor: cursorVal || undefined },
          { bypassCache }
        );
      }
      const params = { limit: 10, cursor: cursorVal || undefined };
      if (feedTab !== "all") {
        params.type = feedTab;
      }
      return postAPI.getFeed(params, { bypassCache });
    },
    [feedTab]
  );

  const refetchPosts = useCallback(async () => {
    if (!token || !userId) return;
    const epoch = ++requestEpochRef.current;
    refetchInFlightRef.current += 1;
    setIsRefetching(true);
    try {
      // bypassCache: true so we always get fresh viewer flags from the server,
      // not a stale 60 s cachedGet entry that pre-dates any interactions.
      const data = await fetchPage(null, { bypassCache: true });
      if (epoch !== requestEpochRef.current) return;

      postIds.current.clear();

      const newPosts = data.posts || [];
      newPosts.forEach((post) => postIds.current.add(entryKey(post)));

      setPosts(newPosts);

      setCursor(data.pageInfo?.nextCursor ?? null);
      setHasMore(data.pageInfo?.hasNextPage ?? false);
      shouldFetch.current = false;
      setFeedCacheSnapshot(userId, feedTab, {
        posts: newPosts,
        cursor: data.pageInfo?.nextCursor ?? null,
        hasMore: data.pageInfo?.hasNextPage ?? false,
      }).catch((error) => {
        console.error("Failed to cache feed snapshot:", error);
      });
    } catch (error) {
      console.error("Error refetching posts:", error);
    } finally {
      refetchInFlightRef.current = Math.max(0, refetchInFlightRef.current - 1);
      if (refetchInFlightRef.current === 0) {
        setIsRefetching(false);
      }
    }
  }, [token, userId, feedTab, fetchPage]);

  const layoutContext = { openCreateModal, closeCreateModal, refetchPosts };

  const switchFeedTab = (tab) => {
    if (tab === feedTab) return;

    setPosts([]);
    setCursor(null);
    setHasMore(true);
    postIds.current.clear();
    setFeedTab(tab);
  };

  useEffect(() => {
    if (!token || !userId) return;
    let cancelled = false;

    const hydrateFromCacheAndRefresh = async () => {
      try {
        const cached = await getFeedCacheSnapshot(userId, feedTab);
        if (cancelled || !cached) {
          refetchPosts();
          return;
        }

        const cachedPosts = Array.isArray(cached.posts)
          ? cached.posts
          : [];
        postIds.current = new Set(cachedPosts.map(entryKey));
        setPosts(cachedPosts);
        setCursor(cached.cursor ?? null);
        setHasMore(Boolean(cached.hasMore));
      } catch (error) {
        console.error("Failed to hydrate cached feed:", error);
      } finally {
        if (!cancelled) {
          refetchPosts();
        }
      }
    };

    hydrateFromCacheAndRefresh();

    return () => {
      cancelled = true;
    };
  }, [token, userId, feedTab, refetchPosts]);

  useEffect(() => {
    if (
      !token ||
      !userId ||
      loading ||
      !hasMore ||
      isRefetching ||
      !shouldFetch.current
    )
      return;

    const loadMore = async () => {
      setLoading(true);
      try {
        const data = await fetchPage(cursor);

        const nextPosts = data.posts || [];
        const newPosts = nextPosts.filter(
          (post) => !postIds.current.has(entryKey(post))
        );
        newPosts.forEach((post) => postIds.current.add(entryKey(post)));

        let combinedPosts = [];
        setPosts((prevPosts) => {
          combinedPosts = [...prevPosts, ...newPosts];
          return combinedPosts;
        });
        let nextCursor = data.pageInfo?.nextCursor ?? null;
        let nextHasMore = data.pageInfo?.hasNextPage ?? false;
        if (
          newPosts.length === 0 &&
          nextHasMore &&
          nextCursor != null &&
          nextCursor === cursor
        ) {
          nextHasMore = false;
        }
        setCursor(nextCursor);
        setHasMore(nextHasMore);
        shouldFetch.current = false;
        setFeedCacheSnapshot(userId, feedTab, {
          posts: combinedPosts,
          cursor: nextCursor,
          hasMore: nextHasMore,
        }).catch((error) => {
          console.error("Failed to cache merged feed:", error);
        });
      } catch (error) {
        console.error("Error fetching posts:", error);
      } finally {
        setLoading(false);
      }
    };

    loadMore();
  }, [
    token,
    userId,
    cursor,
    loadMoreTrigger,
    feedTab,
    hasMore,
    loading,
    isRefetching,
    fetchPage,
  ]);

  const handleNewPost = (rawPost) => {
    if (!rawPost?._id) return;
    // Your own new post is its own entry.
    const newPost = { ...rawPost, feedId: rawPost.feedId || rawPost._id };
    if (postIds.current.has(entryKey(newPost))) return;
    postIds.current.add(entryKey(newPost));
    let nextPosts = [];
    setPosts((prevPosts) => {
      const updatedPosts = [newPost, ...prevPosts];
      const sorted = updatedPosts.sort(
        (a, b) =>
          new Date(b.repostedAt || b.createdAt) -
          new Date(a.repostedAt || a.createdAt)
      );
      nextPosts = sorted;
      return sorted;
    });
    if (userId) {
      setFeedCacheSnapshot(userId, feedTab, {
        posts: nextPosts,
        cursor,
        hasMore,
      }).catch((error) => {
        console.error("Failed to cache post create:", error);
      });
    }
    closeCreateModal();
  };

  const handleDeletePost = (postId) => {
    let nextPosts = [];
    setPosts((prevPosts) => {
      nextPosts = prevPosts.filter((p) => p._id !== postId);
      return nextPosts;
    });
    // A post can occupy more than one entry (its own, plus anyone's repost of
    // it), so rebuild the key set rather than deleting a single id.
    postIds.current = new Set(nextPosts.map(entryKey));
    if (userId) {
      setFeedCacheSnapshot(userId, feedTab, {
        posts: nextPosts,
        cursor,
        hasMore,
      }).catch((error) => {
        console.error("Failed to cache post delete:", error);
      });
    }
  };

  const lastPostRef = useCallback(
    (node) => {
      if (loading || isRefetching) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasMore && !shouldFetch.current) {
            shouldFetch.current = true;
            setLoadMoreTrigger((prev) => prev + 1);
          }
        },
        { threshold: 0.5 }
      );

      if (node) observer.current.observe(node);
    },
    [loading, hasMore, isRefetching]
  );

  return (
    <div className="w-full bg-neutral-950">
      <SiteHeader layoutContext={layoutContext} />
      <main className="container max-w-[620px] px-4 sm:px-6 bg-neutral-950 mx-auto pb-16">
        {/* Feed tabs — same pill style as chat DM filters */}
        <div className="flex items-center justify-start md:justify-center gap-2 mt-2 mb-4 overflow-x-auto scrollbar-hide pb-1">
          {FEED_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`px-4 py-2 rounded-full text-sm font-medium border shrink-0 transition-colors ${
                feedTab === tab.id
                  ? "bg-white text-black border-white"
                  : "bg-neutral-900 text-neutral-300 border-neutral-800 hover:border-neutral-600"
              } cursor-pointer`}
              onClick={() => switchFeedTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {token && (
          <div className="flex flex-row gap-4 mt-4">
            <img
              key={profilePic || "default"}
              src={profilePic || ""}
              alt="Profile"
              className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center border border-neutral-500"
              referrerPolicy="no-referrer"
            />
            <textarea
              placeholder="Share a gossip..."
              className="w-full py-2 px-1 bg-transparent outline-none resize-none"
              onClick={openCreateModal}
              readOnly
            />
            <button
              className="bg-white/10 w-22 h-10 rounded-full cursor-pointer"
              onClick={openCreateModal}
            >
              Post
            </button>
          </div>
        )}

        <hr className="border-0.1 border-neutral-700 -mt-2" />

        {isRefetching && posts.length > 0 && (
          <div className="flex justify-center py-4">
            <Icons.spinner className="animate-spin h-7 w-7 text-neutral-400" />
          </div>
        )}

        <div className="mt-4 space-y-4">
          {posts.length > 0 ? (
            posts.map((post, index) => {
              const isLastPost = index === posts.length - 1;
              return (
                <div
                  key={entryKey(post) || index}
                  ref={isLastPost ? lastPostRef : null}
                  className="border-b border-neutral-800 empty:hidden"
                >
                  <PostCard
                    item={post}
                    author={post.author}
                    onDelete={handleDeletePost}
                    removeOnUnsave={feedTab === "saved"}
                    removeOnUnlike={feedTab === "liked"}
                    removeOnUnrepost={feedTab === "reposts"}
                    onUpdate={(updatedPost) => {
                      setPosts((prevPosts) => {
                        const nextPosts = prevPosts.map((p) =>
                          entryKey(p) === entryKey(updatedPost) ? updatedPost : p
                        );
                        if (userId) {
                          setFeedCacheSnapshot(userId, feedTab, {
                            posts: nextPosts,
                            cursor,
                            hasMore,
                          }).catch(() => {});
                        }
                        return nextPosts;
                      });
                    }}
                    onNewPost={handleNewPost}
                  />
                </div>
              );
            })
          ) : (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 py-12 px-5 sm:px-8 text-center">
              {loading || isRefetching ? (
                <Icons.spinner className="animate-spin mx-auto h-8 w-8 text-neutral-400" />
              ) : (
                <FeedEmptyState tab={feedTab} />
              )}
            </div>
          )}
        </div>

        {loading && posts.length > 0 && !isRefetching && (
          <div className="flex justify-center py-4">
            <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
          </div>
        )}
      </main>

      <MobileNavbar layoutContext={layoutContext} />
      <CreatePost
        isOpen={isCreateModalOpen}
        onClose={closeCreateModal}
        onPostCreated={handleNewPost}
      />
      <div className="left-34 bottom-18 fixed">
        <StarOnGithubCard />
      </div>

      <div className="hidden xl:flex fixed bottom-15 right-8">
        <button
          className="border border-neutral-700 bg-neutral-900 px-7 py-5 rounded-xl text-[14px] shadow-lg font-medium tracking-wide hover:scale-105 active:scale-95 cursor-pointer select-none transform transition-all duration-150 ease-out flex items-center justify-center"
          onClick={() => setIsCreateModalOpen(true)}
        >
          <Icons.plus />
        </button>
      </div>
    </div>
  );
}
