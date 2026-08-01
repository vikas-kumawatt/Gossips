import React from "react";
import RichText from "./RichText";

/**
 * A post or reply's text.
 *
 * `mentionUsernames` comes from the server with the post — the handles whose
 * owners permitted the mention. Anything else stays plain text.
 */
const PostContent = ({ content, mentionUsernames }) => {
  if (!content) return null;

  return (
    <p className="mt-1 mb-2 whitespace-pre-line">
      <RichText content={content} mentionUsernames={mentionUsernames} />
    </p>
  );
};

export default PostContent;