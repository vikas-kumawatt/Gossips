import React, { useEffect, useState, useContext, useRef, useCallback } from "react";
import Modal from "react-modal";
import InPageNavigation from "./InPageNavigation";
import { useNavigate } from "react-router";
import FollowButton from "./FollowButton";
import { Icons } from "./icons";
import { UserContext } from "../contexts/UserContext";
import { userAPI } from "../services/api";

Modal.setAppElement("#root");

const FollowersModal = ({
  isOpen,
  onClose,
  username,
  followerCount = 0,
  followingCount = 0,
}) => {
  const [activeTab, setActiveTab] = useState(0);
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const [followers, setFollowers] = useState([]);
  const [following, setFollowing] = useState([]);
  const [followersCursor, setFollowersCursor] = useState(null);
  const [followingCursor, setFollowingCursor] = useState(null);
  const [followersHasMore, setFollowersHasMore] = useState(true);
  const [followingHasMore, setFollowingHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [followersTotalCount, setFollowersTotalCount] = useState(followerCount);
  const [followingTotalCount, setFollowingTotalCount] = useState(followingCount);
  const [relationshipOverrides, setRelationshipOverrides] = useState({});
  const scrollContainerRef = useRef(null);
  const cacheRef = useRef({
    followers: { items: [], cursor: null, hasMore: true },
    following: { items: [], cursor: null, hasMore: true },
  });

  useEffect(() => {
    cacheRef.current = {
      followers: { items: [], cursor: null, hasMore: true },
      following: { items: [], cursor: null, hasMore: true },
    };
    setFollowers([]);
    setFollowing([]);
    setFollowersCursor(null);
    setFollowingCursor(null);
    setFollowersHasMore(true);
    setFollowingHasMore(true);
    setFollowersTotalCount(followerCount);
    setFollowingTotalCount(followingCount);
    setRelationshipOverrides({});
    setActiveTab(0);
  }, [username, followerCount, followingCount]);

  const applyRelationshipOverrides = useCallback(
    (items) =>
      items.map((user) =>
        relationshipOverrides[user.username]
          ? {
              ...user,
              relationship: {
                ...(user.relationship || {}),
                ...relationshipOverrides[user.username],
              },
            }
          : user
      ),
    [relationshipOverrides]
  );

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !username) return;

    const loadInitial = async () => {
      if (activeTab === 0) {
        if (cacheRef.current.followers.items.length > 0) {
          setFollowers(cacheRef.current.followers.items);
          setFollowersCursor(cacheRef.current.followers.cursor);
          setFollowersHasMore(cacheRef.current.followers.hasMore);
          return;
        }
      } else {
        if (cacheRef.current.following.items.length > 0) {
          setFollowing(cacheRef.current.following.items);
          setFollowingCursor(cacheRef.current.following.cursor);
          setFollowingHasMore(cacheRef.current.following.hasMore);
          return;
        }
      }

      setLoading(true);
      try {
        if (activeTab === 0) {
          const data = await userAPI.getFollowers(username, { limit: 20 });
          const items = applyRelationshipOverrides(data?.users || []);
          setFollowersTotalCount(
            typeof data?.totalCount === "number" ? data.totalCount : followerCount
          );
          const nextCursor = data?.pageInfo?.nextCursor || null;
          const hasNext = Boolean(data?.pageInfo?.hasNextPage);
          setFollowers(items);
          setFollowersCursor(nextCursor);
          setFollowersHasMore(hasNext);
          cacheRef.current.followers = {
            items,
            cursor: nextCursor,
            hasMore: hasNext,
          };
        } else {
          const data = await userAPI.getFollowingUsers(username, { limit: 20 });
          const items = applyRelationshipOverrides(data?.users || []);
          setFollowingTotalCount(
            typeof data?.totalCount === "number"
              ? data.totalCount
              : followingCount
          );
          const nextCursor = data?.pageInfo?.nextCursor || null;
          const hasNext = Boolean(data?.pageInfo?.hasNextPage);
          setFollowing(items);
          setFollowingCursor(nextCursor);
          setFollowingHasMore(hasNext);
          cacheRef.current.following = {
            items,
            cursor: nextCursor,
            hasMore: hasNext,
          };
        }
      } catch (error) {
        console.error("Error loading follow list:", error);
      } finally {
        setLoading(false);
      }
    };

    loadInitial();
  }, [
    activeTab,
    isOpen,
    username,
    followerCount,
    followingCount,
    applyRelationshipOverrides,
  ]);

  useEffect(() => {
    if (!isOpen) return;

    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const onScroll = async () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      if (scrollTop + clientHeight < scrollHeight - 50) return;
      if (loading || isFetchingMore) return;

      if (activeTab === 0) {
        if (!followersHasMore || !followersCursor) return;
      } else {
        if (!followingHasMore || !followingCursor) return;
      }

      setIsFetchingMore(true);
      try {
        if (activeTab === 0) {
          const data = await userAPI.getFollowers(username, {
            limit: 20,
            cursor: followersCursor,
          });
          const incoming = applyRelationshipOverrides(data?.users || []);
          const nextCursor = data?.pageInfo?.nextCursor || null;
          const hasNext = Boolean(data?.pageInfo?.hasNextPage);
          setFollowers((prev) => {
            const merged = [...prev, ...incoming];
            cacheRef.current.followers = {
              items: merged,
              cursor: nextCursor,
              hasMore: hasNext,
            };
            return merged;
          });
          setFollowersCursor(nextCursor);
          setFollowersHasMore(hasNext);
        } else {
          const data = await userAPI.getFollowingUsers(username, {
            limit: 20,
            cursor: followingCursor,
          });
          const incoming = applyRelationshipOverrides(data?.users || []);
          const nextCursor = data?.pageInfo?.nextCursor || null;
          const hasNext = Boolean(data?.pageInfo?.hasNextPage);
          setFollowing((prev) => {
            const merged = [...prev, ...incoming];
            cacheRef.current.following = {
              items: merged,
              cursor: nextCursor,
              hasMore: hasNext,
            };
            return merged;
          });
          setFollowingCursor(nextCursor);
          setFollowingHasMore(hasNext);
        }
      } catch (error) {
        console.error("Error loading more users:", error);
      } finally {
        setIsFetchingMore(false);
      }
    };

    scrollContainer.addEventListener("scroll", onScroll);
    return () => scrollContainer.removeEventListener("scroll", onScroll);
  }, [
    activeTab,
    followersCursor,
    followersHasMore,
    followingCursor,
    followingHasMore,
    isOpen,
    isFetchingMore,
    loading,
    username,
    applyRelationshipOverrides,
  ]);

  const handleFollowStatusChange = (nextStatus) => {
    if (!nextStatus?.username) return;
    const nextRelationship = {
      isFollowing: Boolean(nextStatus.isFollowing),
      isPending: Boolean(nextStatus.isPending),
      canFollowBack: Boolean(nextStatus.canFollowBack),
    };
    setRelationshipOverrides((prev) => ({
      ...prev,
      [nextStatus.username]: nextRelationship,
    }));

    const patchUser = (user) =>
      user.username === nextStatus.username
        ? {
            ...user,
            relationship: {
              ...(user.relationship || {}),
              ...nextRelationship,
            },
          }
        : user;

    setFollowers((prev) => prev.map(patchUser));
    setFollowing((prev) => prev.map(patchUser));
    cacheRef.current.followers.items = cacheRef.current.followers.items.map(patchUser);
    cacheRef.current.following.items = cacheRef.current.following.items.map(patchUser);
  };

  const renderFollowersTab = () => {
    const handleProfileClick = (followerUsername) => {
      navigate(`/${followerUsername}`);
      onClose();
    };

    return (
      <div className="space-y-4 mt-4 mx-2">
        {loading ? (
          <div className="flex justify-center py-4">
            <Icons.spinner className="animate-spin h-6 w-6 text-neutral-400" />
          </div>
        ) : followers.length > 0 ? (
          followers.map((follower) => (
            <div
              key={follower.username}
              className="text-white w-full border-b border-neutral-800 px-3 pb-4"
            >
              <div className="flex gap-3">
                <div
                  className="cursor-pointer"
                  onClick={() => handleProfileClick(follower.username)}
                >
                  <img
                    className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
                    src={follower.profilePic}
                    alt="Profile"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="flex-1">
                  <div className="flex flex-row justify-start items-center relative">
                    <div
                      className="cursor-pointer"
                      onClick={() => handleProfileClick(follower.username)}
                    >
                      <p className="text-white font-medium line-clamp-1 flex items-center hover:underline">
                        {follower.username}
                        {follower.isVerified && (
                          <span className="pl-1 pt-0.5 inline-flex items-center">
                            <Icons.verified />
                          </span>
                        )}
                      </p>
                      <p className="text-neutral-500">{follower.name}</p>
                    </div>
                    {userAuth?.username === follower.username ? (
                      ""
                    ) : (
                      <div className="absolute right-0 flex items-center justify-center bg-neutral-800 rounded-xl font-medium h-10 w-26">
                        <FollowButton
                          username={follower.username}
                          currentUserFollowing={userAuth?.following || []}
                          isPrivate={follower.isPrivate}
                          initialState={follower.relationship}
                          disableStatusFetch={Boolean(follower.relationship)}
                          onFollowStatusChange={handleFollowStatusChange}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="text-center py-10 text-neutral-400">
            {username} has no followers yet.
          </div>
        )}
      </div>
    );
  };

  const renderFollowingTab = () => {
    const handleProfileClick = (followedUsername) => {
      navigate(`/${followedUsername}`);
      onClose();
    };

    return (
      <div className="space-y-4 mt-4 mx-2">
        {loading ? (
          <div className="flex justify-center py-4">
            <Icons.spinner className="animate-spin h-6 w-6 text-neutral-400" />
          </div>
        ) : following.length > 0 ? (
          following.map((followedUser) => (
            <div
              key={followedUser.username}
              className="text-white w-full border-b border-neutral-800 px-3 pb-4"
            >
              <div className="flex gap-3">
                <div
                  className="cursor-pointer"
                  onClick={() => handleProfileClick(followedUser.username)}
                >
                  <img
                    className="w-10 h-10 rounded-full bg-neutral-800 object-cover border border-neutral-800"
                    src={followedUser.profilePic}
                    alt="Profile"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="flex-1">
                  <div className="flex flex-row justify-start items-center relative">
                    <div
                      className="cursor-pointer"
                      onClick={() => handleProfileClick(followedUser.username)}
                    >
                      <p className="text-white font-medium line-clamp-1 flex items-center hover:underline">
                        {followedUser.username}
                        {followedUser.isVerified && (
                          <span className="pl-1 pt-0.5 inline-flex items-center">
                            <Icons.verified />
                          </span>
                        )}
                      </p>
                      <p className="text-neutral-500">{followedUser.name}</p>
                    </div>

                    {userAuth?.username === followedUser.username ? (
                      ""
                    ) : (
                      <div className="absolute right-0 flex items-center justify-center bg-neutral-800 rounded-xl font-medium h-10 w-26">
                        <FollowButton
                          username={followedUser.username}
                          currentUserFollowing={userAuth?.following || []}
                          isPrivate={followedUser.isPrivate}
                          initialState={followedUser.relationship}
                          disableStatusFetch={Boolean(followedUser.relationship)}
                          onFollowStatusChange={handleFollowStatusChange}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="text-center py-10 text-neutral-400">
            {username} is not following anyone yet.
          </div>
        )}
      </div>
    );
  };

  const routes = [
    <div className="flex flex-col items-center">
      <span className="font-medium">Followers</span>
      <span className="text-sm">{followersTotalCount}</span>
    </div>,
    <div className="flex flex-col items-center">
      <span className="font-medium">Following</span>
      <span className="text-sm">{followingTotalCount}</span>
    </div>,
  ];

  return (
    <Modal
      isOpen={isOpen}
      onRequestClose={onClose}
      className="bg-neutral-950 text-white border border-neutral-800 rounded-2xl max-w-lg w-full ml-4 mr-4 mx-auto pb-2 outline-none"
      overlayClassName="fixed inset-0 bg-black/80 flex items-center justify-center"
    >
      <div className="relative flex flex-col max-h-[70vh] h-full">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div>
            <InPageNavigation
              routes={routes}
              defaultActiveIndex={activeTab}
              onTabChange={setActiveTab}
            />
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar -mt-4" ref={scrollContainerRef}>
            {activeTab === 0 && renderFollowersTab()}
            {activeTab === 1 && renderFollowingTab()}
            {isFetchingMore && (
              <div className="flex justify-center py-4">
                <Icons.spinner className="animate-spin h-6 w-6 text-neutral-400" />
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default FollowersModal;
