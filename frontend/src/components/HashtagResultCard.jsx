import { Link } from "react-router-dom";
import { Hash } from "lucide-react";
import { compactCount } from "../lib/format";

/**
 * One hashtag in the search results.
 *
 * A whole row is the tap target rather than just the text — a tag name can be
 * three characters long, and "#at" is not a comfortable thing to hit on a
 * phone.
 */
const HashtagResultCard = ({ tag, postCount }) => (
  <Link
    to={`/tag/${encodeURIComponent(tag)}`}
    className="flex items-center gap-3 rounded-xl px-1 py-2.5 transition-colors hover:bg-neutral-900"
  >
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-neutral-300">
      <Hash className="h-5 w-5" />
    </span>
    <span className="min-w-0">
      <span className="block truncate text-[15px] font-semibold text-white">#{tag}</span>
      <span className="block text-[13px] text-neutral-500">
        {compactCount(postCount)} {postCount === 1 ? "post" : "posts"}
      </span>
    </span>
  </Link>
);

export default HashtagResultCard;
