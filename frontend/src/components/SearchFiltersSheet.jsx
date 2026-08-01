import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
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

/**
 * Search filters.
 *
 * Four categories, one screen each, reached from a menu — rather than every
 * control stacked into one long scroll. The stacked version fit, but it asked
 * you to read five sections to change one thing, and the summary you actually
 * want ("From: anyone, Date: all time") was only derivable by scrolling
 * through them. A menu shows all four current values at a glance and takes one
 * tap to change any of them.
 *
 * Steps are handled inside a single sheet using its back chevron, not as
 * stacked sheets: two overlapping sheets means two backdrops, two scroll locks
 * and an Escape that closes the wrong one.
 *
 * Edits a draft and commits on Apply, so backing out of a half-finished set
 * leaves the current search alone.
 */

const Row = ({ label, value, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-neutral-800/60 cursor-pointer"
  >
    <span className="text-[15px] text-white">{label}</span>
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-[15px] text-neutral-400">{value}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-neutral-600" />
    </span>
  </button>
);

const ChoiceRow = ({ label, hint, selected, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-neutral-800/60 cursor-pointer"
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
  <div className="flex items-center justify-between gap-3 px-5 py-4">
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
  <label className="flex items-center justify-between gap-3 px-5 py-3.5">
    <span className="text-[15px] text-white">{label}</span>
    <input
      type="text"
      inputMode="numeric"
      value={value}
      placeholder="Any"
      // Digits only, kept as a string: a number input would let "1e5" and "-2"
      // through on some browsers, and the server rejects both.
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, 7);
        // A bare "0" reads as active everywhere (a non-empty string) but is
        // dropped when the request is built, so it's a filter that claims to
        // be on and does nothing. Treat it as cleared.
        onChange(/^0+$/.test(digits) ? "" : digits);
      }}
      className="w-24 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-right text-[15px] text-white outline-none focus:border-neutral-500"
    />
  </label>
);

