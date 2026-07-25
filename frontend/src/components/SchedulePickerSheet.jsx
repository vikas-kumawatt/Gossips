import { useEffect, useMemo, useRef, useState } from "react";
import ResponsiveSheet from "./ui/responsive-sheet";
import {
  buildDayOptions,
  composeSchedule,
  dayKey,
  isTooSoon,
  to12Hour,
} from "../lib/schedule";

const ITEM_H = 40;
// Odd so there's a true middle row to highlight.
const VISIBLE_ROWS = 5;
const PAD = ((VISIBLE_ROWS - 1) / 2) * ITEM_H;
// Long enough that momentum scrolling has stopped, short enough to feel instant.
const SETTLE_MS = 120;

/**
 * One scroll wheel. Selection follows the scroll position rather than a click,
 * so it behaves like the native iOS/Android pickers people expect here — but
 * clicking a row still works, because on desktop there's no flick gesture.
 */
const Wheel = ({ options, value, onChange, label }) => {
  const ref = useRef(null);
  const settleTimer = useRef(null);
  // Set while we scroll the wheel ourselves, so the resulting scroll events
  // don't get mistaken for the user picking something.
  const programmatic = useRef(false);
  // The settle timer fires up to SETTLE_MS after the render that scheduled it,
  // by which time `options` may have been rebuilt (changing the hour rebuilds
  // the minute column). Reading commit through a ref keeps it current.
  const commitRef = useRef(null);

  const index = options.findIndex((o) => o.value === value);

  // Positioning happens here and only here — a second scroll from `commit`
  // would be cancelled by this one mid-animation and just generate more
  // scroll events.
  useEffect(() => {
    const el = ref.current;
    if (!el || index < 0) return;
    const target = index * ITEM_H;
    if (Math.abs(el.scrollTop - target) < 1) return;
    programmatic.current = true;
    el.scrollTop = target;
    // One frame is enough for the scroll event to have fired.
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, [index]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  commitRef.current = () => {
    const el = ref.current;
    if (!el) return;

    let i = Math.round(el.scrollTop / ITEM_H);
    i = Math.max(0, Math.min(options.length - 1, i));

    // Landing on a time that's already passed slides forward to the next one
    // that hasn't, rather than leaving an unusable value selected.
    if (options[i].disabled) {
      let next = -1;
      for (let j = i; j < options.length; j += 1) {
        if (!options[j].disabled) { next = j; break; }
      }
      if (next === -1) {
        for (let j = i; j >= 0; j -= 1) {
          if (!options[j].disabled) { next = j; break; }
        }
      }
      // Every option is unusable — the whole AM column after midday, say.
      // Snap back to where the value actually is so the highlight band and
      // the state can't disagree; the parent clamps the day/hour instead.
      if (next === -1) {
        if (index >= 0) el.scrollTop = index * ITEM_H;
        return;
      }
      i = next;
    }

    if (options[i].value !== value) {
      onChange(options[i].value);
    } else {
      // Same value, so the [index] effect won't run — align the rest of the
      // way here. A tolerance, not equality: scrollTop is fractional under
      // display scaling, and `!==` would re-scroll forever.
      const target = i * ITEM_H;
      if (Math.abs(el.scrollTop - target) > 1) {
        programmatic.current = true;
        el.scrollTop = target;
        requestAnimationFrame(() => {
          programmatic.current = false;
        });
      }
    }
  };

  const handleScroll = () => {
    if (programmatic.current) return;
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => commitRef.current?.(), SETTLE_MS);
  };

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      onScroll={handleScroll}
      className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-hide snap-y snap-mandatory"
      /*
       * No `scroll-padding` here. The blank rows above and below the options
       * are what let the first and last ones reach the middle; adding scroll
       * padding on top of that shrinks the snapport, which moves every snap
       * point up by one row. The last option's centred position then isn't a
       * snap point at all, so mandatory snapping drags it back off centre and
       * it can never be selected.
       */
      style={{ height: VISIBLE_ROWS * ITEM_H }}
    >
      <div style={{ paddingTop: PAD, paddingBottom: PAD }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              disabled={option.disabled}
              onClick={() => !option.disabled && onChange(option.value)}
              className={`w-full snap-center flex items-center justify-center px-1 text-[15px] transition-colors ${
                option.disabled
                  ? "text-neutral-700 cursor-not-allowed"
                  : selected
                    ? "text-white font-semibold"
                    : "text-neutral-500 hover:text-neutral-300 cursor-pointer"
              }`}
              style={{ height: ITEM_H }}
            >
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: String(i + 1),
}));

// 00–59. There is no minute 60 — it's the next hour.
const MINUTES = Array.from({ length: 60 }, (_, i) => ({
  value: i,
  label: String(i).padStart(2, "0"),
}));

const MERIDIEMS = [
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
];

