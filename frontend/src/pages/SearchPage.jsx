import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SlidersHorizontal, X } from "lucide-react";
import SiteHeader from "../components/layouts/site-header";
import MobileNavbar from "../components/layouts/mobile-navbar";
import { Icons } from "../components/icons";
import { UserContext } from "../contexts/UserContext";
import SearchUserCard from "../components/SearchUserCard";
import RecentSearches from "../components/RecentSearches";
import SearchFiltersSheet from "../components/SearchFiltersSheet";
import PostCard from "../components/PostCard";
import CreatePost from "../components/CreatePost";
import { searchAPI, userAPI } from "../services/api";
import {
  DEFAULT_FILTERS,
  MAX_QUERY_LENGTH,
  clearFilterKey,
  countActiveFilters,
  describeActiveFilters,
  filtersAnchorSearch,
  filtersFromUrl,
  filtersToRequestParams,
  filtersToUrlEntries,
} from "../lib/searchFilters";

const TABS = [
  { id: "posts", label: "Posts" },
  { id: "people", label: "People" },
];

const PAGE_SIZE = 15;
const PEOPLE_PAGE_SIZE = 20;
const SUGGESTION_PAGE_SIZE = 20;
const DEBOUNCE_MS = 350;

const EMPTY_LIST = {
  items: [],
  cursor: null,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,
  meta: {},
};

/**
 * Server errors come back in two shapes — `{ error: "message" }` from the
 * controllers and `{ error: { message } }` from the rate limiter. Both have to
 * reduce to a string: rendering the object form would throw in React.
 */
const errorMessage = (error, fallback) => {
  const payload = error?.response?.data?.error;
  if (typeof payload === "string") return payload;
  if (typeof payload?.message === "string") return payload.message;
  return fallback;
};

/**
 * Posts and replies share an id space with nothing, but a cursor page boundary
 * can still re-serve a row if content was created mid-scroll, so appends are
 * deduped by kind + id.
 */
const dedupeResults = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind || "user"}-${item._id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Ref for the last row of a list: calls `onHit` when it scrolls into view.
 * Re-created whenever the loader or the enabled flag changes, which is also how
 * it detaches once there's nothing left to load.
 */
const useLastItemRef = (onHit, enabled) => {
  const observerRef = useRef(null);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return useCallback(
    (node) => {
      observerRef.current?.disconnect();
      if (!node || !enabled) return;
      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) onHit();
        },
        { threshold: 0.5 }
      );
      observerRef.current.observe(node);
    },
    [onHit, enabled]
  );
};

