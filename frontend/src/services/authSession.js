import axios from "axios";
import { upsertAccount } from "../lib/accounts";

const AUTH_EVENT = "auth:updated";
const BASE_URL = import.meta.env.VITE_SERVER;
const refreshClient = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
});

let refreshRequest = null;
const configuredClients = new WeakSet();

const safeParseUser = () => {
  const userStr = localStorage.getItem("user");
  if (!userStr) return null;

  try {
    return JSON.parse(userStr);
  } catch {
    localStorage.removeItem("user");
    return null;
  }
};

const persistUser = (user, emitEvent = true) => {
  if (!user?.token) {
    /*
     * Only the *active* user is cleared. The account list is deliberately left
     * alone: an expired access token is not a sign-out, and wiping the list
     * here would silently un-add every other account any time a refresh
     * failed. Removing an account is an explicit act — see signOutAccount.
     */
    localStorage.removeItem("user");
    if (emitEvent) window.dispatchEvent(new Event(AUTH_EVENT));
    return;
  }

  localStorage.setItem("user", JSON.stringify(user));
  // Signing in, switching and refreshing all funnel through here, so this is
  // the one place that has to remember who's on this device.
  if (user.id || user._id) upsertAccount(user);
  if (emitEvent) window.dispatchEvent(new Event(AUTH_EVENT));
};

const isRefreshRequest = (requestUrl = "") =>
  requestUrl.includes("/auth/refresh");

const refreshAccessToken = async () => {
  if (!refreshRequest) {
    /*
     * Name the account. With several signed in, the shared cookie points at
     * whoever was switched to last — so a tab still showing account A would
     * otherwise be handed a session for account B and start acting as them.
     * The server rejects a mismatch; the assertion below is the second belt.
     */
    const accountId = safeParseUser()?.id || safeParseUser()?._id || null;

    refreshRequest = refreshClient
      .post(
        "/auth/refresh",
        { accountId },
        deviceId ? { headers: { "X-Device-Id": deviceId } } : undefined
      )
      .then(({ data }) => {
        if (accountId && data.accountId && String(data.accountId) !== String(accountId)) {
          throw new Error("Refreshed a different account");
        }
        return data.token;
      })
      .finally(() => {
        refreshRequest = null;
      });
  }

  return refreshRequest;
};

/*
 * The device's own time zone and locale.
 *
 * These are the last-resort signals for "Based in": the server tries a CDN geo
 * header first, then an IP lookup, and only falls back to these — see
 * server/utils/geo.js. Read once, because constructing a DateTimeFormat parses
 * locale data.
 *
 * They live here rather than beside the other API helpers because sign-in runs
 * through the *global* axios instance, not the configured `api` one, and these
 * are only read on sign-in. Attaching them to one instance meant the fallback
 * silently never fired.
 */
/**
 * A stable id for this browser.
 *
 * The server keys one session row per (account, device) on it, which is what
 * makes signing in on a phone stop evicting the laptop. It names a device and
 * authorises nothing, so it lives in plain localStorage and forging one buys
 * an attacker only a session row of their own.
 */
const deviceId = (() => {
  try {
    const existing = localStorage.getItem("deviceId");
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;

    const fresh =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("deviceId", fresh);
    return fresh;
  } catch {
    // Private mode: the server falls back to a random per-sign-in id, which
    // costs a spare session row and nothing else.
    return "";
  }
})();

const deviceHints = (() => {
  try {
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      locale: navigator.language || "",
    };
  } catch {
    return { timeZone: "", locale: "" };
  }
})();

const attachAuthInterceptors = (client) => {
  if (configuredClients.has(client)) return;
  configuredClients.add(client);

  client.defaults.withCredentials = true;

  client.interceptors.request.use((config) => {
    const user = safeParseUser();
    if (user?.token) {
      config.headers.Authorization = `Bearer ${user.token}`;
    }
    if (deviceHints.timeZone) config.headers["X-Client-Timezone"] = deviceHints.timeZone;
    if (deviceHints.locale) config.headers["X-Client-Locale"] = deviceHints.locale;
    if (deviceId) config.headers["X-Device-Id"] = deviceId;
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error?.config;
      const isUnauthorized = error?.response?.status === 401;
      const responseMessage = error?.response?.data?.message;
      const requestUrl = originalRequest?.url || "";
      const isRefresh401 = isUnauthorized && isRefreshRequest(requestUrl);
      const isInvalidRefreshToken = responseMessage === "Invalid refresh token";

      if (isRefresh401 || isInvalidRefreshToken) {
        persistUser(null);
        return Promise.reject(error);
      }

      if (!originalRequest || !isUnauthorized || originalRequest._retry) {
        return Promise.reject(error);
      }

      originalRequest._retry = true;

      try {
        const newToken = await refreshAccessToken();
        const user = safeParseUser();
        if (!user) {
          return Promise.reject(error);
        }

        persistUser({ ...user, token: newToken });
        originalRequest.headers.Authorization = `Bearer ${newToken}`;

        return client(originalRequest);
      } catch (refreshError) {
        persistUser(null);
        return Promise.reject(refreshError);
      }
    }
  );
};

export {
  AUTH_EVENT,
  attachAuthInterceptors,
  persistUser,
  safeParseUser,
  refreshAccessToken,
};
