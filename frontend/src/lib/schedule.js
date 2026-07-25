/**
 * Shared date maths for scheduling. Kept out of the components so the picker,
 * the composer chip and the scheduled-posts page all format and validate the
 * same way.
 */

export const SCHEDULE_MAX_DAYS = 30;
// Mirrors the server's minimum lead time in utils/publishing.js. Keep the two
// in step, or the picker will happily offer a time the API rejects.
export const MIN_LEAD_MS = 60 * 1000;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat, 25 Jul" */
export const formatDayLabel = (date) =>
  `${DAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;

/** Midnight-anchored key so two Dates on the same day compare equal. */
export const dayKey = (date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** Today plus the next 29 days. */
export const buildDayOptions = () => {
  const today = new Date();
  return Array.from({ length: SCHEDULE_MAX_DAYS }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    return { value: dayKey(d), label: formatDayLabel(d), date: d };
  });
};

export const to12Hour = (hour24) => {
  const h = hour24 % 12;
  return h === 0 ? 12 : h;
};

/** Assemble the four wheel values into a real Date in the user's own zone. */
export const composeSchedule = (dayOption, hour12, minute, meridiem) => {
  if (!dayOption) return null;
  const base = dayOption.date;
  let hour = hour12 % 12;
  if (meridiem === "PM") hour += 12;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
};

export const isTooSoon = (date) =>
  !date || date.getTime() < Date.now() + MIN_LEAD_MS;

/** "Sat, 25 Jul at 6:30 PM" */
export const formatScheduleLabel = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const minute = String(date.getMinutes()).padStart(2, "0");
  const meridiem = date.getHours() >= 12 ? "PM" : "AM";
  return `${formatDayLabel(date)} at ${to12Hour(date.getHours())}:${minute} ${meridiem}`;
};

/** "in 3 hours" / "in 2 days" — the reassurance line under a scheduled item. */
export const formatTimeUntil = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "any moment now";

  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
};
