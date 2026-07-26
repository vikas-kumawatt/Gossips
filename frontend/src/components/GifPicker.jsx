import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";

/**
 * Giphy picker. One copy, used by the post composer, the reply composers and
 * both chat inputs — MessageInput and UserConversationPage each had their own
 * before this.
 *
 * Giphy is called directly from the browser rather than proxied, because the
 * key is a public client key and the images are hotlinked from Giphy's CDN
 * anyway. The server checks the host on submit, so a picker result is the only
 * thing that can end up on a post.
 */

const API_KEY = import.meta.env.VITE_GIPHY_API_KEY;
const LIMIT = 24;
// Giphy rate-limits per key, and searching on every keystroke burns it fast.
const DEBOUNCE_MS = 350;

const GifPicker = ({ onSelect, onClose }) => {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  // Guards against an earlier, slower search overwriting a later one.
  const requestId = useRef(0);

  const load = useCallback(async (term) => {
    if (!API_KEY) {
      setError("GIFs aren't set up on this install");
      setLoading(false);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError("");

    const endpoint = term
      ? `https://api.giphy.com/v1/gifs/search?api_key=${API_KEY}&q=${encodeURIComponent(term)}&limit=${LIMIT}&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${API_KEY}&limit=${LIMIT}&rating=pg-13`;

    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(String(response.status));
      const json = await response.json();
      if (id !== requestId.current) return; // a newer search already landed

      setGifs(
        (json.data || []).map((g) => ({
          id: g.id,
          title: g.title || "GIF",
          // `fixed_width` for the grid so we're not pulling full-size files
          // into a thumbnail; `original` is what gets posted.
          preview: g.images?.fixed_width?.url || g.images?.original?.url,
          url: g.images?.original?.url,
          width: Number(g.images?.original?.width) || null,
          height: Number(g.images?.original?.height) || null,
        })).filter((g) => g.url)
      );
    } catch {
      if (id !== requestId.current) return;
      setError("Couldn't reach Giphy");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => load(query.trim()), query ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  useEffect(() => {
    // Autofocus, but not on touch — it would throw the keyboard up over the grid.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  return (
    <ResponsiveSheet title="Choose a GIF" onClose={onClose} scrollBody={false}>
      {(close) => (
        <div className="flex h-full flex-col">
          <div className="shrink-0 px-4 pt-3 pb-2">
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
                  className="shrink-0 rounded-full p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white cursor-pointer"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar px-4 pb-2">
            {loading ? (
              <div className="flex justify-center py-12">
                <Icons.spinner className="h-7 w-7 animate-spin text-neutral-400" />
              </div>
            ) : error ? (
              <p className="py-12 text-center text-sm text-neutral-500">{error}</p>
            ) : gifs.length === 0 ? (
              <p className="py-12 text-center text-sm text-neutral-500">
                No GIFs for “{query}”
              </p>
            ) : (
              // Two columns of stacked GIFs — a masonry look without the
              // measuring, since Giphy results are wildly different heights.
              <div className="columns-2 gap-2 [column-fill:_balance]">
                {gifs.map((gif) => (
                  <button
                    key={gif.id}
                    type="button"
                    onClick={() => {
                      onSelect({ url: gif.url, width: gif.width, height: gif.height });
                      close();
                    }}
                    className="mb-2 block w-full overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-white cursor-pointer"
                  >
                    <img
                      src={gif.preview}
                      alt={gif.title}
                      loading="lazy"
                      className="w-full bg-neutral-800"
                    />
                  </button>
                ))}
              </div>
            )}
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
