import { useState } from "react";
import { Search, X } from "lucide-react";
import { Icons } from "./icons";

/**
 * Recent searches — the list shown while the search box is empty.
 *
 * Two kinds of row: a term you searched, which re-runs it, and a profile you
 * opened from results, which goes back to it. Renders nothing at all when the
 * history is empty, so the follow suggestions below take over the space.
 *
 * @param {Array}  entries    [{ _id, kind, query, user }]
 * @param {(text: string) => void} onSelectQuery
 * @param {(user: object) => void} onSelectUser
 * @param {(entryId: string) => void} onRemove
 * @param {() => void} onClear
 */
const RecentSearches = ({ entries, loading, onSelectQuery, onSelectUser, onRemove, onClear }) => {
  const [confirmingClear, setConfirmingClear] = useState(false);

  if (loading && !entries.length) {
    return (
      <div className="py-6 text-center">
        <Icons.spinner className="mx-auto h-6 w-6 animate-spin text-neutral-500" />
      </div>
    );
  }

  if (!entries.length) return null;

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[15px] font-semibold text-white">Recent</h2>
        {confirmingClear ? (
          <div className="flex items-center gap-3 text-[13px]">
            <span className="text-neutral-400">Clear all?</span>
            <button
              type="button"
              onClick={() => setConfirmingClear(false)}
              className="font-medium text-neutral-300 hover:underline cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingClear(false);
                onClear();
              }}
              className="font-semibold text-red-500 hover:underline cursor-pointer"
            >
              Clear
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            className="text-[13px] font-medium text-blue-500 hover:underline cursor-pointer"
          >
            Clear all
          </button>
        )}
      </div>

      <ul className="mt-1">
        {entries.map((entry) => {
          const isUser = entry.kind === "user" && entry.user;
          return (
            <li key={entry._id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  isUser ? onSelectUser(entry.user) : onSelectQuery(entry.query)
                }
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-2.5 text-left transition-colors hover:bg-neutral-900 cursor-pointer"
              >
                {isUser ? (
                  <img
                    src={entry.user.profilePic || ""}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-9 w-9 shrink-0 rounded-full border border-neutral-800 bg-neutral-800 object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-neutral-400">
                    <Search className="h-4 w-4" />
                  </span>
                )}
                <span className="min-w-0">
                  {isUser ? (
                    <>
                      <span className="flex items-center text-[15px] text-white">
                        <span className="truncate">{entry.user.username}</span>
                        {entry.user.isVerified && (
                          <span className="inline-flex shrink-0 items-center pl-1">
                            <Icons.verified />
                          </span>
                        )}
                      </span>
                      {entry.user.name && (
                        <span className="block truncate text-[13px] text-neutral-500">
                          {entry.user.name}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="block truncate text-[15px] text-white">{entry.query}</span>
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onRemove(entry._id)}
                aria-label={
                  isUser ? `Remove ${entry.user.username}` : `Remove ${entry.query}`
                }
                className="shrink-0 rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default RecentSearches;
