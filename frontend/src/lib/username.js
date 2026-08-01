/**
 * Username rules, client copy.
 *
 * A deliberate duplicate of server/utils/username.js. The server is the one
 * that decides — this exists so a typo gets an answer on the keystroke rather
 * than after a round-trip, and so the form can stop obviously-bad input before
 * spending a request on it. If the two ever disagree the server wins, which is
 * why the form always shows the server's message once it has one.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

const USERNAME_RE = /^[a-z0-9_]+$/;

export const normalizeUsername = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/** @returns {string|null} an error message, or null when the shape is fine */
export const validateUsernameFormat = (username) => {
  if (!username) return "Username is required";
  if (username.length < USERNAME_MIN)
    return `Username must be at least ${USERNAME_MIN} characters`;
  if (username.length > USERNAME_MAX)
    return `Username must be ${USERNAME_MAX} characters or fewer`;
  if (!USERNAME_RE.test(username))
    return "Username can only contain letters, numbers and underscores";
  if (!/[a-z0-9]/.test(username))
    return "Username must contain at least one letter or number";
  return null;
};

/** "in 6 days" / "in 4 hours" — how long until the next change is allowed. */
export const untilLabel = (date) => {
  if (!date) return "";
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";

  const hours = Math.ceil(ms / 3600000);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.ceil(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
};
