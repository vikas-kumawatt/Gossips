import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { UserContext } from "../contexts/UserContext";
import { toast } from "react-hot-toast";
import { Check, Link2 } from "lucide-react";
import { Icons } from "../components/icons";
import { useDebounce } from "../hooks/useDebounce";
import { groupAPI, userAPI } from "../services/api";
import { buildGroupInviteUrl } from "../lib/groupLink";

/**
 * Add people to a group: search, or pick from who you follow.
 *
 * Its own page rather than a block inside the group info screen, where it sat between
 * the banned list and "Leave group" with no way to see who was already in.
 *
 * Suggestions come from the accounts you follow, minus everyone already a member —
 * offering to add someone who is already in the group is the most common thing to get
 * wrong here, and the server answers such a request with a 400 the user can't act on.
 *
 * The invite link row is here too, above search: search only finds people who already
 * exist to you, and a link is how you reach someone whose handle you don't know.
 */

const errorMessage = (err, fallback) => err?.response?.data?.error || fallback;

const GroupAddPeoplePage = () => {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const myUsername = userAuth?.username;

  const [existingIds, setExistingIds] = useState(() => new Set());
  const [suggestions, setSuggestions] = useState([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState([]); // [{_id, username, name, profilePic}]
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  /* The invite link, for people you can't find by search. */
  const [inviteToken, setInviteToken] = useState(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /*
   * Existing members, so both lists can exclude them.
   *
   * `limit: 200` rather than paging: this is only used to filter, and a group past a
   * couple of hundred members is one where search is the realistic path anyway. The
   * server caps a group at 512, so this is bounded either way.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [membersRes, followingRes, inviteRes] = await Promise.all([
          groupAPI.getMembers(groupId, { limit: 200 }),
          /*
           * Who to suggest: the accounts you follow.
           *
           * `getFollowingUsers` is keyed by username, not "me" — it's the same endpoint
           * that powers the followers modal on a profile. A failure here is not fatal,
           * because search still works without suggestions.
           */
          myUsername
            ? userAPI.getFollowingUsers(myUsername, { limit: 100 }).catch(() => null)
            : Promise.resolve(null),
          // Also not fatal: the row simply doesn't render without a token.
          groupAPI.getInvite(groupId).catch(() => null),
        ]);
        if (cancelled) return;
        setInviteToken(inviteRes?.token || null);

        const ids = new Set(
          (membersRes.members || []).map((m) => String(m.user?._id)).filter(Boolean)
        );
        setExistingIds(ids);

        const following = followingRes?.users || followingRes?.following || [];
        setSuggestions(
          following
            .map((row) => row.user || row)
            .filter((u) => u?._id && !ids.has(String(u._id)))
        );
      } catch (err) {
        if (!cancelled) toast.error(errorMessage(err, "Couldn't load this group"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, myUsername]);

  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    userAPI
      .searchUsers(q)
      .then((data) => {
        if (cancelled) return;
        setResults((data.users || []).filter((u) => !existingIds.has(String(u._id))));
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, existingIds]);

  const selectedIds = useMemo(
    () => new Set(selected.map((u) => String(u._id))),
    [selected]
  );

  const toggle = useCallback((user) => {
    setSelected((prev) =>
      prev.some((u) => String(u._id) === String(user._id))
        ? prev.filter((u) => String(u._id) !== String(user._id))
        : [...prev, user]
    );
  }, []);

  const submit = async () => {
    if (!selected.length || adding) return;
    setAdding(true);
    try {
      await groupAPI.addMembers(groupId, selected.map((u) => u._id));
      toast.success(
        selected.length === 1
          ? `Added @${selected[0].username}`
          : `Added ${selected.length} people`
      );
      navigate(`/chat/group/${groupId}/people`);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't add them"));
      if (alive.current) setAdding(false);
    }
  };

  const inviteUrl = buildGroupInviteUrl(inviteToken);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  /* The list on screen: search results when searching, suggestions otherwise. */
  const showingSearch = query.trim().length > 0;
  const list = showingSearch ? results : suggestions;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-black text-white">
      <header className="shrink-0 flex items-center gap-3 px-3 py-3 sm:px-4 border-b border-neutral-800">
        <button
          onClick={() => navigate(-1)}
          aria-label="Go back"
          className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Icons.back className="w-5 h-5" />
        </button>
        <h1 className="flex-1 font-medium text-base">Add people</h1>
        {/*
          Disabled rather than hidden with nothing selected: a Done button that appears
          only once you've picked someone gives no hint that picking is what's expected.
        */}
        <button
          onClick={submit}
          disabled={!selected.length || adding}
          className="px-4 py-1.5 rounded-full bg-white text-black text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-transform"
        >
          {adding ? "Adding…" : selected.length ? `Done (${selected.length})` : "Done"}
        </button>
      </header>

      {/*
        Share a link instead.
        Search only finds people who already exist to you; a link is how you reach
        someone who isn't on Gossips yet, or whose handle you don't know.
      */}
      {inviteUrl && (
        <button
          type="button"
          onClick={copyInvite}
          className="shrink-0 mx-4 mt-3 flex items-center gap-3 px-3 py-2.5 rounded-xl bg-neutral-900 border border-neutral-800 text-left hover:bg-neutral-800 transition-colors"
        >
          <span className="w-9 h-9 rounded-full bg-neutral-800 flex items-center justify-center shrink-0">
            <Link2 className="w-[18px] h-[18px] text-neutral-300" strokeWidth={2.1} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium">Invite link</span>
            <span className="block text-xs text-neutral-500 truncate">{inviteUrl}</span>
          </span>
          <span className="text-xs font-semibold text-violet-400 shrink-0">Copy</span>
        </button>
      )}

      <div className="shrink-0 px-4 py-3">
        <div className="relative">
          <Icons.search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
            strokeColor="#737373"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search people to add"
            className="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-10 py-2.5 text-sm outline-none focus:border-neutral-600 placeholder-neutral-500"
          />
          {query !== "" && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center text-neutral-500 hover:text-white"
            >
              <Icons.close className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Who's picked so far, as removable chips — otherwise a selection made while
          searching disappears the moment you type something else. */}
      {selected.length > 0 && (
        <div className="shrink-0 flex gap-2 overflow-x-auto scrollbar-hide px-4 pb-3">
          {selected.map((user) => (
            <button
              key={user._id}
              onClick={() => toggle(user)}
              aria-label={`Remove ${user.username}`}
              className="shrink-0 flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-neutral-800 hover:bg-neutral-700 text-xs"
            >
              <img
                src={user.profilePic || "/default-avatar.png"}
                alt=""
                className="w-6 h-6 rounded-full object-cover"
              />
              <span className="max-w-[90px] truncate">{user.username}</span>
              <Icons.close className="w-3 h-3 text-neutral-400" />
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pb-6">
        {!showingSearch && (
          <h2 className="px-4 pt-1 pb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Suggested
          </h2>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <Icons.spinner className="animate-spin w-6 h-6 text-neutral-400" />
          </div>
        ) : searching ? (
          <div className="flex justify-center py-10">
            <Icons.spinner className="animate-spin w-6 h-6 text-neutral-400" />
          </div>
        ) : list.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-neutral-500">
            {showingSearch
              ? `No accounts found for "${query}"`
              : "Nobody to suggest — search for someone instead."}
          </p>
        ) : (
          list.map((user) => {
            const picked = selectedIds.has(String(user._id));
            return (
              <button
                key={user._id}
                type="button"
                onClick={() => toggle(user)}
                aria-pressed={picked}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-900 text-left"
              >
                <img
                  src={user.profilePic || "/default-avatar.png"}
                  alt=""
                  className="w-11 h-11 rounded-full object-cover border border-neutral-800 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{user.username}</span>
                    {user.isVerified && <Icons.verified className="w-3.5 h-3.5 shrink-0" />}
                  </div>
                  {user.name && (
                    <p className="text-xs text-neutral-500 truncate">{user.name}</p>
                  )}
                </div>
                {/* A real checkbox shape, not a tick that appears from nowhere: the
                    empty circle is what says the row is selectable at all. */}
                <span
                  aria-hidden="true"
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                    picked ? "bg-white border-white" : "border-neutral-600"
                  }`}
                >
                  {picked && <Check className="w-4 h-4 text-black" strokeWidth={3} />}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export default GroupAddPeoplePage;
