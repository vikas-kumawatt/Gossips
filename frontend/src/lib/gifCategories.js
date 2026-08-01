/**
 * The GIF picker's category strip, plus the two local collections behind it.
 *
 * Recents and favourites live in localStorage rather than on the server: they
 * are a per-device convenience, nobody else ever reads them, and syncing them
 * would mean a new collection and endpoint for something worth very little.
 */

/**
 * Eight tabs, sized to fit one row without scrolling.
 *
 * `query` is what gets sent to Giphy's search endpoint; the two collections
 * and trending have no query because they don't search.
 */
export const GIF_CATEGORIES = [
  { id: "recent", label: "Recent", icon: "clock" },
  { id: "favorites", label: "Favourites", icon: "star" },
  { id: "trending", label: "Trending", icon: "flame" },
  { id: "happy", label: "Happy", emoji: "😄", query: "happy" },
  { id: "love", label: "Love", emoji: "❤️", query: "love" },
  { id: "sad", label: "Sad", emoji: "😢", query: "sad" },
  { id: "thumbsup", label: "Thumbs up", emoji: "👍", query: "thumbs up" },
  { id: "celebration", label: "Celebration", emoji: "🎉", query: "celebration" },
];

const RECENT_KEY = "gossips:gifs:recent";
const FAVORITES_KEY = "gossips:gifs:favorites";
const RECENT_MAX = 24;
const FAVORITES_MAX = 60;

const read = (key) => {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((g) => g?.id && g?.url) : [];
  } catch {
    // Private mode, quota, or someone else's data in the key — start clean.
    return [];
  }
};

const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked. Losing a recents list is not worth an error.
  }
};

export const getRecentGifs = () => read(RECENT_KEY);

/** Most recent first, deduped, capped. */
export const rememberGif = (gif) => {
  if (!gif?.id) return;
  const next = [gif, ...read(RECENT_KEY).filter((g) => g.id !== gif.id)].slice(0, RECENT_MAX);
  write(RECENT_KEY, next);
};

export const getFavoriteGifs = () => read(FAVORITES_KEY);

export const isFavoriteGif = (id) => read(FAVORITES_KEY).some((g) => g.id === id);

/** Returns the new list so the caller can re-render without a second read. */
export const toggleFavoriteGif = (gif) => {
  if (!gif?.id) return read(FAVORITES_KEY);
  const current = read(FAVORITES_KEY);
  const next = current.some((g) => g.id === gif.id)
    ? current.filter((g) => g.id !== gif.id)
    : [gif, ...current].slice(0, FAVORITES_MAX);
  write(FAVORITES_KEY, next);
  return next;
};
