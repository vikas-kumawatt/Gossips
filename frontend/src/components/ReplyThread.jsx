import React, { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import PostCard from "../components/PostCard";

const ReplyThread = ({ reply, isLastReply, lastReplyRef, profileId }) => {
  const parentContent = reply?.parent || reply?.post;
  const isReplyToPost = !reply?.parent && !!reply?.post;

  const parentProfileRef = useRef(null);
  const replyProfileRef = useRef(null);
  const [lineStyle, setLineStyle] = useState({ top: 0, height: 0 });

  const updateLineStyle = useCallback(() => {
    if (parentProfileRef.current && replyProfileRef.current) {
      const parentRect = parentProfileRef.current.getBoundingClientRect();
      const replyRect = replyProfileRef.current.getBoundingClientRect();

      const threadContainer = parentProfileRef.current.closest(".relative.border-b.border-neutral-800");
      const threadRect = threadContainer.getBoundingClientRect();

      const parentBottom = parentRect.bottom;
      const startY = parentBottom + 6; 

      const replyTop = replyRect.top;
      const endY = replyTop;

      const topPosition = startY - threadRect.top;

      const lineHeight = Math.max(endY - startY, 0);

      setLineStyle({
        top: `${topPosition}px`,
        height: `${lineHeight}px`,
      });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      updateLineStyle();
    }, 100); 

    const handleResize = () => {
      requestAnimationFrame(updateLineStyle);
    };

    window.addEventListener("resize", handleResize);

    const observer = new MutationObserver(() => {
      requestAnimationFrame(updateLineStyle);
    });

    if (parentProfileRef.current && replyProfileRef.current) {
      const parentContainer = parentProfileRef.current.closest(".relative");
      const replyContainer = replyProfileRef.current.closest(".relative");
      if (parentContainer) {
        observer.observe(parentContainer, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
      if (replyContainer) {
        observer.observe(replyContainer, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
    }

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
      observer.disconnect();
    };
  }, [reply, updateLineStyle]);

  const shouldRenderParent =
    parentContent &&
    (isReplyToPost
      ? parentContent.author?.username !== profileId
      : parentContent.author?.username !== profileId);

  const postId = reply?.post?._id || reply?.parent?.post?._id;

  return (
    <div
      ref={isLastReply ? lastReplyRef : null}
      className="relative border-b border-neutral-800"
    >
      {shouldRenderParent ? (
        <div className="mb-0">
          {isReplyToPost ? (
            <div className="relative">
              <PostCard
                item={parentContent}
                author={parentContent.author}
                isReply={false}
              />
              <div
                ref={parentProfileRef}
                className="absolute top-0 left-0 w-10 h-10" 
              />
            </div>
          ) : (
            <div className="relative">
              <PostCard
                item={parentContent}
                author={parentContent.author}
                isReply={false}
                depth={0}
                disableNestedReplies={true}
                postId={postId}
                isComment={true}
              />
              <div
                ref={parentProfileRef}
                className="absolute top-0 left-0 w-10 h-10"
              />
            </div>
          )}
        </div>
      ) : (
        parentContent && (
          <div className="mb-2 text-neutral-400 text-sm">
            Replying to a post by{" "}
            <Link
              to={`/profile/${parentContent.author?.username || ""}`}
              className="text-blue-500 hover:underline"
            >
              @{parentContent.author?.username || "unknown"}
            </Link>{" "}
            in the Gossips tab.
          </div>
        )
      )}

      {shouldRenderParent && (
        <div
          className="absolute left-[1.25rem] w-0.5 bg-neutral-600 rounded-3xl"
          style={lineStyle}
        />
      )}

      <div className="pl-0 relative">
        <PostCard
          item={reply}
          author={reply.author}
          isReply={true}
          depth={0}
          disableNestedReplies={true}
          postId={postId}
          isComment={true}
        />
        <div
          ref={replyProfileRef}
          className="absolute top-0 left-0 w-10 h-10"
        />
      </div>
    </div>
  );
};

export default ReplyThread;