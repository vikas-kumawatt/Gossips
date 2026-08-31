import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { userAPI } from "../services/api";

/**
 * Who may @mention you.
 *
 * Saved on selection rather than behind a Save button — it's one radio group,
 * and a settings screen that can be left in an unsaved state is a settings
 * screen people get wrong. The choice is applied optimistically and rolled
 * back if the request fails, so the radio never lies about what's stored.
 */

const OPTIONS = [
  { id: "everyone", label: "Everyone" },
  { id: "following", label: "Profiles you follow" },
  { id: "none", label: "No one" },
];

const MentionSettingsSheet = ({ onClose }) => {
  const [value, setValue] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    userAPI
      .getPrivacySettings()
      .then((data) => {
        if (!cancelled) setValue(data.whoCanMention || "everyone");
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load your setting");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (next) => {
    if (next === value || saving) return;

    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      await userAPI.updatePrivacySettings({ whoCanMention: next });
    } catch (err) {
      // Put the radio back where it was: showing a selection that isn't stored
      // is worse than showing the old one.
      setValue(previous);
      toast.error(err?.response?.data?.error || "Couldn't save that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ResponsiveSheet title="Mentions" onClose={onClose}>
      <div className="px-5 py-5">
        <h2 className="text-[17px] font-bold text-white">Allow @mentions from</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-neutral-400">
          Choose who can @mention you to link your profile in their posts, replies, or
          bio. When people you haven't allowed try to @mention you, their text won't create a clickable link.
        </p>
        <p className="mt-2 text-[13px] text-neutral-500 leading-relaxed">
          Note: Changes apply to new posts and edits going forward. Mentions in previously published posts or bios are not retroactively unlinked.
        </p>

        {error ? (
          <p className="py-10 text-center text-sm text-neutral-500">{error}</p>
        ) : value === null ? (
          <div className="flex justify-center py-10">
            <Icons.spinner className="h-6 w-6 animate-spin text-neutral-400" />
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-label="Allow @mentions from"
            className="mt-6 flex flex-col"
          >
            {OPTIONS.map((option) => {
              const selected = value === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={saving}
                  onClick={() => choose(option.id)}
                  className="flex w-full cursor-pointer items-center justify-between py-4 text-left disabled:cursor-default"
                >
                  <span className="text-[15px] text-white">{option.label}</span>
                  {/* A hand-drawn radio: the native one can't be styled to
                      match, and this is the only radio group in the app. */}
                  <span
                    className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                      selected ? "border-white bg-white" : "border-neutral-600"
                    }`}
                  >
                    {selected && <span className="h-2 w-2 rounded-full bg-black" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ResponsiveSheet>
  );
};

export default MentionSettingsSheet;
