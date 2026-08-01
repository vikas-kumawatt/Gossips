import { useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { Icons } from "../icons";

/**
 * A profile shared into a chat.
 *
 * Like the post card, this renders `sharedContent.resolved` — worked out by the
 * server for the person reading the thread, on every fetch. So a renamed handle
 * or a new picture shows through, and an account that has blocked the reader
 * resolves to "unavailable" for them while still rendering for everyone else.
 *
 * There is no private-lock state here: a profile header is public even for a
 * private account. The padlock below marks a private account whose *posts* the
 * reader may not be able to see, which is what the profile page itself shows.
 */
const SharedProfileCard = ({ sharedContent }) => {
  const navigate = useNavigate();
  const resolved = sharedContent?.resolved;
  const snapshot = sharedContent?.snapshot;

  // A group message arriving live carries no `resolved` — it hasn't been
  // evaluated for this reader yet. Guessing would be a leak, so it stays neutral
  // until the next thread fetch.
  if (!resolved) {
    return (
      <div className="w-full max-w-[240px] rounded-2xl border border-neutral-700 bg-neutral-900/60 p-3">
        <p className="text-[13px] text-neutral-300">Shared a profile</p>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          {snapshot?.authorUsername ? `@${snapshot.authorUsername} · ` : ""}
          reopen this chat to view it
        </p>
      </div>
    );
  }

  if (!resolved.available) {
    return (
      <div className="w-full max-w-[240px] rounded-2xl border border-neutral-700 bg-neutral-900/60 p-3">
        <p className="text-[13px] text-neutral-400">This account is no longer available</p>
        {/* Named only when the account is simply gone. When a block is the
            reason the server sends no username, and there's nothing to show. */}
        {resolved.username && (
          <p className="mt-0.5 text-[11px] text-neutral-600">was @{resolved.username}</p>
        )}
      </div>
    );
  }

  const open = (event) => {
    event.stopPropagation();
    if (!resolved.username) return;
    navigate(`/${resolved.username}`);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      }}
      className="w-full max-w-[240px] cursor-pointer overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-900/60 p-3 text-left transition-colors hover:border-neutral-600"
    >
      <div className="flex items-center gap-2.5">
        <img
          src={resolved.profilePic || "https://via.placeholder.com/44"}
          alt=""
          referrerPolicy="no-referrer"
          className="h-11 w-11 shrink-0 rounded-full bg-neutral-800 object-cover"
        />
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-[13px] font-semibold text-white">
            <span className="truncate">{resolved.username}</span>
            {resolved.isVerified && <Icons.verified />}
            {resolved.isPrivate && <Lock className="h-3 w-3 shrink-0 text-neutral-500" />}
          </p>
          {resolved.name && (
            <p className="truncate text-[12px] text-neutral-400">{resolved.name}</p>
          )}
        </div>
      </div>

      {/* Clamped, unlike a shared post's text: a bio is chrome on this card, not
          the thing being shared. */}
      {resolved.bio && (
        <p className="mt-2 line-clamp-2 break-words text-[12px] text-neutral-300">
          {resolved.bio}
        </p>
      )}

      <p className="mt-2 text-[11px] text-neutral-500">
        {resolved.followerCount === 1
          ? "1 follower"
          : `${(resolved.followerCount ?? 0).toLocaleString()} followers`}
      </p>

      <p className="mt-2 rounded-lg bg-neutral-800 py-1.5 text-center text-[12px] font-semibold text-white">
        View profile
      </p>
    </div>
  );
};

export default SharedProfileCard;
