import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import {
  DEFAULT_POLL_DURATION,
  POLL_DURATIONS,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  validatePoll,
} from "../lib/attachments";

/**
 * Writes a poll: a question, two to four options, and how long it runs.
 *
 * `value` re-opens an existing draft poll so editing doesn't start from blank.
 */
const PollComposerSheet = ({ value, onDone, onClose }) => {
  const [question, setQuestion] = useState(value?.question || "");
  const [options, setOptions] = useState(() => {
    const existing = value?.options?.map((o) => o.text ?? o) || [];
    // Always render at least the two required rows.
    while (existing.length < POLL_MIN_OPTIONS) existing.push("");
    return existing;
  });
  const [durationMinutes, setDurationMinutes] = useState(
    value?.durationMinutes || DEFAULT_POLL_DURATION
  );
  const [durationOpen, setDurationOpen] = useState(false);

  const problem = validatePoll({ question, options, durationMinutes });

  const setOption = (index, text) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? text : o)));

  const addOption = () =>
    setOptions((prev) => (prev.length < POLL_MAX_OPTIONS ? [...prev, ""] : prev));

  const removeOption = (index) =>
    setOptions((prev) => (prev.length > POLL_MIN_OPTIONS ? prev.filter((_, i) => i !== index) : prev));

  const durationLabel =
    POLL_DURATIONS.find((d) => d.value === durationMinutes)?.label || "1 day";

  return (
    <ResponsiveSheet title="Create a poll" onClose={onClose}>
      {(close) => (
        <div className="flex flex-col px-4 py-4">
          <label className="mb-1 block text-[13px] font-medium text-neutral-400">Question</label>
          <div className="relative">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value.slice(0, POLL_QUESTION_MAX))}
              placeholder="Ask something"
              className="w-full rounded-xl border border-neutral-700 bg-neutral-800/60 px-3 py-2.5 pr-14 text-[15px] text-white outline-none transition-colors focus:border-neutral-500 placeholder:text-neutral-500"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-neutral-500">
              {question.length}/{POLL_QUESTION_MAX}
            </span>
          </div>

          <label className="mt-5 mb-1 block text-[13px] font-medium text-neutral-400">
            Options
          </label>
          <div className="flex flex-col gap-2">
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  value={option}
                  onChange={(e) => setOption(index, e.target.value.slice(0, POLL_OPTION_MAX))}
                  placeholder={`Option ${index + 1}`}
                  className="min-w-0 flex-1 rounded-xl border border-neutral-700 bg-neutral-800/60 px-3 py-2.5 text-[15px] text-white outline-none transition-colors focus:border-neutral-500 placeholder:text-neutral-500"
                />
                {/* The first two are required, so they get no remove button
                    rather than a disabled one that looks broken. */}
                {options.length > POLL_MIN_OPTIONS && (
                  <button
                    type="button"
                    onClick={() => removeOption(index)}
                    className="shrink-0 rounded-full p-2 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white cursor-pointer"
                    aria-label={`Remove option ${index + 1}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {options.length < POLL_MAX_OPTIONS && (
            <button
              type="button"
              onClick={addOption}
              className="mt-2 flex items-center gap-2 self-start rounded-lg px-2 py-1.5 text-[14px] font-medium text-neutral-300 transition-colors hover:bg-neutral-800 cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              Add option
            </button>
          )}

          <label className="mt-5 mb-1 block text-[13px] font-medium text-neutral-400">
            Poll length
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setDurationOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-xl border border-neutral-700 bg-neutral-800/60 px-3 py-2.5 text-left text-[15px] text-white transition-colors hover:border-neutral-500 cursor-pointer"
            >
              <span>{durationLabel}</span>
              <span className="text-[13px] text-neutral-500">Change</span>
            </button>
            {durationOpen && (
              <div className="absolute inset-x-0 bottom-full z-10 mb-1 overflow-hidden rounded-xl border border-neutral-700 bg-[#181818] shadow-xl">
                {POLL_DURATIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => {
                      setDurationMinutes(d.value);
                      setDurationOpen(false);
                    }}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-[15px] text-white transition-colors hover:bg-neutral-800 cursor-pointer"
                  >
                    <span>{d.label}</span>
                    {d.value === durationMinutes && <Check className="h-4 w-4" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="mt-4 text-[13px] text-neutral-500">
            {problem || "Results stay hidden until someone votes or the poll closes."}
          </p>

          <button
            type="button"
            disabled={Boolean(problem)}
            onClick={() => {
              onDone({
                question: question.trim(),
                options: options.map((o) => o.trim()).filter(Boolean),
                durationMinutes,
              });
              close();
            }}
            className="mt-4 w-full rounded-xl bg-white py-3 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            Done
          </button>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default PollComposerSheet;
