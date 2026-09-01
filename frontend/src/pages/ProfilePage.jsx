import axios from "axios";
import React, {
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
} from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { UserContext } from "../contexts/UserContext";
import InPageNavigation from "../components/InPageNavigation";
import MobileNavbar from "../components/layouts/mobile-navbar";
import SiteHeader from "../components/layouts/site-header";
import CreatePost from "../components/CreatePost";
import { Icons } from "../components/icons";
import FollowButton from "../components/FollowButton";
import PostCard from "../components/PostCard";
import ReplyThread from "../components/ReplyThread";
import FollowersModal from "../components/FollowersModal";
import ShareProfileSheet from "../components/ShareProfileSheet";
import AboutProfileSheet from "../components/AboutProfileSheet";
import RichText from "../components/RichText";
import { buildProfileUrl } from "../lib/profileLink";
import BotBadge from "../components/BotBadge";
import Avatar from "../components/Avatar";
import ProfileHeaderSkeleton from "../components/ProfileHeaderSkeleton";
import ProfileStatusState from "../components/ProfileStatusState";
import { toast } from "react-hot-toast";
import { useMute } from "../contexts/MuteContext";
import { useBlock } from "../contexts/BlockContext";
import { useReport } from "../contexts/ReportContext";
import { userAPI } from "../services/api";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";

// eslint-disable-next-line react-refresh/only-export-components
export const profileDataStructure = {
  _id: "",
  name: "",
  username: "",
  profilePic: "",
  bio: "",
  link: "",
  followersPreview: [],
  followerCount: 0,
  followingCount: 0,
  isVerified: false,
  isPrivate: false,
  relationship: {
    isFollowing: false,
  },
};

