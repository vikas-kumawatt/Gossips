import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { userAPI } from "../services/api";

const OPTIONS = [
  { id: "everyone", label: "Everyone" },
  { id: "followers", label: "Followers only" },
  { id: "followers_following", label: "People you follow back" },
  { id: "none", label: "No one" },
];

const OnlineStatusSheet = ({ onClose }) => {
  const [value, setValue] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    userAPI
      .getPrivacySettings()
      .then((data) => {
        if (!cancelled) setValue(data.whoCanSeeOnlineStatus || "everyone");
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
      await userAPI.updatePrivacySettings({
        whoCanSeeOnlineStatus: next,
        whoCanSeeLastSeen: next,
      });
      toast.success("Online status setting updated");
    } catch (err) {
      setValue(previous);
      toast.error(err?.response?.data?.error || "Couldn't save that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ResponsiveSheet title="Online Status" onClose={onClose}>
      <div className="px-5 py-5">
        <h2 className="text-[17px] font-bold text-white">Who can see when you're online</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-neutral-400">
          When this is off or restricted, you won't be able to see the online status or last seen time of other accounts.
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
            aria-label="Who can see when you're online"
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

export default OnlineStatusSheet;
