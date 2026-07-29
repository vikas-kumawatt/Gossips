import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import {
  DATE_POSTED_OPTIONS,
  DEFAULT_FILTERS,
  FROM_PROFILE_OPTIONS,
  countActiveFilters,
  normalizeFilters,
  todayInputValue,
  validateFilters,
} from "../lib/searchFilters";

const Section = ({ title, hint, children }) => (
  <div>
    <p className="text-[13px] font-semibold uppercase tracking-wide text-neutral-500">
      {title}
    </p>
    {hint && <p className="mt-1 text-[13px] text-neutral-500">{hint}</p>}
    <div className="mt-3">{children}</div>
  </div>
);

const ChoiceRow = ({ label, hint, selected, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-neutral-800/60 cursor-pointer"
  >
    <span className="min-w-0">
      <span className="block text-[15px] text-white">{label}</span>
      {hint && <span className="block text-[13px] text-neutral-500">{hint}</span>}
    </span>
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
        selected ? "border-white bg-white text-black" : "border-neutral-600"
      }`}
    >
      {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </span>
  </button>
);

const Toggle = ({ checked, onChange, label, hint }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="min-w-0">
      <span className="block text-[15px] text-white">{label}</span>
      {hint && <span className="block text-[13px] text-neutral-500">{hint}</span>}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer ${
        checked ? "bg-white" : "bg-neutral-700"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full transition-transform ${
          checked ? "translate-x-[22px] bg-black" : "translate-x-0.5 bg-neutral-300"
        }`}
      />
    </button>
  </div>
);

const NumberField = ({ label, value, onChange }) => (
  <label className="flex items-center justify-between gap-3">
    <span className="text-[15px] text-white">{label}</span>
    <input
      type="text"
      inputMode="numeric"
      value={value}
      placeholder="Any"
      // Digits only, kept as a string: a number input would let "1e5" and "-2"
      // through on some browsers, and the server rejects both.
      onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 7))}
      className="w-24 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-right text-[15px] text-white outline-none focus:border-neutral-500"
    />
  </label>
);

const DateField = ({ label, value, min, max, onChange }) => (
  <label className="flex items-center justify-between gap-3">
    <span className="text-[15px] text-white">{label}</span>
    <input
      type="date"
      value={value}
      min={min || undefined}
      max={max || undefined}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[15px] text-white outline-none focus:border-neutral-500 [color-scheme:dark]"
    />
  </label>
);

/**
 * Search filters — the bottom sheet behind the filter button.
 *
 * Edits a draft copy and commits on Apply, so backing out of a half-finished
 * filter set leaves the current search alone. Reset clears the draft in place;
 * it still takes an Apply to change what's on screen.
 *
 * @param {object} filters               currently applied set
 * @param {(next: object) => void} onApply
 * @param {() => void} onClose
 */
const SearchFiltersSheet = ({ filters, onApply, onClose }) => {
  const [draft, setDraft] = useState(() => normalizeFilters(filters));

  const error = validateFilters(draft);
  const activeCount = countActiveFilters(draft);
  const today = todayInputValue();

  /*
   * The presets and the explicit range are two ways to say the same thing, so
   * picking one clears the other. (The server intersects them if a request
   * carries both — this just keeps the UI from showing two competing answers.)
   */
  const selectDatePreset = (value) =>
    setDraft((current) => ({
      ...current,
      datePosted: value,
      ...(value !== "all" ? { after: "", before: "" } : {}),
    }));

  const setDateBound = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value, datePosted: "all" }));

  const selectFrom = (value) =>
    setDraft((current) => ({
      ...current,
      from: value,
      // Leaving Custom drops the username with it, so an unused handle can't sit
      // in the URL looking like an active filter.
      username: value === "user" ? current.username : "",
    }));

  return (
    <ResponsiveSheet title="Search filters" onClose={onClose} scrollBody={false}>
      {(close) => (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex-1 min-h-0 space-y-7 overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar px-4 py-4">
            <Section title="From profile">
              <div className="-mx-1">
                {FROM_PROFILE_OPTIONS.map((option) => (
                  <ChoiceRow
                    key={option.value}
                    label={option.label}
                    hint={option.hint}
                    selected={draft.from === option.value}
                    onSelect={() => selectFrom(option.value)}
                  />
                ))}
              </div>
              {draft.from === "user" && (
                <div className="mt-2 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 focus-within:border-neutral-500">
                  <span className="text-[15px] text-neutral-500">@</span>
                  <input
                    type="text"
                    value={draft.username}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        // Handles have no spaces or leading @ — strip both here so
                        // a pasted "@ name" doesn't fail against the server.
                        username: event.target.value.replace(/[\s@]/g, "").slice(0, 40),
                      }))
                    }
                    placeholder="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full bg-transparent text-[15px] text-white outline-none placeholder:text-neutral-600"
                  />
                </div>
              )}
            </Section>

            <Section title="Date posted">
              <div className="flex flex-wrap gap-2">
                {DATE_POSTED_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => selectDatePreset(option.value)}
                    aria-pressed={draft.datePosted === option.value}
                    className={`rounded-full border px-3.5 py-2 text-[13px] font-medium transition-colors cursor-pointer ${
                      draft.datePosted === option.value
                        ? "border-white bg-white text-black"
                        : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Section>

            <Section
              title="Custom range"
              hint="Both dates are included. Picking a range clears the preset above."
            >
              <div className="space-y-3">
                <DateField
                  label="After date"
                  value={draft.after}
                  max={draft.before || today}
                  onChange={(value) => setDateBound("after", value)}
                />
                <DateField
                  label="Before date"
                  value={draft.before}
                  min={draft.after || undefined}
                  max={today}
                  onChange={(value) => setDateBound("before", value)}
                />
              </div>
            </Section>

            <Section title="Post activity">
              <div className="space-y-3">
                <NumberField
                  label="Minimum likes"
                  value={draft.minLikes}
                  onChange={(value) => setDraft((current) => ({ ...current, minLikes: value }))}
                />
                <NumberField
                  label="Minimum comments"
                  value={draft.minComments}
                  onChange={(value) => setDraft((current) => ({ ...current, minComments: value }))}
                />
                <NumberField
                  label="Minimum reposts"
                  value={draft.minReposts}
                  onChange={(value) => setDraft((current) => ({ ...current, minReposts: value }))}
                />
              </div>
            </Section>

            <Section title="Replies">
              <Toggle
                label="Exclude replies"
                hint="Show only posts, not replies to them."
                checked={draft.excludeReplies}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, excludeReplies: value }))
                }
              />
            </Section>

            {error && <p className="text-[13px] text-red-400">{error}</p>}
          </div>

          <div className="flex shrink-0 items-center gap-3 border-t border-neutral-800 p-4">
            <button
              type="button"
              onClick={() => setDraft({ ...DEFAULT_FILTERS })}
              disabled={activeCount === 0}
              className="flex items-center gap-2 rounded-xl border border-neutral-700 px-4 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </button>
            <button
              type="button"
              disabled={Boolean(error)}
              onClick={() => {
                onApply(draft);
                close();
              }}
              className="flex-1 rounded-xl bg-white py-3 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              {activeCount > 0 ? `Apply ${activeCount} filter${activeCount === 1 ? "" : "s"}` : "Apply"}
            </button>
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default SearchFiltersSheet;