const ProfilePage = () => {
  const { profileId } = useParams();
  const { userAuth } = useContext(UserContext);
  const { token, username: currentUsername, profilePic } = userAuth || {};
  const { isMuted, mute: muteAccount, unmute: unmuteAccount } = useMute();
  const { isBlocked, requestBlock, unblock: unblockAccount } = useBlock();
  const { openReport } = useReport();
  const navigate = useNavigate();

  const [profile, setProfile] = useState(profileDataStructure);
  const [isShareProfileOpen, setIsShareProfileOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [posts, setPosts] = useState([]);
  const [replies, setReplies] = useState([]);
  const [reposts, setReposts] = useState([]);
  const [profileLoaded, setProfileLoaded] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isFollowersModalOpen, setIsFollowersModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [repostsLoading, setRepostsLoading] = useState(false);
  const [isPostsFetchingMore, setIsPostsFetchingMore] = useState(false);
  const [isRepliesFetchingMore, setIsRepliesFetchingMore] = useState(false);
  const [isRepostsFetchingMore, setIsRepostsFetchingMore] = useState(false);
  const [postsCursor, setPostsCursor] = useState(null);
  const [repliesCursor, setRepliesCursor] = useState(null);
  const [repostsCursor, setRepostsCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [hasMoreReplies, setHasMoreReplies] = useState(true);
  const [hasMoreReposts, setHasMoreReposts] = useState(true);
  const [postsLoadTrigger, setPostsLoadTrigger] = useState(0);
  const [repliesLoadTrigger, setRepliesLoadTrigger] = useState(0);
  const [repostsLoadTrigger, setRepostsLoadTrigger] = useState(0);
  const [initialLoad, setInitialLoad] = useState(true);
  const [initialRepliesLoad, setInitialRepliesLoad] = useState(true);
  const [initialRepostsLoad, setInitialRepostsLoad] = useState(true);
  const [canViewPosts, setCanViewPosts] = useState(false);
  const [activeTab, setActiveTab] = useState(0);

  const observer = useRef();
  const repliesObserver = useRef();
  const repostsObserver = useRef();

  const profileMuted = isMuted(profileId);

  /*
   * Declared after `profile`, because it reads it during render.
   *
   * The block index is keyed by account id as well as handle, and the id is the half
   * that survives the account renaming itself — so pass the id whenever the profile
   * has loaded, and fall back to the route's handle before that.
   */
  const blockIdentity = profile?._id
    ? { _id: profile._id, username: profileId }
    : profileId;
  const profileBlocked = isBlocked(blockIdentity);
  const isRestricted = Boolean(profile?.relationship?.youRestricted);

  const handleToggleMuteProfile = async () => {
    try {
      if (profileMuted) {
        await unmuteAccount(profileId);
        toast.success(`Unmuted @${profileId}`);
      } else {
        await muteAccount(profileId);
        toast.success(`Muted @${profileId}`);
      }
    } catch {
      toast.error("Something went wrong");
    }
  };

  const handleToggleBlockProfile = () => {
    if (profileBlocked) {
      // `unblock` rethrows so callers can react; unhandled, that was an unhandled
      // promise rejection on every failed unblock. It has already toasted by then.
      unblockAccount(blockIdentity).catch(() => {});
    } else {
      requestBlock({ _id: profile?._id, username: profileId, name: profile?.name });
    }
  };

  const handleToggleRestrictProfile = async () => {
    const next = !isRestricted;
    setProfile((prev) => ({
      ...prev,
      relationship: {
        ...(prev.relationship || {}),
        youRestricted: next,
      },
    }));
    try {
      if (next) {
        await userAPI.restrict(profileId);
        toast.success(`Restricted @${profileId}`);
      } else {
        await userAPI.unrestrict(profileId);
        toast.success(`Removed restriction for @${profileId}`);
      }
    } catch (err) {
      setProfile((prev) => ({
        ...prev,
        relationship: {
          ...(prev.relationship || {}),
          youRestricted: !next,
        },
      }));
      toast.error(
        err?.response?.data?.message ||
          (next ? "Failed to restrict user" : "Failed to remove restriction")
      );
    }
  };

  const handleReportProfile = () => {
    openReport({
      targetType: "user",
      username: profileId,
      name: profile?.name,
    });
  };

  const handleCopyProfileLink = async () => {
    try {
      await navigator.clipboard.writeText(buildProfileUrl(profileId));
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);

  const openFollowersModal = () => setIsFollowersModalOpen(true);
  const closeFollowersModal = () => setIsFollowersModalOpen(false);

  const layoutContext = {
    openCreateModal,
    closeCreateModal,
  };

  const lastPostRef = useCallback(
    (node) => {
      if (loading || isPostsFetchingMore) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          setPostsLoadTrigger((prev) => prev + 1);
        }
      });
      if (node) observer.current.observe(node);
    },
    [loading, isPostsFetchingMore, hasMore]
  );

  const lastReplyRef = useCallback(
    (node) => {
      if (repliesLoading || isRepliesFetchingMore) return;
      if (repliesObserver.current) repliesObserver.current.disconnect();
      repliesObserver.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMoreReplies) {
          setRepliesLoadTrigger((prev) => prev + 1);
        }
      });
      if (node) repliesObserver.current.observe(node);
    },
    [repliesLoading, isRepliesFetchingMore, hasMoreReplies]
  );

  const lastRepostRef = useCallback(
    (node) => {
      if (repostsLoading || isRepostsFetchingMore) return;
      if (repostsObserver.current) repostsObserver.current.disconnect();
      repostsObserver.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMoreReposts) {
          setRepostsLoadTrigger((prev) => prev + 1);
        }
      });
      if (node) repostsObserver.current.observe(node);
    },
    [repostsLoading, isRepostsFetchingMore, hasMoreReposts]
  );

  const handleTabChange = (index) => {
    setActiveTab(index);
    if (index === 1 && replies.length === 0 && canViewPosts) {
      fetchUserReplies();
    }
    if (index === 2 && reposts.length === 0 && canViewPosts) {
      fetchUserReposts();
    }
  };

  const handleFollowStatusChange = async () => {
    setPosts([]);
    setReplies([]);
    setReposts([]);
    setPostsCursor(null);
    setRepliesCursor(null);
    setRepostsCursor(null);
    setHasMore(true);
    setHasMoreReplies(true);
    setHasMoreReposts(true);
    setPostsLoadTrigger(0);
    setRepliesLoadTrigger(0);
    setRepostsLoadTrigger(0);
    setInitialLoad(true);
    setInitialRepliesLoad(true);
    setInitialRepostsLoad(true);
    setIsPostsFetchingMore(false);
    setIsRepliesFetchingMore(false);
    setIsRepostsFetchingMore(false);

    try {
      setProfileLoading(true);
      setNotFound(false);
      const profileResponse = await axios.get(
        `${import.meta.env.VITE_SERVER}/user/${profileId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const updatedProfile = profileResponse.data || profileDataStructure;
      setProfile(updatedProfile);
      setProfileLoaded(profileId);

      const isOwnProfile = profileId === currentUsername;
      const isProfileNotPrivate = !updatedProfile.isPrivate;
      const isFollowing = Boolean(updatedProfile.relationship?.isFollowing);
      setCanViewPosts(isOwnProfile || isProfileNotPrivate || isFollowing);
    } catch (err) {
      if (err.response?.status === 404) setNotFound(true);
      console.error("Error updating follow status:", err);
    } finally {
      setProfileLoading(false);
    }
  };

  const fetchUserProfile = useCallback(async () => {
    if (!token) return;
    try {
      setProfileLoading(true);
      setNotFound(false);
      const profileResponse = await axios.get(
        `${import.meta.env.VITE_SERVER}/user/${profileId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const updatedProfile = profileResponse.data || profileDataStructure;
      setProfile(updatedProfile);
      setProfileLoaded(profileId);

      const isOwnProfile = profileId === currentUsername;
      const isProfileNotPrivate = !updatedProfile.isPrivate;
      const isFollowing = Boolean(updatedProfile.relationship?.isFollowing);
      setCanViewPosts(isOwnProfile || isProfileNotPrivate || isFollowing);
    } catch (err) {
      if (err.response?.status === 404) setNotFound(true);
      console.error("Error fetching profile:", err);
    } finally {
      setProfileLoading(false);
    }
  }, [profileId, token, currentUsername]);

  const fetchUserPosts = useCallback(async () => {
    if (!hasMore || !canViewPosts || !profile?.username || !token) return;

    const isInitial = initialLoad;
    if (isInitial) {
      setLoading(true);
    } else {
      setIsPostsFetchingMore(true);
    }
    try {
      const { data } = await axios.get(
        `${import.meta.env.VITE_SERVER}/posts/${profileId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { cursor: postsCursor, limit: 10 },
        }
      );

      setPosts((prevPosts) => {
        const combinedPosts = initialLoad
          ? data.posts
          : [...prevPosts, ...data.posts];
        return Array.from(
          new Map(combinedPosts.map((post) => [post._id, post])).values()
        );
      });
      setPostsCursor(data.pageInfo?.nextCursor || null);
      setHasMore(data.pageInfo?.hasNextPage ?? false);
      setInitialLoad(false);
    } catch (err) {
      console.error("Error fetching posts:", err);
    } finally {
      if (isInitial) {
        setLoading(false);
      } else {
        setIsPostsFetchingMore(false);
      }
    }
  }, [
    hasMore,
    canViewPosts,
    profile?.username,
    profileId,
    token,
    postsCursor,
    initialLoad,
  ]);

  const fetchUserReplies = useCallback(async () => {
    if (!hasMoreReplies || !canViewPosts || !profile?.username || !token)
      return;

    const isInitial = initialRepliesLoad;
    if (isInitial) {
      setRepliesLoading(true);
    } else {
      setIsRepliesFetchingMore(true);
    }
    try {
      const { data } = await axios.get(
        `${import.meta.env.VITE_SERVER}/user/${profileId}/replies`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { cursor: repliesCursor, limit: 10 },
        }
      );

      setReplies((prevReplies) => {
        const combinedReplies = initialRepliesLoad
          ? data.replies
          : [...prevReplies, ...data.replies];
        return Array.from(
          new Map(combinedReplies.map((reply) => [reply._id, reply])).values()
        );
      });
      setRepliesCursor(data.pageInfo?.nextCursor || null);
      setHasMoreReplies(data.pageInfo?.hasNextPage ?? false);
      setInitialRepliesLoad(false);
    } catch (err) {
      console.error("Error fetching replies:", err);
    } finally {
      if (isInitial) {
        setRepliesLoading(false);
      } else {
        setIsRepliesFetchingMore(false);
      }
    }
  }, [
    hasMoreReplies,
    canViewPosts,
    profile?.username,
    profileId,
    token,
    repliesCursor,
    initialRepliesLoad,
  ]);

  const fetchUserReposts = useCallback(async () => {
    if (!hasMoreReposts || !canViewPosts || !profile?.username || !token)
      return;

    const isInitial = initialRepostsLoad;
    if (isInitial) {
      setRepostsLoading(true);
    } else {
      setIsRepostsFetchingMore(true);
    }
    try {
      const { data } = await axios.get(
        `${import.meta.env.VITE_SERVER}/user/${profileId}/reposts`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { cursor: repostsCursor, limit: 10 },
        }
      );

      setReposts((prevReposts) => {
        const combinedReposts = initialRepostsLoad
          ? data.reposts
          : [...prevReposts, ...data.reposts];
        return Array.from(
          new Map(
            combinedReposts.map((repost) => [repost.content._id, repost])
          ).values()
        );
      });
      setRepostsCursor(data.pageInfo?.nextCursor || null);
      setHasMoreReposts(data.pageInfo?.hasNextPage ?? false);
      setInitialRepostsLoad(false);
    } catch (err) {
      console.error(
        "Error fetching reposts:",
        err.response?.data || err.message
      );
    } finally {
      if (isInitial) {
        setRepostsLoading(false);
      } else {
        setIsRepostsFetchingMore(false);
      }
    }
  }, [
    hasMoreReposts,
    canViewPosts,
    profile?.username,
    profileId,
    token,
    repostsCursor,
    initialRepostsLoad,
  ]);

  useEffect(() => {
    if (!token || profileId === profileLoaded) return;

    setProfile(profileDataStructure);
    setProfileLoaded("");
    setPosts([]);
    setReplies([]);
    setReposts([]);
    setPostsCursor(null);
    setRepliesCursor(null);
    setRepostsCursor(null);
    setHasMore(true);
    setHasMoreReplies(true);
    setHasMoreReposts(true);
    setPostsLoadTrigger(0);
    setRepliesLoadTrigger(0);
    setRepostsLoadTrigger(0);
    setInitialLoad(true);
    setInitialRepliesLoad(true);
    setInitialRepostsLoad(true);
    setIsPostsFetchingMore(false);
    setIsRepliesFetchingMore(false);
    setIsRepostsFetchingMore(false);

    fetchUserProfile();
  }, [profileId, token, fetchUserProfile, profileLoaded]);

  useEffect(() => {
    if (profileLoaded && token && canViewPosts) {
      fetchUserPosts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoaded, postsLoadTrigger, token, canViewPosts]);

  useEffect(() => {
    if (profileLoaded && token && canViewPosts && activeTab === 1) {
      fetchUserReplies();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    profileLoaded,
    repliesLoadTrigger,
    token,
    canViewPosts,
    activeTab,
  ]);

  useEffect(() => {
    if (profileLoaded && token && canViewPosts && activeTab === 2) {
      fetchUserReposts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    profileLoaded,
    repostsLoadTrigger,
    token,
    canViewPosts,
    activeTab,
  ]);

  const renderGossipsTab = () => (
    <div>
      {profileId === currentUsername && (
        <>
          <div className="flex flex-row gap-4">
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
              onClick={() => setIsCreateModalOpen(true)}
              readOnly
            />
            <button
              className="bg-white/10 w-22 h-10 rounded-full cursor-pointer"
              onClick={() => setIsCreateModalOpen(true)}
            >
              Post
            </button>
          </div>
          <hr className="border-0.1 border-neutral-700 -mt-2" />
        </>
      )}
      <div className="mt-4 space-y-4">
        {posts.length > 0 ? (
          posts.map((post, index) => (
            <div
              key={post._id || index}
              ref={index === posts.length - 1 ? lastPostRef : null}
              className="border-b border-neutral-800"
            >
              <PostCard
                item={post}
                author={post.author}
                onDelete={(postId) =>
                  setPosts((prev) => prev.filter((p) => p._id !== postId))
                }
                onUpdate={(updatedPost) =>
                  setPosts((prev) =>
                    prev.map((p) =>
                      p._id === updatedPost._id ? updatedPost : p
                    )
                  )
                }
              />
            </div>
          ))
        ) : (
          <div className="text-center py-10 text-neutral-400">
            {loading && initialLoad ? (
              <Icons.spinner className="animate-spin mx-auto" />
            ) : (
              "No posts available yet."
            )}
          </div>
        )}
      </div>
      {isPostsFetchingMore && (
        <div className="flex justify-center py-4">
          <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
        </div>
      )}
    </div>
  );

  const renderRepliesTab = () => (
    <div className="space-y-4">
      {replies.length > 0 ? (
        replies.map((reply, index) => (
          <ReplyThread
            key={reply._id || index}
            reply={reply}
            isLastReply={index === replies.length - 1}
            lastReplyRef={lastReplyRef}
          />
        ))
      ) : (
        <div className="text-center py-10 text-neutral-400">
          {repliesLoading && initialRepliesLoad ? (
            <Icons.spinner className="animate-spin mx-auto" />
          ) : (
            "No replies available yet."
          )}
        </div>
      )}
      {isRepliesFetchingMore && (
        <div className="flex justify-center py-4">
          <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
        </div>
      )}
    </div>
  );

  const renderRepostsTab = () => (
    <div className="mt-4 space-y-4">
      {reposts.length > 0 ? (
        reposts.map((repost, index) => (
          <div
            key={`${repost.type}-${repost.content._id || index}`}
            ref={index === reposts.length - 1 ? lastRepostRef : null}
            className="border-b border-neutral-800"
          >
            <div className="flex items-center gap-2 text-neutral-400 text-sm mb-2 pl-6">
              <Icons.repost className="w-4 h-4" />
              <span>
                <Link
                  to={`/${profile.username}`}
                  className="text-neutral-400 hover:text-neutral-200 hover:underline"
                >
                  {profile.username}
                </Link>{" "}
                reposted
              </span>
            </div>
            <PostCard
              item={repost.content}
              author={repost.content.author}
              isComment={repost.type === "comment"}
              postId={
                repost.type === "comment" ? repost.content.post?._id : undefined
              }
              removeOnUnrepost={profile.username === currentUsername}
              onDelete={(contentId) =>
                setReposts((prev) =>
                  prev.filter((r) => r.content._id !== contentId)
                )
              }
              onUpdate={(updatedContent) =>
                setReposts((prev) =>
                  prev.map((r) =>
                    r.content._id === updatedContent._id
                      ? { ...r, content: updatedContent }
                      : r
                  )
                )
              }
            />
          </div>
        ))
      ) : (
        <div className="text-center py-10 text-neutral-400">
          {repostsLoading && initialRepostsLoad ? (
            <Icons.spinner className="animate-spin mx-auto" />
          ) : (
            "No reposts available yet."
          )}
        </div>
      )}
      {isRepostsFetchingMore && (
        <div className="flex justify-center py-4">
          <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
        </div>
      )}
    </div>
  );

  const isOwnProfile = profileId === currentUsername;
  const isFollowing = Boolean(profile.relationship?.isFollowing);
  const canViewPrivateContent = isOwnProfile || isFollowing;

  return !token ? (
    <Navigate to="/login" />
  ) : (
    <div className="w-full bg-neutral-950 min-h-screen">
      <SiteHeader
        layoutContext={layoutContext}
        openCreateModal={() => setIsCreateModalOpen(true)}
        closeCreateModal={() => setIsCreateModalOpen(false)}
      />
      {notFound ? (
        <ProfileStatusState type="not-found" />
      ) : profileLoading ? (
        <ProfileHeaderSkeleton isOwnProfile={isOwnProfile} />
      ) : (
        <>
          <div className="max-w-xl mx-auto px-4 pb-16">
            <section className="flex items-center justify-center pt-4">
              <div className="w-full">
                <div className="flex justify-between items-center">
                  <div className="flex flex-col">
                    <div className="flex items-center justify-center">
                      <p className="text-xl md:text-2xl capitalize h-6 text-white font-bold text-nowrap">
                        {profile.name || ""}
                      </p>
                      {profile.isVerified && (
                        <span className="ml-2 mt-1.5 md:mt-3">
                          <Icons.verified2 />
                        </span>
                      )}
                      {/*
                        Beside the name, where a verified tick goes — the two answer the
                        same question about an account and belong in the same place. Not
                        conditional on anything but `isBot`: there is no setting, for an
                        owner or a viewer, that hides it.
                      */}
                      {profile.isBot && (
                        <BotBadge className="ml-2 mt-1.5 md:mt-3" username={profile.username} />
                      )}
                      {profile.isPrivate && (
                        <span className="ml-2 mt-1.5 md:mt-3 text-neutral-400">
                          <Icons.lock className="w-4 h-4" />
                        </span>
                      )}
                    </div>
                    <h1 className="text-white pt-2">
                      {profile.username || ""}
                    </h1>
                  </div>
                  <div className="ml-12">
                    <Avatar
                      src={profile.profilePic}
                      name={profile.name || profile.username}
                      className="w-18 h-18 rounded-full border-2 border-neutral-600"
                    />
                  </div>
                </div>
                <p className="text-white pt-3 max-w-200 whitespace-pre-line">
                  <RichText
                    content={profile.bio || ""}
                    mentionUsernames={profile.bioMentionUsernames}
                  />
                </p>
                <div className="pt-4 text-neutral-400 flex flex-row items-center relative w-full">
                  <div className="flex items-center space-x-1 md:space-x-2 min-w-0 flex-grow">
                    {profile.isPrivate && !canViewPrivateContent ? (
                      <span className="flex items-center text-neutral-400 text-nowrap shrink-0">
                        <span className="text-[15px] md:text-[16px]">
                          {profile.followerCount || 0} followers
                        </span>
                      </span>
                    ) : (
                      <button
                        onClick={openFollowersModal}
                        className="flex items-center hover:text-neutral-200 hover:underline text-nowrap shrink-0"
                      >
                        {profile.followersPreview?.length > 0 && (
                          <div className="flex -space-x-2 mr-2 shrink-0">
                            {profile.followersPreview
                              .slice(0, 3)
                              .map((follower) => (
                              <div key={follower.username}>
                                {follower.profilePic ? (
                                  <img
                                    src={follower.profilePic}
                                    alt={follower.name}
                                    className="w-5 h-5 rounded-full border-2 border-neutral-950"
                                    referrerPolicy="no-referrer"
                                  />
                                ) : (
                                  <div className="w-5 h-5 rounded-full border-2 border-neutral-950 bg-gray-700 flex items-center justify-center text-white text-xs">
                                    {follower.name?.charAt(0) || "?"}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        <span className="text-[15px] md:text-[16px]">
                          {profile.followerCount || 0} followers
                        </span>
                      </button>
                    )}
                    {profile.link && (
                      <>
                        <span className="text-[15px] md:text-[16px]">•</span>
                        <a
                          href={
                            profile.link.startsWith("http")
                              ? profile.link
                              : `https://${profile.link}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 text-[15px] md:text-[16px] hover:underline truncate max-w-[calc(100%-100px)] overflow-hidden text-ellipsis whitespace-nowrap"
                        >
                          {profile.link.replace(/^https?:\/\//, "")}
                        </a>
                      </>
                    )}
                  </div>

                  {profileId === currentUsername ? (
                    /* No menu on your own profile. "About" in the main menu
                       opens the same panel for you. */
                    ""
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="p-2 outline-none rounded-full hover:bg-neutral-800 transform transition-all duration-150 ease-out cursor-pointer flex items-center shrink-0"
                        >
                          <Icons.more />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent sheetTitle="Profile options"
                        align="end"
                        className="shadow-xl bg-[#181818] z-[999] rounded-2xl w-[250px] p-0 border border-neutral-700"
                      >
                        <DropdownMenuItem
                          onClick={handleCopyProfileLink}
                          className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mt-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>Copy link</span>
                          <Icons.copy />
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setIsShareProfileOpen(true)}
                          className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>Share profile</span>
                          <Icons.shareTo />
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setIsAboutOpen(true)}
                          className="flex justify-between items-center cursor-pointer p-3 mx-2 tracking-normal select-none font-semibold text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>About this profile</span>
                          <Icons.about />
                        </DropdownMenuItem>

                        <DropdownMenuItem
                          // onClick={(e) => handleIconClick(e, "add-to-feed")}
                          className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>Add to feed</span>
                          <Icons.chevronRight />
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />

                        <DropdownMenuItem
                          onClick={handleToggleMuteProfile}
                          className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mt-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>{profileMuted ? "Unmute" : "Mute"}</span>
                          {profileMuted ? <Icons.unmute /> : <Icons.mute />}
                        </DropdownMenuItem>

                        <DropdownMenuItem
                          onClick={handleToggleRestrictProfile}
                          className="flex justify-between items-center p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950 text-white hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>{isRestricted ? "Remove restriction" : "Restrict"}</span>
                          <Icons.restrict />
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />

                        <DropdownMenuItem
                          onClick={handleToggleBlockProfile}
                          className="flex justify-between items-center text-red-500 p-3 mx-2 tracking-normal select-none font-semibold mt-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>{profileBlocked ? "Unblock" : "Block"}</span>
                          <Icons.block />
                        </DropdownMenuItem>

                        <DropdownMenuItem
                          onClick={handleReportProfile}
                          className="flex justify-between items-center text-red-500 p-3 mx-2 tracking-normal select-none font-semibold mb-2 cursor-pointer text-[15px] active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
                        >
                          <span>Report</span>
                          <Icons.report />
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            </section>

            <div className="flex justify-center items-center gap-4 mt-2">
              {profileId === currentUsername ? (
                <div className="flex flex-row items-center justify-center gap-2 w-full">
                  <Link
                    to="/profile-setup"
                    className="rounded-lg border border-neutral-800 bg-neutral-900 text-white text-bold py-2 cursor-pointer max-w-xl w-full text-center mt-4 hover:bg-neutral-800"
                  >
                    <span className="font-medium">Edit profile</span>
                  </Link>

                  {/* Copy link and Share to now live inside the sheet, next to
                      the QR code, rather than in a menu of their own. */}
                  <button
                    type="button"
                    onClick={() => setIsShareProfileOpen(true)}
                    className="rounded-lg border border-neutral-800 bg-neutral-900 text-white text-bold py-2 cursor-pointer max-w-xl w-full text-center mt-4 hover:bg-neutral-800"
                  >
                    <span className="font-medium">Share profile</span>
                  </button>

                  
                </div>
              ) : profileBlocked ? (
                <button
                  onClick={handleToggleBlockProfile}
                  className="rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-white py-2 cursor-pointer w-full text-center mt-4 font-medium"
                >
                  Unblock
                </button>
              ) : (
                <div className="flex flex-row items-center justify-center gap-2 w-full">
                  <div className="rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-white text-bold py-2 cursor-pointer max-w-xl w-full text-center mt-4 font-medium">
                    <FollowButton
                      username={profile.username}
                      currentUserFollowing={userAuth.following || []}
                      isPrivate={profile.isPrivate}
                      onFollowStatusChange={handleFollowStatusChange}
                    />
                  </div>
                  <button
                  onClick={() => navigate(`/chat/${profile.username}`)}
                  className="rounded-lg border border-neutral-800 bg-neutral-900 text-white text-bold py-2 cursor-pointer max-w-xl w-full text-center mt-4 hover:bg-neutral-800">
                    <p className="font-medium">Message</p>
                  </button>
                </div>
              )}
            </div>

            <div className="mt-2 ">
              <InPageNavigation
                routes={["Gossips", "Replies", "Reposts"]}
                defaultActiveIndex={activeTab}
                onTabChange={handleTabChange}
              >
                {profileBlocked ? (
                  <ProfileStatusState
                    type="blocked"
                    actionButton={
                      <button
                        onClick={handleToggleBlockProfile}
                        className="rounded-xl border border-neutral-700 bg-neutral-900 px-5 py-2 font-medium text-white hover:bg-neutral-800 transition-colors"
                      >
                        Unblock
                      </button>
                    }
                  />
                ) : !canViewPosts && profile.isPrivate ? (
                  <ProfileStatusState type="private" />
                ) : (
                  <>
                    {activeTab === 0 && renderGossipsTab()}
                    {activeTab === 1 && renderRepliesTab()}
                    {activeTab === 2 && renderRepostsTab()}
                  </>
                )}
              </InPageNavigation>
            </div>
          </div>
        </>
      )}
      <CreatePost
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onPostCreated={(newPost) => setPosts((prev) => [newPost, ...prev])}
      />
      <FollowersModal
        isOpen={isFollowersModalOpen}
        onClose={closeFollowersModal}
        username={profile.username || ""}
        followerCount={profile.followerCount || 0}
        followingCount={profile.followingCount || 0}
      />
      {/* Mounted only while open — the sheet animates itself in on mount and has
          no isOpen prop. Waits for the profile's id, which "Share to" needs to
          address the share. */}
      {isShareProfileOpen && profile.username && profile._id && (
        <ShareProfileSheet
          username={profile.username}
          userId={profile._id}
          onClose={() => setIsShareProfileOpen(false)}
        />
      )}
      {isAboutOpen && profile.username && (
        <AboutProfileSheet
          username={profile.username}
          onClose={() => setIsAboutOpen(false)}
        />
      )}
      <MobileNavbar
        layoutContext={layoutContext}
        openCreateModal={() => setIsCreateModalOpen(true)}
        closeCreateModal={() => setIsCreateModalOpen(false)}
      />
    </div>
  );
};

export default ProfilePage;
