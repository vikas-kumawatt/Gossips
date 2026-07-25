import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icons } from "./icons";
import ResponsiveSheet from "./ui/responsive-sheet";

/**
 * "AI info" — the author's own disclosure that a post or comment was made with
 * AI. Shown to everyone who can see the content; it isn't a private setting.
 *
 * Deliberately quiet: it's context, not a warning, so it sits at the weight of
 * a timestamp rather than competing with the content. Tapping it explains what
 * the label does and doesn't mean.
 */
const AiLabel = ({ compact = false, className = "", authorUsername }) => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <button
        type="button"
        aria-label="AI info. Learn what this label means"
        onClick={(e) => {
          // Post cards are clickable; without this the card navigates instead.
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-800/60 text-neutral-300 shrink-0 hover:bg-neutral-700/60 transition-colors cursor-pointer ${
          compact ? "px-1.5 py-[1px] text-[10px]" : "px-2 py-[2px] text-[11px]"
        } ${className}`}
      >
        <Icons.ai className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
        AI info
      </button>

      {open && (
        <ResponsiveSheet title="AI info" onClose={() => setOpen(false)}>
          {(close) => (
            <div className="p-5 flex flex-col gap-4">
              <p className="text-[15px] text-white leading-relaxed">
                {authorUsername ? `@${authorUsername}` : "The author"} added an AI
                label to this content.
              </p>

              <p className="text-[14px] text-neutral-400 leading-relaxed">
                AI may have been used for a wide range of purposes, from touching
                up a photo to generating something entirely new. We show this
                information whenever someone tells us AI was involved in what
                they posted.
              </p>

              <p className="text-[14px] text-neutral-400 leading-relaxed">
                Not all AI-generated content carries the signals we would need to
                detect it on our own, so this label depends on people disclosing
                it themselves. Its absence doesn't guarantee that AI wasn't used.
              </p>

              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="button"
                  onClick={close}
                  className="w-full py-3 rounded-xl bg-white text-black text-[15px] font-semibold hover:bg-neutral-200 transition-colors cursor-pointer"
                >
                  OK
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate("/ai-labels");
                  }}
                  className="w-full py-3 rounded-xl border border-neutral-700 text-white text-[15px] font-semibold hover:bg-neutral-800 transition-colors cursor-pointer"
                >
                  Learn more
                </button>
              </div>
            </div>
          )}
        </ResponsiveSheet>
      )}
    </>
  );
};

export default AiLabel;
