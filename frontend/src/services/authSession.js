import axios from "axios";

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
    localStorage.removeItem("user");
    if (emitEvent) window.dispatchEvent(new Event(AUTH_EVENT));
    return;
  }

  localStorage.setItem("user", JSON.stringify(user));
  if (emitEvent) window.dispatchEvent(new Event(AUTH_EVENT));
};

const isRefreshRequest = (requestUrl = "") =>
  requestUrl.includes("/auth/refresh");

const refreshAccessToken = async () => {
  if (!refreshRequest) {
    refreshRequest = refreshClient
      .post("/auth/refresh", {})
      .then(({ data }) => data.token)
      .finally(() => {
        refreshRequest = null;
      });
  }

  return refreshRequest;
};

const attachAuthInterceptors = (client) => {
  if (configuredClients.has(client)) return;
  configuredClients.add(client);

  client.defaults.withCredentials = true;

  client.interceptors.request.use((config) => {
    const user = safeParseUser();
    if (user?.token) {
      config.headers.Authorization = `Bearer ${user.token}`;
    }
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
