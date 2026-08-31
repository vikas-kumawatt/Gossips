import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, MoreVertical, UserMinus } from "lucide-react";
import { toast } from "react-hot-toast";
import { Icons } from "./icons";
import ResponsivePanel from "./ui/responsive-panel";
import SortMenu from "./ui/SortMenu";
import FollowButton from "./FollowButton";
import FollowsYouBadge from "./FollowsYouBadge";
import Avatar from "./Avatar";
import RemoveFollowerModal from "./RemoveFollowerModal";
import { UserContext } from "../contexts/UserContext";
import { userAPI } from "../services/api";
import { useDebounce } from "../hooks/useDebounce";

/**
 * Followers / Following lists — a full page on a phone, a modal on desktop.
 *
 * Rebuilt on ResponsivePanel, with search and sort handled by the API.
 * Includes Instagram-style follower removal with 3-dot dropdown menu.
 */

const SORT_OPTIONS = [
  { value: "default", label: "Default", hint: "People you interact with first" },
  { value: "latest", label: "Latest first", hint: "Most recently followed" },
  { value: "earliest", label: "Earliest first", hint: "Followed longest ago" },
];

const PAGE_SIZE = 20;

/**
 * One row in the followers/following list.
 */
const UserRow = ({
  user,
  isSelf,
  isOwnFollowersList,
  onNavigate,
  onFollowStatusChange,
  onRequestRemoveFollower,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMenuOpen]);

  return (
    <div className="flex items-center gap-3 border-b border-neutral-800/80 px-4 py-3 hover:bg-neutral-900/40 transition-colors">
      <div onClick={() => onNavigate(user.username)} className="cursor-pointer">
        <Avatar
          src={user.profilePic}
          name={user.name || user.username}
          size="md"
        />
      </div>

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

      <div className="flex items-center gap-2 shrink-0">
        {!isSelf && (
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

        {isOwnFollowersList && !isSelf && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              aria-label={`Options for ${user.username}`}
              className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
            >
              <MoreVertical className="h-4 w-4" />
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-xl border border-neutral-800 bg-[#161616] py-1 shadow-xl backdrop-blur-md">
                <button
                  type="button"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onRequestRemoveFollower(user);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-red-400 hover:bg-neutral-800/80 transition-colors cursor-pointer"
                >
                  <UserMinus className="h-4 w-4" />
                  Remove follower
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

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
  const [selectedUserToRemove, setSelectedUserToRemove] = useState(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const listRef = useRef(null);
  const sentinelRef = useRef(null);
  const requestId = useRef(0);
  const stateRef = useRef({ cursor: null, hasMore: false, loading: false });

  const isOwnList = userAuth?.username === username;

  const fetchPage = useCallback(
    async ({ reset = false } = {}) => {
      const id = ++requestId.current;
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

  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab);
    setQuery("");
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    setItems([]);
    fetchPage({ reset: true });
    listRef.current?.scrollTo?.({ top: 0 });
  }, [isOpen, fetchPage]);

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

  const handleConfirmRemoveFollower = async () => {
    if (!selectedUserToRemove || isRemoving) return;
    const targetUsername = selectedUserToRemove.username;
    setIsRemoving(true);
    try {
      await userAPI.removeFollower(targetUsername);
      setItems((prev) => prev.filter((u) => u.username !== targetUsername));
      toast.success(`Removed @${targetUsername} from your followers`);
      setSelectedUserToRemove(null);
    } catch (err) {
      console.error("Error removing follower:", err);
      toast.error(err?.response?.data?.error || "Failed to remove follower");
    } finally {
      setIsRemoving(false);
    }
  };

  if (!isOpen) return null;

  const tabs = [
    { label: "Followers", count: followerCount },
    { label: "Following", count: followingCount },
  ];

  return (
    <>
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

          {/* Search */}
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

          {/* List */}
          <div
            ref={listRef}
            className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {items.map((user) => (
              <UserRow
                key={user.username}
                user={user}
                isSelf={userAuth?.username === user.username}
                isOwnFollowersList={isOwnList && tab === 0}
                onNavigate={handleNavigate}
                onFollowStatusChange={handleFollowStatusChange}
                onRequestRemoveFollower={(u) => setSelectedUserToRemove(u)}
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

      <RemoveFollowerModal
        isOpen={Boolean(selectedUserToRemove)}
        user={selectedUserToRemove}
        isAccountPrivate={Boolean(userAuth?.isPrivate)}
        loading={isRemoving}
        onClose={() => setSelectedUserToRemove(null)}
        onConfirm={handleConfirmRemoveFollower}
      />
    </>
  );
};

export default FollowersModal;
