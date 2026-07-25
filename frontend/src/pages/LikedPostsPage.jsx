/* eslint-disable react-hooks/exhaustive-deps */
import React, { useContext, useEffect, useState, useRef, useCallback } from "react";
import { UserContext } from "../contexts/UserContext";
import axios from "axios";
import PostCard from "../components/PostCard";
import MobileNavbar from "../components/layouts/mobile-navbar";
import SiteHeader from "../components/layouts/site-header";
import CreatePost from "../components/CreatePost";
import NoDataMessage from "../components/NoDataMessage";
import { useNavigate } from "react-router-dom";
import { Icons } from "../components/icons";

const LikedPostsPage = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { userAuth } = useContext(UserContext);
  const [likedPosts, setLikedPosts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [loadMoreTrigger, setLoadMoreTrigger] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const navigate = useNavigate();
  const observer = useRef(null);
  const postIds = useRef(new Set());

  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);
  const layoutContext = { openCreateModal, closeCreateModal };

  const fetchLikedPosts = useCallback(
    async () => {
      if (!userAuth?.token || loading) {
        if (!userAuth?.token) navigate("/login");
        return;
      }

      try {
        setLoading(true);
        const url = `${import.meta.env.VITE_SERVER}/posts/liked-posts`;
        const response = await axios.get(url, {
          headers: { Authorization: `Bearer ${userAuth.token}` },
          params: { cursor, limit: 10 },
        });

        const newPosts = response.data.posts.filter(
          (post) => !postIds.current.has(post._id)
        );
        newPosts.forEach((post) => postIds.current.add(post._id));
        setLikedPosts((prevPosts) => [...prevPosts, ...newPosts]);
        setCursor(response.data.pageInfo?.nextCursor || null);
        setHasMore(response.data.pageInfo?.hasNextPage ?? false);
      } catch (error) {
        console.error(
          "Error fetching liked posts:",
          error.response?.status,
          error.message
        );
      } finally {
        setLoading(false);
      }
    },
    [userAuth, navigate, cursor]
  );

  useEffect(() => {
    if (!userAuth?.token) return;
    postIds.current.clear();
    setLikedPosts([]);
    setCursor(null);
    setLoadMoreTrigger(0);
    setHasMore(true);
    fetchLikedPosts();
  }, [userAuth]);

  useEffect(() => {
    if (loadMoreTrigger > 0) {
      fetchLikedPosts();
    }
  }, [loadMoreTrigger]);

  const lastPostRef = useCallback(
    (node) => {
      if (loading || !hasMore) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasMore && !loading) {
            setLoadMoreTrigger((prev) => prev + 1);
          }
        },
        { threshold: 0.5 }
      );

      if (node) observer.current.observe(node);
    },
    [loading, hasMore]
  );

  const handleUpdatePost = (updatedPost) => {
    setLikedPosts((prevPosts) =>
      prevPosts.map((p) => (p._id === updatedPost._id ? updatedPost : p))
    );
  };

  const handleDeletePost = (postId) => {
    setLikedPosts((prevPosts) => prevPosts.filter((p) => p._id !== postId));
    postIds.current.delete(postId);
  };

  if (!userAuth?.token) return null;

  return (
    <div className="w-full bg-neutral-950">
      <SiteHeader layoutContext={layoutContext} />
      <main className="container max-w-[620px] px-4 sm:px-6 bg-neutral-950 mx-auto pb-16">
        <p className="flex justify-center items-center mt-2 mb-4 font-medium ">
          <span>Liked Posts </span>
          <span className="bg-neutral-800 rounded-full p-1 ml-2 mt-0.5">
            <Icons.chevronbottom />
          </span>
        </p>
        <div className="space-y-4">
          {loading && likedPosts.length === 0 ? (
            <div className="text-center py-10 text-neutral-400">
              <Icons.spinner className="animate-spin mx-auto" />
            </div>
          ) : likedPosts.length > 0 ? (
            likedPosts.map((post, index) => {
              const isLastPost = index === likedPosts.length - 1;
              return (
                <div
                  key={post._id}
                  ref={isLastPost ? lastPostRef : null}
                  className="border-b border-neutral-800"
                >
                  <PostCard
                    item={post}
                    author={post.author}
                    onUpdate={handleUpdatePost}
                    onDelete={handleDeletePost}
                    postId={post._id}
                    removeOnUnlike={true} 
                  />
                </div>
              );
            })
          ) : (
            <NoDataMessage message="Posts you like will appear here." />
          )}
        </div>
        {loading && likedPosts.length > 0 && (
          <div className="flex justify-center py-4">
            <Icons.spinner className="animate-spin h-8 w-8 text-neutral-400" />
          </div>
        )}
      </main>

      <MobileNavbar layoutContext={layoutContext} />
      <CreatePost isOpen={isCreateModalOpen} onClose={closeCreateModal} />
    </div>
  );
};

export default LikedPostsPage;