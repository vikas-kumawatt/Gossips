import { useNavigate } from "react-router-dom";
import { tokenizeRichText } from "../lib/richText";

/**
 * Text with its @mentions and #hashtags turned into links.
 *
 * Used by posts, replies, bios and chat bubbles, which is the point — three
 * copies of "find the @ and make it blue" is how they end up disagreeing about
 * what an @ is.
 *
 * `mentionUsernames` is the allowed set, decided by the server when the content
 * was written. A handle that isn't in it renders as ordinary text, which is
 * what "this person doesn't allow @mentions from you" looks like: nothing
 * announces it, the link simply isn't there. Omit the prop entirely in a direct
 * message, where every handle links because there's no permission to check.
 *
 * Nothing here renders HTML. The tokeniser returns plain strings and React
 * escapes them, so a post containing markup is a post containing markup.
 */
const RichText = ({ content, mentionUsernames, className = "" }) => {
  const navigate = useNavigate();

  const tokens = tokenizeRichText(content, { mentionUsernames });
  if (!tokens.length) return null;

  /*
   * stopPropagation, because most of these sit inside a PostCard that
   * navigates to the post when clicked. Without it, tapping a hashtag opens
   * the post rather than the tag.
   */
  const go = (event, path) => {
    event.preventDefault();
    event.stopPropagation();
    navigate(path);
  };

  return (
    <span className={className}>
      {tokens.map((token, index) => {
        if (token.type === "text") {
          return <span key={index}>{token.value}</span>;
        }

        const path =
          token.type === "mention" ? `/${token.key}` : `/tag/${encodeURIComponent(token.key)}`;

        return (
          <a
            // Index, because the same handle can legitimately appear twice
            // and the token list is regenerated whole on every render anyway.
            key={index}
            href={path}
            onClick={(event) => go(event, path)}
            className="text-[#4a9eff] hover:underline"
          >
            {token.value}
          </a>
        );
      })}
    </span>
  );
};

export default RichText;
