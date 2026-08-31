import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { Icons } from "./icons";
import ResponsivePanel from "./ui/responsive-panel";
import SortMenu from "./ui/SortMenu";
import FollowButton from "./FollowButton";
import FollowsYouBadge from "./FollowsYouBadge";
import { UserContext } from "../contexts/UserContext";
import { userAPI } from "../services/api";
import { useDebounce } from "../hooks/useDebounce";

/**
 * Followers / Following lists — a full page on a phone, a modal on desktop.
 *
 * Rebuilt from the react-modal version on ResponsivePanel, with search and
 * sort done by the API rather than filtering the loaded page: a list of ten
 * thousand followers has to be searched where the data lives, not in whatever
 * slice happens to be scrolled in.
 */

const SORT_OPTIONS = [
  { value: "default", label: "Default", hint: "People you interact with first" },
  { value: "latest", label: "Latest first", hint: "Most recently followed" },
  { value: "earliest", label: "Earliest first", hint: "Followed longest ago" },
];

const PAGE_SIZE = 20;

/**
 * One row. The layout contract: username and name may truncate, the verified
 * badge and the follow button may not. That's plain flexbox — the text block
 * is `min-w-0 flex-1` with `truncate` on the text spans only, and everything
 * that must survive is `shrink-0` outside them.
 */
const UserRow = ({ user, isSelf, onNavigate, onFollowStatusChange }) => (
  <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
    <img
      src={user.profilePic}
      alt={user.username}
      referrerPolicy="no-referrer"
      onClick={() => onNavigate(user.username)}
      className="h-10 w-10 shrink-0 cursor-pointer rounded-full border border-neutral-800 bg-neutral-800 object-cover"
    />

    <div
      className="min-w-0 flex-1 cursor-pointer"
      onClick={() => onNavigate(user.username)}
    >
      <div className="flex items-center gap-1">
        <span className="truncate font-medium text-white hover:underline">
          {user.username}
        </span>
        {user.isVerified && (
          <span className="inline-flex shrink-0 items-center">
            <Icons.verified />
          </span>
        )}
        {/* "Follows you" badge is gated through canUsePremiumFeature inside <FollowsYouBadge />.
            Currently ungated for all users; turning on followsYouBadge in lib/premium.js will restrict it to subscribers. */}
        {user.relationship?.canFollowBack && !isSelf && <FollowsYouBadge />}
      </div>
      {user.name && <p className="truncate text-sm text-neutral-500">{user.name}</p>}
    </div>

    {!isSelf && (
      // The pill background belongs to the wrapper, not FollowButton — the
      // button only renders its label. Fixed width keeps the four states
      // (Follow / Following / Requested / Follow back) from resizing the row.
      <div className="flex h-10 w-[104px] shrink-0 items-center justify-center rounded-xl bg-neutral-800 font-medium transition-colors hover:bg-neutral-700">
        <FollowButton
          username={user.username}
          isPrivate={user.isPrivate}
          initialState={user.relationship}
          disableStatusFetch={Boolean(user.relationship)}
          onFollowStatusChange={onFollowStatusChange}
        />
      </div>
    )}
  </div>
);

