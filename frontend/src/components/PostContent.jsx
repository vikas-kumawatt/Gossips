import React from "react";
import RichText from "./RichText";

/**
 * A post or reply's text.
 *
 * `mentionUsernames` comes from the server with the post — the handles whose
 * owners permitted the mention. Anything else stays plain text.
 *
 * Bottom margin only. The gap above belongs to the card's content wrapper, because it has to
 * apply whether or not there is any text — see the note in PostCard.
 */
const PostContent = ({ content, mentionUsernames }) => {
  if (!content) return null;

  return (
    <p className="mb-2 whitespace-pre-line">
      <RichText content={content} mentionUsernames={mentionUsernames} />
    </p>
  );
};

export default PostContent;