/**
 * "Schedule Post" / "Schedule Comment" — four wheels and a Done button.
 *
 * @param {Date|string|null} value    currently scheduled time, if re-opening
 * @param {(date: Date) => void} onDone
 * @param {() => void} onClose
 */
const SchedulePickerSheet = ({ value, kind = "Post", onDone, onClose }) => {
  const days = useMemo(buildDayOptions, []);

  // Default to the next round half hour — a sensible starting point that's
  // always comfortably in the future.
  const initial = useMemo(() => {
    const existing = value ? new Date(value) : null;
    if (existing && !Number.isNaN(existing.getTime()) && existing.getTime() > Date.now()) {
      return existing;
    }
    const d = new Date(Date.now() + 30 * 60 * 1000);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    return d;
  }, [value]);

  const [day, setDay] = useState(() => dayKey(initial));
  const [hour, setHour] = useState(() => to12Hour(initial.getHours()));
  const [minute, setMinute] = useState(() => initial.getMinutes());
  const [meridiem, setMeridiem] = useState(() => (initial.getHours() >= 12 ? "PM" : "AM"));

  const selectedDay = days.find((d) => d.value === day) || days[0];
  const selected = composeSchedule(selectedDay, hour, minute, meridiem);
  const invalid = isTooSoon(selected);

  /**
   * Anything that would compose to a time too soon is dimmed.
   *
   * Each column asks the same question the Done button does — "would this
   * produce a valid moment?" — holding the other three fixed. Deriving it from
   * `isTooSoon(composeSchedule(...))` rather than comparing raw hours keeps the
   * columns honest about the minute lead time and about each other; an hour
   * stays enabled only while some minute in it is still reachable.
   */
  // Time runs forward within a column, so "is any option under this one still
  // reachable?" only needs the latest of them: 11:59 for a half-day, :59 for
  // an hour. (12 AM is 00:xx, which is why the check is per-hour.)
  const meridiemOptions = MERIDIEMS.map((m) => ({
    ...m,
    disabled: isTooSoon(composeSchedule(selectedDay, 11, 59, m.value)),
  }));
  const hourOptions = HOURS.map((h) => ({
    ...h,
    disabled: isTooSoon(composeSchedule(selectedDay, h.value, 59, meridiem)),
  }));
  const minuteOptions = MINUTES.map((m) => ({
    ...m,
    disabled: isTooSoon(composeSchedule(selectedDay, hour, m.value, meridiem)),
  }));

  const dayOptions = days.map((d) => ({ value: d.value, label: d.label }));

  /**
   * Nudge an invalid selection forward instead of stranding the user.
   *
   * Picking 9 AM for tomorrow and then switching back to today leaves two
   * columns selected-but-disabled, and nothing moves on its own: each wheel
   * only re-evaluates when *it* is scrolled. So when the composed time is
   * unreachable, walk to the first combination that isn't.
   */
  useEffect(() => {
    if (!invalid) return;
    for (const m of MERIDIEMS) {
      for (const h of HOURS) {
        for (const mi of MINUTES) {
          if (!isTooSoon(composeSchedule(selectedDay, h.value, mi.value, m.value))) {
            setMeridiem(m.value);
            setHour(h.value);
            setMinute(mi.value);
            return;
          }
        }
      }
    }
    // Nothing left today at all — move to tomorrow and let this run again.
    if (selectedDay.value === days[0].value) setDay(days[1].value);
  }, [invalid, selectedDay, days]);

  return (
    // The content is a fixed height, so the sheet can size to it rather than
    // taking over the viewport the way a pinned-footer layout would.
    <ResponsiveSheet title={`Schedule ${kind}`} onClose={onClose}>
      {(close) => (
        <div className="flex flex-col">
          <div className="px-4 pt-4">
            {/* The wheels scroll under this band; it marks the selected row. */}
            <div className="relative">
              <div
                className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-xl bg-neutral-800/70"
                style={{ height: ITEM_H }}
              />
              <div className="relative flex gap-1">
                <Wheel label="Date" options={dayOptions} value={day} onChange={setDay} />
                <Wheel label="Hour" options={hourOptions} value={hour} onChange={setHour} />
                <Wheel label="Minute" options={minuteOptions} value={minute} onChange={setMinute} />
                <Wheel label="AM or PM" options={meridiemOptions} value={meridiem} onChange={setMeridiem} />
              </div>
            </div>

            <p className="mt-4 text-center text-[13px] text-neutral-500">
              {invalid
                ? "Pick a time at least a minute from now"
                : `Goes out on ${selectedDay.label}`}
            </p>
          </div>

          <div className="border-t border-neutral-800 p-4 mt-4">
            <button
              type="button"
              disabled={invalid}
              onClick={() => {
                onDone(selected);
                close();
              }}
              className="w-full rounded-xl bg-white py-3 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default SchedulePickerSheet;