const SearchPage = () => {
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const token = userAuth?.token;

  const [searchParams, setSearchParams] = useSearchParams();

  // The URL is the source of truth for what's being searched, so a refresh, a
  // shared link and the back button all land on the same results.
  const query = (searchParams.get("q") || "").slice(0, MAX_QUERY_LENGTH);
  const tab = searchParams.get("tab") === "people" ? "people" : "posts";
  const filters = useMemo(() => filtersFromUrl(searchParams), [searchParams]);

  const [inputValue, setInputValue] = useState(query);
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  const [postResults, setPostResults] = useState(EMPTY_LIST);
  const [peopleResults, setPeopleResults] = useState(EMPTY_LIST);
  const [suggestions, setSuggestions] = useState(EMPTY_LIST);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const inputRef = useRef(null);
  // Only the newest request for a list may write to it — an earlier, slower
  // response would otherwise overwrite the results of the current query.
  const postsRequestRef = useRef(0);
  const peopleRequestRef = useRef(0);
  // What each list currently holds, so switching tabs doesn't refetch results
  // that are already correct.
  const postsLoadedKeyRef = useRef(null);
  const peopleLoadedKeyRef = useRef(null);

  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);
  const layoutContext = { openCreateModal, closeCreateModal };

  const activeFilterCount = countActiveFilters(filters);
  const filterChips = useMemo(() => describeActiveFilters(filters), [filters]);

  // Posts can be searched by terms alone, or by a single profile with no terms
  // ("everything @user posted in March"). People search needs terms.
  const canSearchPosts = Boolean(query) || filtersAnchorSearch(filters);
  const canSearchPeople = Boolean(query);
  const isSearching = tab === "posts" ? canSearchPosts : canSearchPeople;

  const requestParams = useMemo(() => filtersToRequestParams(filters), [filters]);
  const postsKey = useMemo(
    () => JSON.stringify({ query, params: requestParams }),
    [query, requestParams]
  );
  const peopleKey = query;

  // ── URL updates ───────────────────────────────────────────────────────────
  const applyUrl = useCallback(
    (next, { replace = false } = {}) => {
      const nextQuery = next.query ?? query;
      const nextTab = next.tab ?? tab;
      const nextFilters = next.filters ?? filters;

      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      if (nextTab !== "posts") params.set("tab", nextTab);
      Object.entries(filtersToUrlEntries(nextFilters)).forEach(([key, value]) => {
        params.set(key, value);
      });

      setSearchParams(params, { replace });
    },
    [query, tab, filters, setSearchParams]
  );

  // Typing updates the URL on a debounce, and replaces rather than pushes —
  // otherwise every keystroke becomes a back-button stop.
  useEffect(() => {
    const trimmed = inputValue.trim();
    if (trimmed === query) return;
    const timer = setTimeout(() => applyUrl({ query: trimmed }, { replace: true }), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue, query, applyUrl]);

  // …and a URL change from elsewhere (back button, a recent search) writes back
  // into the box. Guarded on the trimmed value so it can't fight the debounce
  // while someone is mid-word.
  useEffect(() => {
    setInputValue((current) => (current.trim() === query ? current : query));
  }, [query]);

  // ── Recent searches ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;

    searchAPI
      .history()
      .then((data) => {
        if (!cancelled) setHistory(data?.entries || []);
      })
      .catch(() => {
        // A history failure must not stand in the way of searching.
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * Recorded when a search is committed — Enter, a recent search, or opening a
   * result — never per keystroke, which would fill the list with prefixes of
   * one search. The write is an upsert, so repeats bump the existing row.
   */
  const recordQuery = useCallback((text) => {
    const value = (text || "").trim().slice(0, MAX_QUERY_LENGTH);
    if (!value) return;
    searchAPI
      .addHistory({ kind: "query", query: value })
      .then((data) => {
        if (!data?.entry) return;
        setHistory((prev) => [data.entry, ...prev.filter((e) => e._id !== data.entry._id)]);
      })
      .catch(() => {});
  }, []);

  const recordUser = useCallback((username) => {
    if (!username) return;
    searchAPI
      .addHistory({ kind: "user", username })
      .then((data) => {
        if (!data?.entry) return;
        setHistory((prev) => [data.entry, ...prev.filter((e) => e._id !== data.entry._id)]);
      })
      .catch(() => {});
  }, []);

  const removeHistoryEntry = useCallback((entryId) => {
    // Optimistic: the row goes immediately and comes back if the delete failed.
    const previous = history;
    setHistory((prev) => prev.filter((entry) => entry._id !== entryId));
    searchAPI.removeHistory(entryId).catch(() => setHistory(previous));
  }, [history]);

  const clearHistory = useCallback(() => {
    const previous = history;
    setHistory([]);
    searchAPI.clearHistory().catch(() => setHistory(previous));
  }, [history]);

  // ── Follow suggestions (shown when nothing is being searched) ──────────────
  const fetchSuggestions = useCallback(
    async (cursor = null) => {
      if (!token) return;
      setSuggestions((prev) => ({
        ...prev,
        loading: !cursor,
        loadingMore: Boolean(cursor),
        error: null,
      }));
      try {
        const data = await userAPI.getUsers({
          mode: "suggestions",
          limit: SUGGESTION_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        setSuggestions((prev) => ({
          items: cursor ? dedupeResults([...prev.items, ...(data?.users || [])]) : data?.users || [],
          cursor: data?.pageInfo?.nextCursor || null,
          hasMore: Boolean(data?.pageInfo?.hasNextPage),
          loading: false,
          loadingMore: false,
          error: null,
          meta: {},
        }));
      } catch (error) {
        setSuggestions((prev) => ({
          ...prev,
          loading: false,
          loadingMore: false,
          error: errorMessage(error, "Couldn't load suggestions."),
        }));
      }
    },
    [token]
  );

  useEffect(() => {
    if (!token) return;
    fetchSuggestions(null);
  }, [token, fetchSuggestions]);

  // ── Post search ───────────────────────────────────────────────────────────
  const runPostSearch = useCallback(
    async ({ cursor = null, key }) => {
      const requestId = postsRequestRef.current + 1;
      postsRequestRef.current = requestId;

      setPostResults((prev) => ({
        ...prev,
        items: cursor ? prev.items : [],
        loading: !cursor,
        loadingMore: Boolean(cursor),
        error: null,
      }));

      try {
        const data = await searchAPI.content({
          ...(query ? { q: query } : {}),
          limit: PAGE_SIZE,
          ...requestParams,
          ...(cursor ? { cursor } : {}),
        });
        if (postsRequestRef.current !== requestId) return;

        setPostResults((prev) => ({
          items: cursor
            ? dedupeResults([...prev.items, ...(data?.results || [])])
            : data?.results || [],
          cursor: data?.pageInfo?.nextCursor || null,
          hasMore: Boolean(data?.pageInfo?.hasNextPage),
          loading: false,
          loadingMore: false,
          error: null,
          meta: data?.meta || {},
        }));
        postsLoadedKeyRef.current = key;
      } catch (error) {
        if (postsRequestRef.current !== requestId) return;
        setPostResults((prev) => ({
          ...prev,
          loading: false,
          loadingMore: false,
          error: errorMessage(error, "Couldn't run that search."),
        }));
        // Left unset so switching back to this tab, or Retry, tries again.
        postsLoadedKeyRef.current = null;
      }
    },
    [query, requestParams]
  );

  useEffect(() => {
    if (!token || tab !== "posts") return;
    if (!canSearchPosts) {
      postsLoadedKeyRef.current = null;
      setPostResults(EMPTY_LIST);
      return;
    }
    if (postsLoadedKeyRef.current === postsKey) return;
    runPostSearch({ cursor: null, key: postsKey });
  }, [token, tab, canSearchPosts, postsKey, runPostSearch]);

  // ── People search ─────────────────────────────────────────────────────────
  const runPeopleSearch = useCallback(
    async ({ cursor = null, key }) => {
      const requestId = peopleRequestRef.current + 1;
      peopleRequestRef.current = requestId;

      setPeopleResults((prev) => ({
        ...prev,
        items: cursor ? prev.items : [],
        loading: !cursor,
        loadingMore: Boolean(cursor),
        error: null,
      }));

      try {
        const data = await userAPI.getUsers({
          q: query,
          limit: PEOPLE_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        if (peopleRequestRef.current !== requestId) return;

        setPeopleResults((prev) => ({
          items: cursor ? dedupeResults([...prev.items, ...(data?.users || [])]) : data?.users || [],
          cursor: data?.pageInfo?.nextCursor || null,
          hasMore: Boolean(data?.pageInfo?.hasNextPage),
          loading: false,
          loadingMore: false,
          error: null,
          meta: {},
        }));
        peopleLoadedKeyRef.current = key;
      } catch (error) {
        if (peopleRequestRef.current !== requestId) return;
        setPeopleResults((prev) => ({
          ...prev,
          loading: false,
          loadingMore: false,
          error: errorMessage(error, "Couldn't search people."),
        }));
        peopleLoadedKeyRef.current = null;
      }
    },
    [query]
  );

  useEffect(() => {
    if (!token || tab !== "people") return;
    if (!canSearchPeople) {
      peopleLoadedKeyRef.current = null;
      setPeopleResults(EMPTY_LIST);
      return;
    }
    if (peopleLoadedKeyRef.current === peopleKey) return;
    runPeopleSearch({ cursor: null, key: peopleKey });
  }, [token, tab, canSearchPeople, peopleKey, runPeopleSearch]);

  // ── Infinite scroll ───────────────────────────────────────────────────────
  const loadMorePosts = useCallback(() => {
    if (postResults.loading || postResults.loadingMore || !postResults.hasMore || !postResults.cursor) {
      return;
    }
    runPostSearch({ cursor: postResults.cursor, key: postsKey });
  }, [postResults, runPostSearch, postsKey]);

  const loadMorePeople = useCallback(() => {
    if (
      peopleResults.loading ||
      peopleResults.loadingMore ||
      !peopleResults.hasMore ||
      !peopleResults.cursor
    ) {
      return;
    }
    runPeopleSearch({ cursor: peopleResults.cursor, key: peopleKey });
  }, [peopleResults, runPeopleSearch, peopleKey]);

  const loadMoreSuggestions = useCallback(() => {
    if (
      suggestions.loading ||
      suggestions.loadingMore ||
      !suggestions.hasMore ||
      !suggestions.cursor
    ) {
      return;
    }
    fetchSuggestions(suggestions.cursor);
  }, [suggestions, fetchSuggestions]);

  const lastPostRef = useLastItemRef(loadMorePosts, postResults.hasMore);
  const lastPersonRef = useLastItemRef(loadMorePeople, peopleResults.hasMore);
  const lastSuggestionRef = useLastItemRef(loadMoreSuggestions, suggestions.hasMore);

  // ── Result mutations ──────────────────────────────────────────────────────
  const handleFollowStatusChange = useCallback((nextStatus) => {
    if (!nextStatus?.username) return;

    const applyRelationshipUpdate = (user) => {
      if (user.username !== nextStatus.username) return user;
      return {
        ...user,
        relationship: {
          ...(user.relationship || {}),
          isFollowing: Boolean(nextStatus.isFollowing),
          isPending: Boolean(nextStatus.isPending),
          canFollowBack: Boolean(nextStatus.canFollowBack),
        },
      };
    };

    setSuggestions((prev) => ({ ...prev, items: prev.items.map(applyRelationshipUpdate) }));
    setPeopleResults((prev) => ({ ...prev, items: prev.items.map(applyRelationshipUpdate) }));
  }, []);

  const handleResultDeleted = useCallback((deletedId) => {
    setPostResults((prev) => ({
      ...prev,
      items: prev.items.filter((item) => item._id !== deletedId),
    }));
  }, []);

  const handleResultUpdated = useCallback((updated) => {
    setPostResults((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item._id === updated._id ? { ...item, ...updated } : item)),
    }));
  }, []);

  // ── Interactions ──────────────────────────────────────────────────────────
  const submitSearch = (event) => {
    event.preventDefault();
    const trimmed = inputValue.trim();
    // Commit immediately rather than waiting out the debounce.
    if (trimmed !== query) applyUrl({ query: trimmed });
    recordQuery(trimmed);
    // Drops the mobile keyboard so results aren't behind it.
    inputRef.current?.blur();
  };

  const clearInput = () => {
    setInputValue("");
    applyUrl({ query: "" }, { replace: true });
    inputRef.current?.focus();
  };

  const selectRecentQuery = (text) => {
    setInputValue(text);
    applyUrl({ query: text.trim() });
    recordQuery(text);
  };

  const selectRecentUser = (user) => {
    recordUser(user.username);
    navigate(`/${user.username}`);
  };

  const showRecent = !isSearching;
  const activeList = tab === "posts" ? postResults : peopleResults;

  return (
    <div className="w-full bg-neutral-950">
      <SiteHeader layoutContext={layoutContext} />
      <main className="container mx-auto max-w-[620px] bg-neutral-950 px-4 pb-16 sm:px-6">
        <div className="flex items-center gap-2 pt-4">
          <form onSubmit={submitSearch} className="relative flex-1">
            <Icons.search
              className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2"
              strokeColor="#404040"
            />
            <input
              ref={inputRef}
              // Deliberately not type="search": the native cancel button
              // duplicates the clear button below it and can't be styled to
              // match.
              type="text"
              enterKeyHint="search"
              value={inputValue}
              maxLength={MAX_QUERY_LENGTH}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Search posts and people"
              aria-label="Search"
              autoComplete="off"
              className="w-full rounded-xl border border-neutral-800 bg-neutral-950 py-4 pl-12 pr-11 text-white outline-none focus:border-neutral-600"
            />
            {inputValue && (
              <button
                type="button"
                onClick={clearInput}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </form>

          {tab === "posts" && (
            <button
              type="button"
              onClick={() => setIsFilterSheetOpen(true)}
              aria-label="Search filters"
              className={`relative shrink-0 rounded-xl border p-3.5 transition-colors cursor-pointer ${
                activeFilterCount > 0
                  ? "border-white bg-white text-black"
                  : "border-neutral-800 text-neutral-300 hover:border-neutral-600"
              }`}
            >
              <SlidersHorizontal className="h-5 w-5" />
              {activeFilterCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1 text-[11px] font-semibold text-white">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => applyUrl({ tab: item.id }, { replace: true })}
              aria-pressed={tab === item.id}
              className={`shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                tab === item.id
                  ? "border-white bg-white text-black"
                  : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "posts" && filterChips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {filterChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => applyUrl({ filters: clearFilterKey(filters, chip.key) })}
                aria-label={`Remove filter: ${chip.label}`}
                className="flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-900 py-1.5 pl-3 pr-2 text-[13px] text-neutral-200 transition-colors hover:border-neutral-500 cursor-pointer"
              >
                {chip.label}
                <X className="h-3.5 w-3.5 text-neutral-500" />
              </button>
            ))}
            <button
              type="button"
              onClick={() => applyUrl({ filters: { ...DEFAULT_FILTERS } })}
              className="text-[13px] font-medium text-blue-500 hover:underline cursor-pointer"
            >
              Clear all
            </button>
          </div>
        )}

        {showRecent ? (
          <>
            <RecentSearches
              entries={history}
              loading={historyLoading}
              onSelectQuery={selectRecentQuery}
              onSelectUser={selectRecentUser}
              onRemove={removeHistoryEntry}
              onClear={clearHistory}
            />

            <p className="my-4 ml-2 font-medium text-neutral-500">Follow suggestions</p>
            <div className="mt-4 space-y-4">
              {suggestions.items.length > 0 ? (
                <>
                  {suggestions.items.map((user, index) => (
                    <div
                      key={user._id}
                      ref={index === suggestions.items.length - 1 ? lastSuggestionRef : null}
                      onClickCapture={() => recordUser(user.username)}
                    >
                      <SearchUserCard
                        user={user}
                        onFollowStatusChange={handleFollowStatusChange}
                      />
                    </div>
                  ))}
                  {suggestions.loadingMore && (
                    <div className="py-4 text-center">
                      <Icons.spinner className="mx-auto h-6 w-6 animate-spin text-neutral-400" />
                    </div>
                  )}
                </>
              ) : (
                <div className="py-10 text-center text-neutral-400">
                  {suggestions.loading ? (
                    <Icons.spinner className="mx-auto h-8 w-8 animate-spin" />
                  ) : (
                    suggestions.error || "No users available yet."
                  )}
                </div>
              )}
            </div>
          </>
        ) : activeList.loading ? (
          <div className="py-16 text-center">
            <Icons.spinner className="mx-auto h-8 w-8 animate-spin text-neutral-400" />
          </div>
        ) : activeList.error ? (
          <div className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/50 px-5 py-10 text-center">
            <p className="text-[15px] text-neutral-200">{activeList.error}</p>
            <button
              type="button"
              onClick={() =>
                tab === "posts"
                  ? runPostSearch({ cursor: null, key: postsKey })
                  : runPeopleSearch({ cursor: null, key: peopleKey })
              }
              className="mt-4 rounded-xl bg-white px-5 py-2.5 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 cursor-pointer"
            >
              Try again
            </button>
          </div>
        ) : tab === "posts" ? (
          <PostResults
            results={postResults}
            query={query}
            activeFilterCount={activeFilterCount}
            lastPostRef={lastPostRef}
            onClearFilters={() => applyUrl({ filters: { ...DEFAULT_FILTERS } })}
            onDelete={handleResultDeleted}
            onUpdate={handleResultUpdated}
            onOpen={() => recordQuery(query)}
          />
        ) : (
          <PeopleResults
            results={peopleResults}
            query={query}
            lastPersonRef={lastPersonRef}
            onFollowStatusChange={handleFollowStatusChange}
            onOpen={recordUser}
          />
        )}
      </main>

      {isFilterSheetOpen && (
        <SearchFiltersSheet
          filters={filters}
          onApply={(next) => applyUrl({ filters: next })}
          onClose={() => setIsFilterSheetOpen(false)}
        />
      )}

      <CreatePost isOpen={isCreateModalOpen} onClose={closeCreateModal} />
      <MobileNavbar layoutContext={layoutContext} />
    </div>
  );
};

/**
 * Why a post search came back empty, in the terms the viewer set it up with —
 * an unknown handle, an empty following list and an over-tight filter set are
 * three different problems and only one of them is "nothing matched".
 */
const PostEmptyState = ({ results, query, activeFilterCount, onClearFilters }) => {
  const { meta } = results;

  if (meta?.unknownUsername) {
    return (
      <>
        <p className="text-[15px] font-medium text-neutral-200">
          No account called @{meta.unknownUsername}
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
          Check the username in your filters, or search Anyone instead.
        </p>
      </>
    );
  }

  if (meta?.emptyFollowing) {
    return (
      <>
        <p className="text-[15px] font-medium text-neutral-200">You're not following anyone yet</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
          Follow a few accounts, or switch the profile filter back to Anyone.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="text-[15px] font-medium text-neutral-200">
        {query ? `No posts found for "${query}"` : "No posts match these filters"}
      </p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
        {activeFilterCount > 0
          ? "Your filters may be narrowing this too far."
          : "Try different words, or search People instead."}
      </p>
      {activeFilterCount > 0 && (
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-4 rounded-xl border border-neutral-700 px-5 py-2.5 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-800 cursor-pointer"
        >
          Clear filters
        </button>
      )}
    </>
  );
};

const PostResults = ({
  results,
  query,
  activeFilterCount,
  lastPostRef,
  onClearFilters,
  onDelete,
  onUpdate,
  onOpen,
}) => {
  if (!results.items.length) {
    return (
      <div className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/50 px-5 py-12 text-center sm:px-8">
        <PostEmptyState
          results={results}
          query={query}
          activeFilterCount={activeFilterCount}
          onClearFilters={onClearFilters}
        />
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {results.items.map((item, index) => {
        const isReply = item.kind === "reply";
        return (
          <div
            key={`${item.kind}-${item._id}`}
            ref={index === results.items.length - 1 ? lastPostRef : null}
            className="border-b border-neutral-800 empty:hidden"
            // Opening or acting on a result confirms the search was useful. The
            // write is an upsert, so repeat clicks bump one row rather than
            // adding more.
            onClickCapture={onOpen}
          >
            {isReply && item.parentPost?.author?.username && (
              <p className="pb-1 text-[13px] text-neutral-500">
                Reply to{" "}
                <span className="text-blue-500">@{item.parentPost.author.username}</span>
              </p>
            )}
            <PostCard
              item={item}
              author={item.author}
              isComment={isReply}
              // A reply's permalink is its parent post's page.
              postId={isReply ? item.post : undefined}
              // Search shows the matching reply itself, not the thread under it.
              disableNestedReplies={isReply}
              onDelete={onDelete}
              onUpdate={onUpdate}
            />
          </div>
        );
      })}

      {results.loadingMore && (
        <div className="py-4 text-center">
          <Icons.spinner className="mx-auto h-6 w-6 animate-spin text-neutral-400" />
        </div>
      )}
    </div>
  );
};

const PeopleResults = ({ results, query, lastPersonRef, onFollowStatusChange, onOpen }) => {
  if (!results.items.length) {
    return (
      <div className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/50 px-5 py-12 text-center sm:px-8">
        <p className="text-[15px] font-medium text-neutral-200">
          No people found for "{query}"
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
          Try a different name or username, or search Posts instead.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {results.items.map((user, index) => (
        <div
          key={user._id}
          ref={index === results.items.length - 1 ? lastPersonRef : null}
          onClickCapture={() => onOpen(user.username)}
        >
          <SearchUserCard user={user} onFollowStatusChange={onFollowStatusChange} />
        </div>
      ))}

      {results.loadingMore && (
        <div className="py-4 text-center">
          <Icons.spinner className="mx-auto h-6 w-6 animate-spin text-neutral-400" />
        </div>
      )}
    </div>
  );
};

export default SearchPage;
