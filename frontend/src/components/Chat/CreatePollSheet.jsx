import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "../ui/responsive-sheet";
import { chatAPI } from "../../services/api";

const QUESTION_MAX = 300;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

/** Minutes to run for, or null for no expiry — converted to an ISO
 *  `expiresAt` right before the request goes out. */
const DURATIONS = [
  { label: "No limit", minutes: null },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 6 * 60 },
  { label: "24 hours", minutes: 24 * 60 },
  { label: "7 days", minutes: 7 * 24 * 60 },
];

/** A boolean on/off row, matching the switch used in SearchFiltersSheet /
 *  EditContentSheet elsewhere in the app. */
const Toggle = ({ checked, onChange, label }) => (
  <div className="flex items-center justify-between gap-3 px-3.5 py-3">
    <span className="text-[15px] text-white">{label}</span>
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

/**
 * Composes a chat poll and posts it via `chatAPI.createPoll`.
 *
 * Exactly one of `receiverId` / `groupId` is expected — that's the caller's
 * contract to uphold, this just forwards whichever it was given.
 */
const CreatePollSheet = ({ receiverId, groupId, onClose, onCreated }) => {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [allowMultipleAnswers, setAllowMultipleAnswers] = useState(false);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const setOption = (index, text) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? text : o)));

  const addOption = () =>
    setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ""] : prev));

  const removeOption = (index) =>
    setOptions((prev) => (prev.length > MIN_OPTIONS ? prev.filter((_, i) => i !== index) : prev));

  const trimmedOptions = options.map((o) => o.trim());
  const filledCount = trimmedOptions.filter(Boolean).length;
  const canSubmit = question.trim().length > 0 && filledCount >= MIN_OPTIONS && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const expiresAt = durationMinutes
        ? new Date(Date.now() + durationMinutes * 60000).toISOString()
        : null;

      await chatAPI.createPoll({
        ...(receiverId ? { receiverId } : { groupId }),
        question: question.trim(),
        options: trimmedOptions.filter(Boolean),
        settings: { allowMultipleAnswers, isAnonymous, expiresAt },
      });

      onCreated?.();
      onClose();
    } catch (err) {
      // Left everything the user typed in place — a failed poll shouldn't
      // cost them the question and options they just wrote.
      toast.error(err?.response?.data?.error || "Couldn't create the poll");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ResponsiveSheet onClose={onClose} title="Create poll" scrollBody={false}>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-4 py-3 flex flex-col gap-5">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-neutral-400">
              Question
            </label>
            <div className="relative">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value.slice(0, QUESTION_MAX))}
                placeholder="Ask something"
                className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3.5 py-2.5 pr-14 text-[15px] text-white placeholder:text-neutral-500 outline-none focus:border-neutral-600"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-neutral-500">
                {question.length}/{QUESTION_MAX}
              </span>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-neutral-400">
              Options
            </label>
            <div className="flex flex-col gap-2">
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    value={option}
                    onChange={(e) => setOption(index, e.target.value)}
                    placeholder={`Option ${index + 1}`}
                    className="min-w-0 flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-3.5 py-2.5 text-[15px] text-white placeholder:text-neutral-500 outline-none focus:border-neutral-600"
                  />
                  {/* The first two are required, so they get no remove button
                      rather than a disabled one that looks broken. */}
                  {options.length > MIN_OPTIONS && (
                    <button
                      type="button"
                      onClick={() => removeOption(index)}
                      aria-label={`Remove option ${index + 1}`}
                      className="shrink-0 p-2 rounded-full text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {options.length < MAX_OPTIONS && (
              <button
                type="button"
                onClick={addOption}
                className="mt-2 flex items-center gap-1.5 text-[14px] font-medium text-neutral-300 hover:text-white transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add option
              </button>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-neutral-400">
              Settings
            </label>
            <div className="flex flex-col divide-y divide-neutral-800 rounded-xl border border-neutral-800 overflow-hidden">
              <Toggle
                checked={allowMultipleAnswers}
                onChange={setAllowMultipleAnswers}
                label="Allow multiple answers"
              />
              <Toggle checked={isAnonymous} onChange={setIsAnonymous} label="Anonymous voting" />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-neutral-400">
              Duration
            </label>
            <select
              value={durationMinutes ?? "none"}
              onChange={(e) =>
                setDurationMinutes(e.target.value === "none" ? null : Number(e.target.value))
              }
              className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3.5 py-2.5 text-[15px] text-white outline-none focus:border-neutral-600 cursor-pointer"
            >
              {DURATIONS.map((d) => (
                <option key={d.label} value={d.minutes ?? "none"}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="shrink-0 px-4 py-3 border-t border-neutral-800">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-3 rounded-xl bg-white text-black text-[15px] font-semibold hover:bg-neutral-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Create poll
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
};

export default CreatePollSheet;
