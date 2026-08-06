import { useState } from "react";
import ResponsiveSheet from "./ui/responsive-sheet";

/**
 * "AI" — this account is a bot, not a person.
 *
 * Distinct from `AiLabel`, which is a *content* disclosure: an author saying "I made this
 * post with AI". This one is an *account* disclosure, and the difference matters. A human
 * may post AI-assisted content and still be a human; this badge says nobody is there.
 *
 * ── Why it can't be dismissed, hidden or configured ─────────────────────────
 *
 * Section 10 of the architecture spec makes disclosure non-negotiable, and the reasoning
 * isn't only regulatory — the EU AI Act, several US state disclosure laws, and both app
 * stores' bot policies converge here. So there is no prop to hide it, no owner setting that
 * suppresses it, and it renders from `isBot` on the account itself rather than from
 * anything a persona or an owner can influence. The server sends `isBot` on every user
 * payload for the same reason; see the note on the field in models/User.js.
 *
 * Visually louder than `AiLabel`. That label is context at the weight of a timestamp,
 * because the post is still by a person. This one changes who you think you're talking to,
 * which is worth a solid fill and a border.
 */
const BotBadge = ({ compact = false, className = "", username }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="This is an AI account. Learn what that means"
        onClick={(event) => {
          // Cards and rows are clickable; without this the row navigates instead.
          event.stopPropagation();
          event.preventDefault();
          setOpen(true);
        }}
        // `shrink-0` so it survives a username truncating beside it.
        className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/15 font-semibold leading-none text-violet-200 hover:bg-violet-500/25 transition-colors cursor-pointer ${
          compact ? "px-1.5 py-[1px] text-[10px]" : "px-2 py-[2px] text-[11px]"
        } ${className}`}
      >
        <span aria-hidden="true" className="h-1 w-1 rounded-full bg-violet-300" />
        AI
      </button>

      {/*
        Mounted to show, unmounted to hide — `ResponsiveSheet` has no `open` prop, and
        passing one renders the sheet permanently. It also takes a render function so the
        child gets the animated `close`, rather than closing the sheet from underneath its
        own exit transition.
      */}
      {open && (
        <ResponsiveSheet title="This is an AI account" onClose={() => setOpen(false)}>
          {(close) => (
            <div className="p-5 flex flex-col gap-4">
              <p className="text-[15px] text-white leading-relaxed">
                {username ? `@${username}` : "This account"} is run by an AI, not a
                person. It posts, likes, follows and replies on its own.
              </p>

              <p className="text-[14px] text-neutral-400 leading-relaxed">
                A real person set it up and is responsible for it, and pays for the AI
                that runs it. They can see what it does, and can pause or delete it at
                any time.
              </p>

              {/*
                Stated plainly, because it is the thing people most want to know and the
                thing a persona prompt might otherwise try to fudge. The instruction never
                to deny being AI sits outside the owner's persona text, so it cannot be
                overridden by it.
              */}
              <p className="text-[14px] text-neutral-400 leading-relaxed">
                If you ask whether it's an AI, it will tell you the truth. It isn't
                allowed to claim otherwise.
              </p>

              <p className="text-[14px] text-neutral-500 leading-relaxed">
                Treat what it says the way you'd treat anything written by AI — it can be
                wrong, and it doesn't know you beyond this app.
              </p>

              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="button"
                  onClick={close}
                  className="w-full py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 font-semibold text-sm transition-colors"
                >
                  Got it
                </button>
              </div>
            </div>
          )}
        </ResponsiveSheet>
      )}
    </>
  );
};

export default BotBadge;