const DateField = ({ label, value, min, max, onChange }) => (
  <label className="flex items-center justify-between gap-3 px-5 py-3.5">
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

/** The one-line summary each menu row shows. */
const summarize = (draft) => {
  const from =
    draft.from === "user"
      ? draft.username
        ? `@${draft.username}`
        : "Custom"
      : FROM_PROFILE_OPTIONS.find((o) => o.value === draft.from)?.label || "Anyone";

  const preset =
    draft.datePosted !== "all"
      ? DATE_POSTED_OPTIONS.find((o) => o.value === draft.datePosted)?.label
      : null;
  const range =
    draft.after && draft.before
      ? `${draft.after} – ${draft.before}`
      : draft.after
        ? `After ${draft.after}`
        : draft.before
          ? `Before ${draft.before}`
          : null;
  // Both, when both are set. Only a hand-written URL can produce that, but
  // hiding one made the sheet disagree with the chips and the Apply count.
  const date = [preset, range].filter(Boolean).join(" · ") || "All time";

  const activity = [
    draft.minLikes && `${draft.minLikes}+ likes`,
    draft.minComments && `${draft.minComments}+ comments`,
    draft.minReposts && `${draft.minReposts}+ reposts`,
  ].filter(Boolean);

  return {
    from,
    date,
    activity: activity.length ? activity.join(", ") : "Any",
    replies: draft.excludeReplies ? "Posts only" : "Included",
  };
};

const STEP_TITLES = {
  from: "From profile",
  date: "Date posted",
  activity: "Post activity",
  replies: "Replies",
};

const SearchFiltersSheet = ({ filters, onApply, onClose }) => {
  const [draft, setDraft] = useState(() => normalizeFilters(filters));
  const [step, setStep] = useState(null);

  const error = validateFilters(draft);
  const activeCount = countActiveFilters(draft);
  const today = todayInputValue();
  const summary = summarize(draft);

  /*
   * The presets and the explicit range are two ways to say the same thing, so
   * picking one clears the other. (The server intersects them if a request
   * carries both — this just keeps the UI from showing two competing answers.)
   */
  const selectDatePreset = (value) =>
    setDraft((current) => ({
      ...current,
      datePosted: value,
      /*
       * Always clears the range, "All time" included. It used to be skipped
       * for "all" on the grounds that it's already the default — but with a
       * range set, All time is the obvious way to clear it, and doing nothing
       * left the only escape as Reset, which wipes all four categories.
       */
      after: "",
      before: "",
    }));

  const setDateBound = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value, datePosted: "all" }));

  const selectFrom = (value) =>
    setDraft((current) => ({
      ...current,
      from: value,
      // Leaving Custom drops the username with it, so an unused handle can't
      // sit in the URL looking like an active filter.
      username: value === "user" ? current.username : "",
    }));

  const reset = (
    <button
      type="button"
      onClick={() => {
        setDraft({ ...DEFAULT_FILTERS });
        setStep(null);
      }}
      disabled={activeCount === 0}
      className="rounded-full px-3 py-1.5 text-[14px] font-semibold text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
    >
      Reset
    </button>
  );

  return (
    <ResponsiveSheet
      title={step ? STEP_TITLES[step] : "Filters"}
      onClose={onClose}
      onBack={step ? () => setStep(null) : undefined}
      // Up beside the close button, where a sheet-wide action belongs — and
      // reachable from every step, not just the first.
      headerAction={reset}
      scrollBody={false}
    >
      {(close) => (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar py-1">
            {step === null && (
              <div className="divide-y divide-neutral-800/70">
                <Row label="From profile" value={summary.from} onOpen={() => setStep("from")} />
                <Row label="Date posted" value={summary.date} onOpen={() => setStep("date")} />
                <Row
                  label="Post activity"
                  value={summary.activity}
                  onOpen={() => setStep("activity")}
                />
                <Row label="Replies" value={summary.replies} onOpen={() => setStep("replies")} />
              </div>
            )}

            {step === "from" && (
              <>
                {FROM_PROFILE_OPTIONS.map((option) => (
                  <ChoiceRow
                    key={option.value}
                    label={option.label}
                    hint={option.hint}
                    selected={draft.from === option.value}
                    onSelect={() => selectFrom(option.value)}
                  />
                ))}
                {draft.from === "user" && (
                  <div className="mx-5 mt-2 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2.5 focus-within:border-neutral-500">
                    <span className="text-[15px] text-neutral-500">@</span>
                    <input
                      type="text"
                      value={draft.username}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          // Handles have no spaces or leading @ — strip both so
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
              </>
            )}

            {step === "date" && (
              <>
                {DATE_POSTED_OPTIONS.map((option) => (
                  <ChoiceRow
                    key={option.value}
                    label={option.label}
                    selected={!draft.after && !draft.before && draft.datePosted === option.value}
                    onSelect={() => selectDatePreset(option.value)}
                  />
                ))}
                <div className="mt-2 border-t border-neutral-800 pt-2">
                  <p className="px-5 pb-1 pt-2 text-[13px] text-neutral-500">
                    Or pick an exact range. Both dates are included, and choosing
                    one clears the preset above.
                  </p>
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
              </>
            )}

            {step === "activity" && (
              <>
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
              </>
            )}

            {step === "replies" && (
              <Toggle
                label="Exclude replies"
                hint="Show only posts, not replies to them."
                checked={draft.excludeReplies}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, excludeReplies: value }))
                }
              />
            )}

            {error && <p className="px-5 py-3 text-[13px] text-red-400">{error}</p>}
          </div>

          <div className="shrink-0 border-t border-neutral-800 p-4">
            <button
              type="button"
              disabled={Boolean(error)}
              onClick={() => {
                onApply(draft);
                close();
              }}
              className="w-full rounded-xl bg-white py-3 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              {activeCount > 0
                ? `Apply ${activeCount} filter${activeCount === 1 ? "" : "s"}`
                : "Apply"}
            </button>
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default SearchFiltersSheet;
