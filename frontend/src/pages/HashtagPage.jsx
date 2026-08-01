import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Ban } from "lucide-react";
import SiteHeader from "../components/layouts/site-header";
import MobileNavbar from "../components/layouts/mobile-navbar";
import CreatePost from "../components/CreatePost";
import PostCard from "../components/PostCard";
import { Icons } from "../components/icons";
import { UserContext } from "../contexts/UserContext";
import { useReport } from "../contexts/ReportContext";
import { hashtagAPI } from "../services/api";
import { normalizeTag } from "../lib/richText";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu";
import SortMenu from "../components/ui/SortMenu";

/**
 * Everything carrying one hashtag, posts and replies in one list.
 *
 * They're the same thing here — content someone tagged — and the server merges
 * and sorts them together, so there's nothing to interleave on this side.
 */

const SORT_OPTIONS = [
  { value: "top", label: "Default", hint: "Most engaged first" },
  { value: "latest", label: "Latest", hint: "Newest first" },
  { value: "oldest", label: "Oldest", hint: "Oldest first" },
];

const SORT_LABEL = {
  top: "Default",
  latest: "Latest",
  oldest: "Oldest",
};

const HashtagPage = () => {
  const { tag: rawTag } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { userAuth } = useContext(UserContext);
  const { openReport } = useReport();

  const tag = normalizeTag(rawTag);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const layoutContext = {
    openCreateModal: () => setIsCreateModalOpen(true),
    closeCreateModal: () => setIsCreateModalOpen(false),
  };

  const [sort, setSort] = useState("top");
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ restricted: false, postCount: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  /*
   * Paging in refs, written synchronously. The scroll sentinel can fire in the
   * same tick a sort change starts, when state still holds the previous sort's
   * cursor — the same race the followers list and the GIF picker both hit.
   */
  const pager = useRef({ cursor: null, hasMore: true, loading: false });
  const generation = useRef(0);
  const sentinelRef = useRef(null);

  const load = useCallback(
    async ({ append = false } = {}) => {
      if (!tag) return;
      if (pager.current.loading) return;
      if (append && !pager.current.hasMore) return;

      const gen = generation.current;
      pager.current.loading = true;
      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const data = await hashtagAPI.getContent(tag, {
          sort,
          limit: 10,
          ...(append && pager.current.cursor ? { cursor: pager.current.cursor } : {}),
        });
        // Superseded by a sort change while in flight.
        if (generation.current !== gen) return;

        setMeta({ restricted: Boolean(data.restricted), postCount: data.postCount || 0 });
        setItems((prev) => {
          if (!append) return data.items || [];
          /*
           * Dedupe by id across both kinds. The "top" sort pages by offset, and
           * an offset shifts under you when someone likes a post mid-scroll —
           * so a row can legitimately arrive twice.
           */
          const seen = new Set(prev.map((item) => item._id));
          return [...prev, ...(data.items || []).filter((item) => !seen.has(item._id))];
        });

        pager.current.cursor = data.pageInfo?.nextCursor || null;
        pager.current.hasMore = Boolean(data.pageInfo?.hasNextPage);
        setError("");
      } catch (err) {
        if (generation.current !== gen) return;
        setError(err?.response?.data?.error || "Couldn't load this hashtag");
        pager.current.hasMore = false;
      } finally {
        if (generation.current === gen) {
          pager.current.loading = false;
          setLoadingMore(false);
          setLoading(false);
        }
      }
    },
    [tag, sort]
  );

  // Reload from the top when the tag or the sort changes.
  useEffect(() => {
    generation.current += 1;
    pager.current = { cursor: null, hasMore: true, loading: false };
    setItems([]);
    load({ append: false });
  }, [load]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) load({ append: true });
      },
      { rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [load, items.length]);

  const handleBack = () => {
    if (location.key !== "default") navigate(-1);
    else navigate("/");
  };

  if (!userAuth?.token) return null;

  // A tag that can't exist — someone typed /tag/2024 or /tag/%%% by hand.
  if (!tag) {
    return (
      <div className="w-full bg-neutral-950 min-h-screen">
        <SiteHeader layoutContext={layoutContext} />
        <div className="max-w-xl mx-auto px-4 py-24 text-center">
          <h2 className="text-xl font-bold text-white">Hashtag not found</h2>
          <p className="text-neutral-400 mt-2">That isn't a valid hashtag.</p>
        </div>
        <MobileNavbar layoutContext={layoutContext} />
      </div>
    );
  }

  return (
    <div className="w-full bg-neutral-950 mb-16">
      <div className="hidden sm:contents">
        <SiteHeader layoutContext={layoutContext} />
      </div>

      {/* Phones get the tag itself in the bar rather than the app logo — on a
          page about one thing, that thing is the useful header. */}
      <div className="sm:hidden sticky top-0 z-[100] bg-[#101010D9] backdrop-blur-2xl border-b border-neutral-800">
        <div className="relative flex h-11 items-center justify-center px-2">
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className="absolute left-1 top-1/2 -translate-y-1/2 cursor-pointer rounded-full p-2 hover:bg-neutral-800"
          >
            <Icons.back className="h-5 w-5 text-white" />
          </button>
          <h1 className="max-w-[60%] truncate text-[16px] font-semibold text-white">#{tag}</h1>
          <div className="absolute right-1 top-1/2 -translate-y-1/2">
            <TagMenu tag={tag} onReport={openReport} />
          </div>
        </div>
      </div>

      <main className="container max-w-[620px] px-4 sm:px-6 bg-neutral-950 mx-auto mt-2">
        <div className="hidden sm:flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h1 className="text-[26px] font-bold text-white break-words">#{tag}</h1>
            {!meta.restricted && (
              <p className="text-[14px] text-neutral-500 mt-1">
                {/* Posts and replies together — that's what the registry
                    counts, and two counters is two things to keep honest. */}
                {meta.postCount.toLocaleString()}{" "}
                {meta.postCount === 1 ? "post or reply" : "posts and replies"}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!meta.restricted && (
              <SortMenu
                value={sort}
                onChange={setSort}
                options={SORT_OPTIONS}
                label={SORT_LABEL[sort]}
                title="Sort by"
              />
            )}
            <TagMenu tag={tag} onReport={openReport} />
          </div>
        </div>

        {meta.restricted ? (
          /*
           * Said plainly rather than shown as an empty list. The post using the
           * tag still exists — what's blocked is the tag as a way of finding
           * more of it, and an unexplained empty page reads as a bug.
           */
          <div className="py-20 text-center">
            <Ban className="mx-auto h-10 w-10 text-neutral-600" />
            <h2 className="mt-4 text-[17px] font-semibold text-white">
              This hashtag is restricted
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-neutral-500">
              Posts with this hashtag are hidden because some of them may not follow our
              community guidelines.
            </p>
          </div>
        ) : (
          <>
            {/* Phones get the sort control here — the compact top bar has room
                for a back button, the tag and the overflow menu, and nothing
                else. */}
            <div className="sm:hidden flex justify-end border-b border-neutral-800 pb-2 mb-1">
              <SortMenu
                value={sort}
                onChange={setSort}
                options={SORT_OPTIONS}
                label={SORT_LABEL[sort]}
                title="Sort by"
              />
            </div>

            {loading && items.length === 0 ? (
              <div className="flex justify-center py-10">
                <Icons.spinner className="h-8 w-8 animate-spin text-neutral-400" />
              </div>
            ) : error ? (
              <p className="py-16 text-center text-sm text-neutral-500">{error}</p>
            ) : items.length === 0 ? (
              <p className="py-16 text-center text-sm text-neutral-500">
                Nothing with #{tag} yet.
              </p>
            ) : (
              <div className="flex flex-col">
                {items.map((item) => (
                  <div key={item._id} className="border-b border-neutral-800 py-2">
                    <PostCard
                      item={item}
                      author={item.author}
                      // The server tags each row, since one list now holds both.
                      isComment={item.kind === "reply"}
                      postId={item.kind === "reply" ? item.post?._id || item.post : undefined}
                      disableNestedReplies
                    />
                  </div>
                ))}
              </div>
            )}

            {loadingMore && (
              <div className="flex justify-center py-4">
                <Icons.spinner className="h-6 w-6 animate-spin text-neutral-400" />
              </div>
            )}
            <div ref={sentinelRef} className="h-px" />
          </>
        )}
      </main>

      <CreatePost isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
      <MobileNavbar layoutContext={layoutContext} />
    </div>
  );
};

/**
 * The overflow menu. One item today, but it's the standard place people look
 * for "this shouldn't be here" and a hashtag has no other surface to report
 * from.
 */
const TagMenu = ({ tag, onReport }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        aria-label="Hashtag options"
        className="cursor-pointer rounded-full p-2 text-white transition-colors hover:bg-neutral-800"
      >
        <Icons.more />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      sheetTitle={`#${tag}`}
      align="end"
      className="shadow-xl bg-[#181818] z-[999] rounded-2xl w-[220px] p-0 border border-neutral-700"
    >
      <DropdownMenuItem
        onClick={() =>
          // Its own field, not `username` — a tag is not a handle, and
          // ReportSheet must not offer to block or mute one.
          onReport({ targetType: "hashtag", hashtag: tag })
        }
        className="flex justify-between items-center p-3 mx-2 my-2 tracking-normal select-none font-semibold cursor-pointer text-[15px] text-red-500 active:bg-neutral-950 hover:bg-neutral-800 hover:rounded-xl outline-none"
      >
        <span>Report hashtag</span>
        <Icons.report />
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

export default HashtagPage;
