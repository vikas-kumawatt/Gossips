import { compactCount } from "../lib/format";

/**
 * The line under a post on its own page: when it was posted, and how many
 * people have seen it.
 *
 * Only on the detail page. In a feed the relative age ("2h") is what you want —
 * you're scanning — but once you've opened a single post the exact moment is
 * part of reading it, which is the same split X and Instagram make.
 *
 * Rendered by PostPage next to the card rather than inside PostCard: the card
 * has two layout branches and a dozen call sites, and none of the others should
 * grow this.
 */

/** "11:43 pm" — in the reader's own time zone, and lowercase. */
const exactTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    /*
     * Locales that use one render "11:43 PM"; lowercase reads as a timestamp
     * rather than as shouting. A 24-hour locale has no meridiem and is
     * untouched.
     */
    .replace(/\s?(AM|PM)$/i, (m) => m.toLowerCase());
};

/** "21 Dec 2025" */
const exactDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const PostMeta = ({ createdAt, views }) => {
  const time = exactTime(createdAt);
  const date = exactDate(createdAt);
  if (!time && !date) return null;

  const count = Number(views) || 0;

  return (
    /*
     * pl-12 lines this up with the action icons rather than the card's edge.
     * The card is `flex gap-2` with a `w-10` avatar, so its content column
     * starts at 40 + 8 = 48px; the like button then pulls back by `-ml-2` and
     * pads by `p-2`, which cancel out, so its icon sits at exactly 48px too.
     */
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-12 pr-1 pb-3 text-[14px] text-neutral-500">
      {/* The machine-readable original, for anyone hovering or using a screen
          reader — the rendered form is deliberately imprecise about the year's
          month and drops the seconds. */}
      <time dateTime={new Date(createdAt).toISOString()} title={new Date(createdAt).toString()}>
        {time}
      </time>
      <span aria-hidden="true">·</span>
      <span>{date}</span>
      <span aria-hidden="true">·</span>
      <span>
        <span className="font-semibold text-neutral-300">{compactCount(count)}</span>{" "}
        {count === 1 ? "view" : "views"}
      </span>
    </div>
  );
};

export default PostMeta;
