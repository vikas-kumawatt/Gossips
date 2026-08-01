/**
 * The accounts signed in on this device — the *display* half of switching.
 *
 * What is stored here is a name, a handle and an avatar url. It is not a
 * credential and it does not authorise anything: the actual sessions are
 * httpOnly `rt_<id>` cookies the page can't read, and `GET /auth/accounts` is
 * the authority on which of them still work. This list exists so the switcher
 * can paint instantly instead of showing a spinner, and so a row still has a
 * face on it when the network is down.
 *
 * Which means a stale or tampered entry here is harmless: switching to it
 * fails on the server, and the row is reconciled away.
 */

const STORAGE_KEY = "accounts";

/*
 * Five, which is where Instagram and Threads landed. Not arbitrary: every
 * signed-in account is a refresh cookie sent on each /auth request, and a list
 * long enough to need scrolling stops being a quick switch.
 */
export const MAX_ACCOUNTS = 5;

const read = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && entry.id && entry.username);
  } catch {
    // Corrupt entry — start over rather than break every render that reads it.
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
};

const write = (accounts) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts.slice(0, MAX_ACCOUNTS)));
  } catch {
    // Private mode, or the quota is full. Switching degrades to whatever
    // /auth/accounts returns, which is the source of truth anyway.
  }
};

/** Just the fields a row renders — never the token. */
const toEntry = (user) => ({
  id: String(user.id || user._id),
  username: user.username,
  name: user.name || "",
  profilePic: user.profilePic || "",
});

export const getAccounts = () => read();

/**
 * Remembers an account, or refreshes what we show for one we already have.
 *
 * Most recent first, so the account you just used is the easy one to get back
 * to — the same ordering Instagram uses.
 */
export const upsertAccount = (user) => {
  if (!user?.username || !(user.id || user._id)) return read();

  const entry = toEntry(user);
  const rest = read().filter((account) => account.id !== entry.id);
  const next = [entry, ...rest].slice(0, MAX_ACCOUNTS);
  write(next);
  return next;
};

export const removeAccount = (accountId) => {
  const next = read().filter((account) => account.id !== String(accountId));
  write(next);
  return next;
};

export const clearAccounts = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; see write().
  }
};

/**
 * Merges the server's verdict into the local list.
 *
 * The server decides *which* accounts are usable; the local list decides the
 * order and fills in anything the server didn't send. An account the server
 * doesn't recognise is dropped — its session is gone, so a row for it would
 * only fail when tapped.
 */
export const reconcileAccounts = (serverAccounts) => {
  if (!Array.isArray(serverAccounts)) return read();

  /*
   * An empty list is ambiguous and the harmless reading wins. In production
   * the app and the API are different origins, so these are third-party
   * cookies — Safari and Firefox block them outright — and "the browser didn't
   * send them" looks exactly like "you have no accounts". Trusting it would
   * silently and permanently erase the switcher.
   */
  if (!serverAccounts.length) return read();

  const byId = new Map(serverAccounts.map((a) => [String(a.id), a]));
  const local = read();

  // Local order first, then anything the server knows about that we don't —
  // another tab signing in, or this device's list having been cleared.
  const ordered = [
    ...local.filter((account) => byId.has(account.id)),
    ...serverAccounts
      .filter((a) => !local.some((account) => account.id === String(a.id)))
      .map(toEntry),
  ];

  const merged = ordered.map((account) => {
    const fresh = byId.get(account.id);
    // Prefer the server's copy: a name or avatar changed on another device
    // should show up here.
    return fresh ? { ...account, ...toEntry(fresh) } : account;
  });

  write(merged);
  // What write() stored, not what we assembled — otherwise a list over the cap
  // renders rows that were never saved and come back on the next reconcile.
  return merged.slice(0, MAX_ACCOUNTS);
};
