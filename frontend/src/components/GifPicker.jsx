import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Flame, Search, Star, X } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import {
  GIF_CATEGORIES,
  getFavoriteGifs,
  getRecentGifs,
  rememberGif,
  toggleFavoriteGif,
} from "../lib/gifCategories";
import { attachmentAPI } from "../services/api";

/**
 * Giphy picker. One copy, used by the post composer, the reply composers and
 * the chat inputs — each of those used to have its own.
 *
 * Giphy is proxied via the backend to protect the API key and handle rate limits.
 */
const PAGE_SIZE = 24;
// Giphy rate-limits per key, and searching on every keystroke burns it fast.
const DEBOUNCE_MS = 350;

const TAB_ICONS = { clock: Clock, star: Star, flame: Flame };

/** Giphy's payload, reduced to what we store and render. */
const toGif = (g) => {
  const preview = g.images?.fixed_width || g.images?.original || {};
  const width = Number(preview.width) || 200;
  const height = Number(preview.height) || 200;
  return {
    id: g.id,
    title: g.title || "GIF",
    // A small still for the grid; the full-size one is what gets sent.
    previewUrl: preview.url || g.images?.original?.url,
    url: g.images?.original?.url,
    width: Number(g.images?.original?.width) || null,
    height: Number(g.images?.original?.height) || null,
    // Kept so a tile can reserve its space before the image arrives — without
    // this every tile is zero-high while loading and the whole grid collapses.
    ratio: width / height,
  };
};

/**
 * Two columns, filled by putting each GIF in whichever is currently shorter.
 *
 * Not CSS `columns-2`: that re-balances the entire grid whenever items are
 * appended, so loading the next page visibly reshuffles what you were already
 * looking at. Assigning in order means existing tiles never move.
 */
const splitColumns = (gifs) => {
  const columns = [[], []];
  const heights = [0, 0];
  for (const gif of gifs) {
    const target = heights[0] <= heights[1] ? 0 : 1;
    columns[target].push(gif);
    // Relative units are fine — only the comparison matters.
    heights[target] += 1 / (gif.ratio || 1);
  }
  return columns;
};