const FollowersModal = ({
  isOpen,
  onClose,
  username,
  followerCount = 0,
  followingCount = 0,
  initialTab = 0,
}) => {
  const { userAuth } = useContext(UserContext);
  const navigate = useNavigate();

  const [tab, setTab] = useState(initialTab); // 0 followers, 1 following
  const [sort, setSort] = useState("default");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query.trim(), 350);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const listRef = useRef(null);
  const sentinelRef = useRef(null);
  // Kills responses that arrive after the tab/search/sort has moved on.
  const requestId = useRef(0);
  /*
   * Pagination lives in a ref, not in state, and this is the whole fix for
   * "sort and search do nothing".
   *
   * Both the reset effect and the scroll observer depend on `fetchPage`, so
   * changing the sort or the search term re-runs both. The observer's sentinel
   * is always on screen for a short list, so it fired immediately — and
   * because `setCursor(null)` hadn't rendered yet, it fired with the *previous*
   * query's cursor. That second request won the requestId race and overwrote
   * the correct one, so the list came back unsorted and unfiltered every time.
   *
   * Writing cursor/hasMore synchronously here means the observer sees
   * `hasMore: false` the instant a reset starts and stays quiet until the real
   * page lands.
   */
  const stateRef = useRef({ cursor: null, hasMore: false, loading: false });

  const fetchPage = useCallback(
    async ({ reset = false } = {}) => {
      const id = ++requestId.current;
      // The ref is written synchronously, not via state: the observer below
      // reads it in the same tick and would otherwise still see the previous
      // page's values.
      stateRef.current.loading = true;
      if (reset) {
        stateRef.current.cursor = null;
        stateRef.current.hasMore = false;
      }
      setLoading(true);
      setError("");

      try {
        const call = tab === 0 ? userAPI.getFollowers : userAPI.getFollowingUsers;
        const data = await call(username, {
          q: debouncedQuery || undefined,
          sort,
          cursor: reset ? undefined : stateRef.current.cursor || undefined,
          limit: PAGE_SIZE,
        });
        if (id !== requestId.current) return;

        setItems((prev) => {
          if (reset) return data.users;
          // The ranked sort pages by offset, so a follow landing mid-scroll
          // can re-serve a row; keyed by username, duplicates must be dropped.
          const seen = new Set(prev.map((u) => u.username));
          return [...prev, ...data.users.filter((u) => !seen.has(u.username))];
        });
        stateRef.current.cursor = data.pageInfo?.nextCursor || null;
        stateRef.current.hasMore = Boolean(data.pageInfo?.hasNextPage);
      } catch (err) {
        if (id !== requestId.current) return;
        setError(
          err.response?.status === 403
            ? "This account is private"
            : "Couldn't load the list"
        );
        if (reset) setItems([]);
        stateRef.current.hasMore = false;
      } finally {
        if (id === requestId.current) {
          stateRef.current.loading = false;
          setLoading(false);
        }
      }
    },
    [tab, sort, debouncedQuery, username]
  );

  // Each open starts on the requested tab with a clean search — the component
  // stays mounted between opens, so state would otherwise linger.
  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab);
    setQuery("");
  }, [isOpen, initialTab]);

  // A new tab, search term or sort starts the list over from the top.
  useEffect(() => {
    if (!isOpen) return;
    setItems([]);
    fetchPage({ reset: true });
    listRef.current?.scrollTo?.({ top: 0 });
  }, [isOpen, fetchPage]);

  // Infinite scroll via a sentinel — no scroll-position maths to get wrong.
  useEffect(() => {
    if (!isOpen) return undefined;
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const { hasMore: more, loading: busy } = stateRef.current;
        if (entries[0].isIntersecting && more && !busy) fetchPage();
      },
      { root: listRef.current, rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isOpen, fetchPage, items.length]);

  const handleNavigate = (toUsername) => {
    onClose();
    navigate(`/${toUsername}`);
  };

  /** Keep the row's badge state in step when a follow/unfollow happens. */
  const handleFollowStatusChange = (next) => {
    if (!next?.username) return;
    setItems((prev) =>
      prev.map((u) =>
        u.username === next.username
          ? {
              ...u,
              relationship: {
                ...(u.relationship || {}),
                isFollowing: Boolean(next.isFollowing),
                isPending: Boolean(next.isPending),
                canFollowBack: Boolean(
                  next.canFollowBack ?? u.relationship?.canFollowBack
                ),
              },
            }
          : u
      )
    );
  };

  if (!isOpen) return null;

  const tabs = [
    { label: "Followers", count: followerCount },
    { label: "Following", count: followingCount },
  ];

  return (
    <ResponsivePanel
      title={username}
      onClose={onClose}
      scrollBody={false}
      headerRight={
        <SortMenu value={sort} onChange={setSort} options={SORT_OPTIONS} />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Tabs */}
        <div className="flex shrink-0 border-b border-neutral-800">
          {tabs.map((t, i) => (
            <button
              key={t.label}
              type="button"
              onClick={() => setTab(i)}
              className={`flex-1 cursor-pointer py-3 text-center text-[15px] font-medium transition-colors ${
                tab === i
                  ? "border-b-2 border-white text-white"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-[13px] text-neutral-500">
                {t.count ?? 0}
              </span>
            </button>
          ))}
        </div>

        {/* Search — sent to the API, not filtered client-side. */}
        <div className="shrink-0 px-4 py-2">
          <div className="flex items-center gap-2 rounded-xl bg-neutral-800 px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${tab === 0 ? "followers" : "following"}`}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-neutral-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="shrink-0 cursor-pointer rounded-full p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* The list is the only scrolling region. */}
        <div
          ref={listRef}
          className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {items.map((user) => (
            <UserRow
              key={user.username}
              user={user}
              isSelf={userAuth?.username === user.username}
              onNavigate={handleNavigate}
              onFollowStatusChange={handleFollowStatusChange}
            />
          ))}

          {loading && (
            <div className="flex justify-center py-6">
              <Icons.spinner className="h-7 w-7 animate-spin text-neutral-400" />
            </div>
          )}

          {!loading && error && (
            <p className="px-4 py-10 text-center text-sm text-neutral-500">{error}</p>
          )}

          {!loading && !error && items.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-neutral-500">
              {debouncedQuery
                ? `No one matching “${debouncedQuery}”`
                : tab === 0
                  ? "No followers yet"
                  : "Not following anyone yet"}
            </p>
          )}

          <div ref={sentinelRef} className="h-px" />
        </div>
      </div>
    </ResponsivePanel>
  );
};

export default FollowersModal;
