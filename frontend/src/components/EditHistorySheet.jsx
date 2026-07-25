import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import { postAPI, commentAPI } from "../services/api";

const formatVersionTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

/**
 * EditHistorySheet — every version of a post or comment, oldest first.
 *
 * Public, like X: it's what makes the "a new version is available" prompt on a
 * quote meaningful, and it's the check on someone editing a post after it has
 * been quoted or reported.
 */
const EditHistorySheet = ({ isComment, targetId, onClose }) => {
  const [versions, setVersions] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const load = isComment
      ? commentAPI.getEditHistory(targetId)
      : postAPI.getEditHistory(targetId);

    load
      .then((data) => {
        if (!active) return;
        setVersions(data?.versions || []);
        setTruncated(!!data?.truncated);
      })
      .catch(() => {
        if (active) setError(true);
      });

    return () => {
      active = false;
    };
  }, [isComment, targetId]);

  return (
    <ResponsiveSheet onClose={onClose} title="Edit history">
      <div className="p-4">
        {!versions && !error && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
          </div>
        )}

        {error && (
          <p className="py-10 text-center text-neutral-400 text-[14px]">
            Couldn't load the edit history.
          </p>
        )}

        {versions && versions.length > 0 && (
          <ol className="flex flex-col gap-3">
            {versions.map((version, index) => (
              <li key={`${version.at}-${index}`}>
                {/* The original is always kept; the cap drops middle versions,
                    so the gap belongs directly after it. */}
                {truncated && index === 1 && (
                  <p className="mb-3 text-[12px] text-neutral-500 leading-relaxed">
                    Some versions in between are no longer available — only the
                    original and the most recent edits are kept.
                  </p>
                )}
                <div
                  className={`rounded-2xl border px-4 py-3 ${
                    version.isCurrent
                      ? "border-neutral-600 bg-neutral-900"
                      : "border-neutral-800 bg-neutral-900/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
                      {index === 0
                        ? "Original"
                        : version.isCurrent
                        ? "Latest version"
                        : truncated
                        ? "Earlier version"
                        : `Version ${index + 1}`}
                    </span>
                    {version.isCurrent && index > 0 && (
                      <span className="text-[11px] font-semibold text-neutral-300 bg-neutral-800 rounded-full px-2 py-0.5 shrink-0">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[15px] whitespace-pre-line break-words">
                    {version.content}
                  </p>
                  <p className="mt-1.5 text-[12px] text-neutral-500">
                    {formatVersionTime(version.at)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </ResponsiveSheet>
  );
};

export default EditHistorySheet;
