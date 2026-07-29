/**
 * The search filter contract, in one place.
 *
 * The page, the filter sheet and the URL all need to agree on what a filter set
 * is, when it's valid, and how it turns into request parameters — three copies
 * of that logic is how a filter ends up shown as active in the UI while not
 * actually being sent.
 *
 * Filters are held in the shape the form controls use (date inputs give
 * "yyyy-mm-dd", number inputs give strings) and converted at the edges.
 */

export const MAX_QUERY_LENGTH = 100;
export const MAX_COUNT_FILTER = 1_000_000;

export const DEFAULT_FILTERS = {
  from: "anyone",
  username: "",
  datePosted: "all",
  after: "",
  before: "",
  minLikes: "",
  minComments: "",
  minReposts: "",
  excludeReplies: false,
};

export const FROM_PROFILE_OPTIONS = [
  { value: "anyone", label: "Anyone", hint: "Everyone you can see" },
  { value: "following", label: "People you follow", hint: "Only accounts you follow" },
  { value: "user", label: "Custom", hint: "One profile, by username" },
];

export const DATE_POSTED_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "hour", label: "Past hour" },
  { value: "day", label: "Past 24 hours" },
  { value: "week", label: "Past week" },
  { value: "month", label: "Past month" },
  { value: "year", label: "Past year" },
];

const ACTIVITY_FIELDS = ["minLikes", "minComments", "minReposts"];

/** Today as "yyyy-mm-dd" in the viewer's timezone — the ceiling for both pickers. */
export const todayInputValue = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

const parseInputDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  // Rejects "2026-02-31", which Date would roll forward into March.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
};

/**
 * Both ends are inclusive of the day the viewer named: "After 20 July" starts at
 * local midnight on the 20th, "Before 29 July" runs through the end of the 29th.
 * The conversion happens here, in the browser, because only the browser knows
 * which timezone those dates were chosen in.
 */
const startOfLocalDay = (value) => {
  const date = parseInputDate(value);
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfLocalDay = (value) => {
  const date = parseInputDate(value);
  if (!date) return null;
  date.setHours(23, 59, 59, 999);
  return date;
};

const parseCountValue = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return { value: 0 };
  if (!/^\d+$/.test(text)) return { error: true };
  const parsed = Number(text);
  if (parsed > MAX_COUNT_FILTER) return { error: true };
  return { value: parsed };
};

export const normalizeFilters = (filters) => ({ ...DEFAULT_FILTERS, ...(filters || {}) });

/**
 * How many filters differ from the default — the badge on the filter button.
 * "From: custom" counts once, not twice, even though it carries a username.
 */
export const countActiveFilters = (filters) => {
  const next = normalizeFilters(filters);
  let count = 0;
  if (next.from !== "anyone") count += 1;
  if (next.datePosted !== "all") count += 1;
  if (next.after) count += 1;
  if (next.before) count += 1;
  ACTIVITY_FIELDS.forEach((field) => {
    if (String(next[field]).trim()) count += 1;
  });
  if (next.excludeReplies) count += 1;
  return count;
};

/** Whether this filter set alone is enough to search without any search terms. */
export const filtersAnchorSearch = (filters) => {
  const next = normalizeFilters(filters);
  return next.from === "user" && Boolean(next.username.trim());
};

/**
 * Why this filter set can't be applied yet, or null. Checked here rather than
 * only server-side so the sheet can explain the problem before a request.
 */
export const validateFilters = (filters) => {
  const next = normalizeFilters(filters);

  if (next.from === "user" && !next.username.trim()) {
    return "Enter a username, or choose Anyone.";
  }
  if (next.username.trim().length > 40) {
    return "That username is too long.";
  }
  if (next.after && !parseInputDate(next.after)) return "That after date isn't valid.";
  if (next.before && !parseInputDate(next.before)) return "That before date isn't valid.";

  const after = startOfLocalDay(next.after);
  const before = endOfLocalDay(next.before);
  if (after && before && after.getTime() > before.getTime()) {
    return "The after date has to come before the before date.";
  }

  for (const field of ACTIVITY_FIELDS) {
    if (parseCountValue(next[field]).error) {
      return `Activity numbers have to be whole numbers up to ${MAX_COUNT_FILTER.toLocaleString()}.`;
    }
  }
  return null;
};

