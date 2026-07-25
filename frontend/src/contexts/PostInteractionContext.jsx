import { createContext, useCallback, useContext, useRef, useState } from "react";

const PostInteractionContext = createContext(null);

/**
 * Tracks like/repost/reply interaction state for every post seen in the current session.
 *
 * Two-tier protection:
 *  - initPost: always writes server data, UNLESS the user has already actively
 *    interacted with that post this session. This lets fresh server data correct
 *    stale feed-cache values (fixing "repost state reverts on refresh") while
 *    still protecting in-flight optimistic updates from being overwritten by a
 *    late-arriving server response.
 *  - updateInteraction: marks the post as "interacted" before writing, so any
 *    subsequent initPost call for that post becomes a no-op for the rest of the
 *    session.
 */
export function PostInteractionProvider({ children }) {
  // { [postId]: { isLiked, likeCount, isReposted, repostCount, replyCount } }
  const [interactions, setInteractions] = useState({});

  // Posts the user has actively acted on this session (like/unlike/repost/unrepost/reply).
  // Stored in a ref so it never triggers re-renders and is never stale inside callbacks.
  const interactedRef = useRef(new Set());

  /**
   * Seed a post's state from server data.
   * Skipped only when the user has already interacted with the post this session,
   * so a stale feed-cache value can still be overwritten by a fresh server fetch,
   * but a pending optimistic update is never lost.
   */
  const initPost = useCallback((postId, serverData) => {
    if (!postId) return;
    setInteractions((prev) => {
      if (interactedRef.current.has(postId)) return prev;
      return { ...prev, [postId]: serverData };
    });
  }, []);

  /**
   * Apply a partial update (optimistic write, server confirmation, or revert).
   * Marks the post as interacted so future initPost calls leave it alone.
   */
  const updateInteraction = useCallback((postId, updates) => {
    if (!postId) return;
    interactedRef.current.add(postId);
    setInteractions((prev) => ({
      ...prev,
      [postId]: { ...(prev[postId] ?? {}), ...updates },
    }));
  }, []);

  return (
    <PostInteractionContext.Provider value={{ interactions, initPost, updateInteraction }}>
      {children}
    </PostInteractionContext.Provider>
  );
}

export function usePostInteraction() {
  const ctx = useContext(PostInteractionContext);
  if (!ctx) throw new Error("usePostInteraction must be used within PostInteractionProvider");
  return ctx;
}