const GifPicker = ({ onSelect, onClose }) => {
  const [tab, setTab] = useState("trending");
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [favorites, setFavorites] = useState(() => getFavoriteGifs());

  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  // Kills responses that arrive after the tab or search has moved on.
  const requestId = useRef(0);
  /*
   * Paging state lives in a ref, written synchronously. The scroll observer
   * reads it in the same tick a reset starts, so state would still hold the
   * previous query's offset and the next page would come from the wrong list.
   */
  const pager = useRef({ offset: 0, hasMore: true, loading: false });

  const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);

  const load = useCallback(async (term, activeTab, { append = false } = {}) => {
    const id = ++requestId.current;

    pager.current.loading = true;
    if (!append) {
      pager.current.offset = 0;
      pager.current.hasMore = true;
    }

    // The two local collections are finite and need no network at all.
    if (!term && (activeTab === "recent" || activeTab === "favorites")) {
      setGifs(activeTab === "recent" ? getRecentGifs() : getFavoriteGifs());
      pager.current = { offset: 0, hasMore: false, loading: false };
      setLoading(false);
      setError("");
      return;
    }


    setLoading(true);
    if (!append) setError("");

    // Typing beats the tab; otherwise the tab's own query drives it.
    const category = GIF_CATEGORIES.find((c) => c.id === activeTab);
    const search = term || category?.query || "";
    const offset = append ? pager.current.offset : 0;

    try {
      const json = await attachmentAPI.getGifs({
        query: search,
        limit: PAGE_SIZE,
        offset
      });
      
      if (id !== requestId.current) return; // a newer request already landed

      const page = (json.data || []).map(toGif).filter((g) => g.url);
      const pagination = json.pagination || {};
      const seen = offset + (pagination.count ?? page.length);

      pager.current.offset = seen;
      // Giphy caps `total_count` on some endpoints, so an empty page is the
      // reliable end-of-list signal.
      pager.current.hasMore =
        page.length > 0 &&
        (pagination.total_count == null || seen < pagination.total_count);

      setGifs((prev) => {
        if (!append) return page;
        // Giphy occasionally repeats an id across pages.
        const known = new Set(prev.map((g) => g.id));
        return [...prev, ...page.filter((g) => !known.has(g.id))];
      });
    } catch {
      if (id !== requestId.current) return;
      pager.current.hasMore = false;
      if (!append) setError("Couldn't reach Giphy");
    } finally {
      if (id === requestId.current) {
        pager.current.loading = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const term = query.trim();
    const timer = setTimeout(() => load(term, tab), term ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [query, tab, load]);

  // Infinite scroll: a sentinel below the grid, watched inside the scroller.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        if (!pager.current.hasMore || pager.current.loading) return;
        load(query.trim(), tab, { append: true });
      },
      { root: scrollRef.current, rootMargin: "300px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [query, tab, load, gifs.length]);

  useEffect(() => {
    // Autofocus, but not on touch — it would throw the keyboard over the grid.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  const handleFavorite = (event, gif) => {
    event.stopPropagation();
    const next = toggleFavoriteGif(gif);
    setFavorites(next);
    // On the favourites tab, unstarring should remove it from view at once.
    if (tab === "favorites" && !query.trim()) setGifs(next);
  };

  const searching = Boolean(query.trim());
  const columns = useMemo(() => splitColumns(gifs), [gifs]);

  const emptyMessage = searching
    ? `No GIFs for “${query.trim()}”`
    : tab === "recent"
      ? "GIFs you send will show up here"
      : tab === "favorites"
        ? "Tap the star on a GIF to save it here"
        : "Nothing to show";

  const renderTile = (gif, close) => (
    <div key={gif.id} className="relative">
      <button
        type="button"
        onClick={() => {
          rememberGif(gif);
          onSelect({ url: gif.url, width: gif.width, height: gif.height });
          close();
        }}
        className="block w-full cursor-pointer overflow-hidden rounded-lg bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-white"
        // The tile holds its shape before the image loads, so the grid doesn't
        // collapse to a stack of zero-height rows on the way in.
        style={{ aspectRatio: String(gif.ratio || 1) }}
      >
        <img
          src={gif.previewUrl}
          alt={gif.title}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </button>
      <button
        type="button"
        onClick={(e) => handleFavorite(e, gif)}
        aria-label={favoriteIds.has(gif.id) ? "Remove from favourites" : "Add to favourites"}
        aria-pressed={favoriteIds.has(gif.id)}
        className="absolute right-1.5 top-1.5 cursor-pointer rounded-full bg-black/60 p-1.5 transition-colors hover:bg-black/80"
      >
        <Star
          className={`h-3.5 w-3.5 ${
            favoriteIds.has(gif.id) ? "fill-amber-300 text-amber-300" : "text-white"
          }`}
        />
      </button>
    </div>
  );

  return (
    <ResponsiveSheet title="Choose a GIF" onClose={onClose} scrollBody={false}>
      {(close) => (
        <div className="flex h-full flex-col">
          <div className="shrink-0 px-4 pt-3">
            <div className="flex items-center gap-2 rounded-xl bg-neutral-800 px-3 py-2">
              <Search className="h-4 w-4 shrink-0 text-neutral-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search Giphy"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-neutral-500"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="shrink-0 cursor-pointer rounded-full p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/*
              Eight categories on one row, no scrolling: each is flex-1 with a
              minimum tap target, so they share the width evenly at any size.
              Hidden while searching — a category and a search term would be
              two competing answers to "what am I looking at".
            */}
            {!searching && (
              <div className="mt-2 flex items-center gap-1">
                {GIF_CATEGORIES.map((category) => {
                  const TabIcon = TAB_ICONS[category.icon];
                  const active = tab === category.id;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => setTab(category.id)}
                      title={category.label}
                      aria-label={category.label}
                      aria-pressed={active}
                      className={`flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-lg text-[15px] transition-colors ${
                        active
                          ? "bg-neutral-700 text-white"
                          : "text-neutral-400 hover:bg-neutral-800"
                      }`}
                    >
                      {TabIcon ? (
                        <TabIcon className="h-[17px] w-[17px]" />
                      ) : (
                        <span aria-hidden="true">{category.emoji}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div
            ref={scrollRef}
            className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2 pt-2"
          >
            {error && gifs.length === 0 ? (
              <p className="py-12 text-center text-sm text-neutral-500">{error}</p>
            ) : !loading && gifs.length === 0 ? (
              <p className="py-12 text-center text-sm text-neutral-500">{emptyMessage}</p>
            ) : (
              <div className="flex gap-2">
                {columns.map((column, i) => (
                  <div key={i} className="flex min-w-0 flex-1 flex-col gap-2">
                    {column.map((gif) => renderTile(gif, close))}
                  </div>
                ))}
              </div>
            )}

            {loading && (
              <div className="flex justify-center py-6">
                <Icons.spinner className="h-7 w-7 animate-spin text-neutral-400" />
              </div>
            )}

            <div ref={sentinelRef} className="h-px" />
          </div>

          {/* Giphy's terms require visible attribution wherever results show. */}
          <div className="shrink-0 border-t border-neutral-800 px-4 py-2 text-center text-[11px] text-neutral-500">
            Powered by GIPHY
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default GifPicker;