/** Request parameters for /search/content. Defaults are left out entirely. */
export const filtersToRequestParams = (filters) => {
  const next = normalizeFilters(filters);
  const params = {};

  if (next.from !== "anyone") params.from = next.from;
  if (next.from === "user") params.username = next.username.trim().replace(/^@+/, "");
  if (next.datePosted !== "all") params.datePosted = next.datePosted;

  const after = startOfLocalDay(next.after);
  if (after) params.after = after.toISOString();
  const before = endOfLocalDay(next.before);
  if (before) params.before = before.toISOString();

  ACTIVITY_FIELDS.forEach((field) => {
    const { value, error } = parseCountValue(next[field]);
    if (!error && value > 0) params[field] = value;
  });

  if (next.excludeReplies) params.excludeReplies = "true";
  return params;
};

/**
 * URL round-trip. Filters live in the query string so a refresh, a shared link
 * or the back button all restore the same search.
 */
export const filtersToUrlEntries = (filters) => {
  const next = normalizeFilters(filters);
  const entries = {};

  if (next.from !== "anyone") entries.from = next.from;
  if (next.from === "user" && next.username.trim()) entries.username = next.username.trim();
  if (next.datePosted !== "all") entries.date = next.datePosted;
  if (next.after) entries.after = next.after;
  if (next.before) entries.before = next.before;
  ACTIVITY_FIELDS.forEach((field) => {
    const text = String(next[field]).trim();
    if (text) entries[field.replace("min", "min_").toLowerCase()] = text;
  });
  if (next.excludeReplies) entries.noreplies = "1";

  return entries;
};

export const filtersFromUrl = (searchParams) => {
  const read = (key) => searchParams.get(key) || "";
  const from = read("from");
  const datePosted = read("date");

  const candidate = {
    ...DEFAULT_FILTERS,
    from: FROM_PROFILE_OPTIONS.some((option) => option.value === from) ? from : "anyone",
    username: read("username").slice(0, 40),
    datePosted: DATE_POSTED_OPTIONS.some((option) => option.value === datePosted)
      ? datePosted
      : "all",
    after: read("after"),
    before: read("before"),
    minLikes: read("min_likes"),
    minComments: read("min_comments"),
    minReposts: read("min_reposts"),
    excludeReplies: read("noreplies") === "1",
  };

  // A hand-edited or truncated link shouldn't leave the page stuck on an
  // unusable filter set, so anything that fails validation falls back to
  // defaults rather than being applied half-way.
  return validateFilters(candidate) ? { ...DEFAULT_FILTERS } : candidate;
};

/**
 * Active filters as removable chips. `key` is what `clearFilterKey` takes, so
 * the row and the removal stay in step.
 */
export const describeActiveFilters = (filters) => {
  const next = normalizeFilters(filters);
  const chips = [];

  if (next.from === "following") chips.push({ key: "from", label: "People you follow" });
  if (next.from === "user" && next.username.trim()) {
    chips.push({ key: "from", label: `From @${next.username.trim().replace(/^@+/, "")}` });
  }
  const preset = DATE_POSTED_OPTIONS.find((option) => option.value === next.datePosted);
  if (preset && preset.value !== "all") chips.push({ key: "datePosted", label: preset.label });
  if (next.after) chips.push({ key: "after", label: `After ${next.after}` });
  if (next.before) chips.push({ key: "before", label: `Before ${next.before}` });
  if (String(next.minLikes).trim()) chips.push({ key: "minLikes", label: `${next.minLikes}+ likes` });
  if (String(next.minComments).trim()) {
    chips.push({ key: "minComments", label: `${next.minComments}+ comments` });
  }
  if (String(next.minReposts).trim()) {
    chips.push({ key: "minReposts", label: `${next.minReposts}+ reposts` });
  }
  if (next.excludeReplies) chips.push({ key: "excludeReplies", label: "No replies" });

  return chips;
};

export const clearFilterKey = (filters, key) => {
  const next = normalizeFilters(filters);
  if (key === "from") return { ...next, from: "anyone", username: "" };
  return { ...next, [key]: DEFAULT_FILTERS[key] };
};
