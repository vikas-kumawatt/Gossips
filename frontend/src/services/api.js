import axios from "axios";
import { attachAuthInterceptors } from "./authSession";
import { getCachedRequest, setCachedRequest } from "../utils/requestCache";

const BASE_URL = import.meta.env.VITE_SERVER;

const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
});

attachAuthInterceptors(api);

const inFlightGetRequests = new Map();
const DEFAULT_TTL_MS = 60 * 1000;
const INTERCEPTOR_TTL_MS = 60 * 1000;

const getUserScope = () => {
  try {
    const raw = localStorage.getItem("user");
    if (!raw) return "anon";
    const user = JSON.parse(raw);
    return String(user?.id || user?._id || user?.username || "anon");
  } catch {
    return "anon";
  }
};

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const buildGetCacheKey = (url, params, cacheKey) => {
  const scope = getUserScope();
  const keyPart = cacheKey || `${url}::${stableStringify(params || {})}`;
  return `v1::${scope}::GET::${keyPart}`;
};

const resolveAbsoluteUrl = (config = {}) => {
  const rawUrl = config.url || "";
  if (!rawUrl) return "";
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  const base = config.baseURL || BASE_URL || "";
  if (!base) return rawUrl;
  try {
    return new URL(rawUrl, base).toString();
  } catch {
    return `${base}${rawUrl}`;
  }
};

const buildAxiosCacheKey = (config = {}) => {
  const scope = getUserScope();
  const method = String(config.method || "get").toUpperCase();
  const url = resolveAbsoluteUrl(config);
  const params = stableStringify(config.params || {});
  return `v1::${scope}::AXIOS::${method}::${url}::${params}`;
};

const cachedGet = async (url, config = {}, options = {}) => {
  const { ttlMs = DEFAULT_TTL_MS, cacheKey, bypassCache = false } = options;
  const key = buildGetCacheKey(url, config?.params, cacheKey);

  if (!bypassCache) {
    const cached = await getCachedRequest(key).catch(() => null);
    if (cached && Date.now() - cached.ts <= ttlMs) {
      return cached.data;
    }
  }

  if (inFlightGetRequests.has(key)) {
    return inFlightGetRequests.get(key);
  }

  const pending = api.get(url, {
    ...config,
    // Must not use a custom *HTTP* header — that triggers CORS preflight and the
    // server must allow it in Access-Control-Allow-Headers. This flag stays on
    // the axios config only and is never sent over the wire.
    skipRequestCacheInterceptor: true,
  })
    .then(async (response) => {
      const data = response.data;
      await setCachedRequest(key, {
        ts: Date.now(),
        data,
      }).catch(() => {});
      return data;
    })
    .finally(() => {
      inFlightGetRequests.delete(key);
    });

  inFlightGetRequests.set(key, pending);
  return pending;
};

const installCacheInterceptors = (client) => {
  client.interceptors.request.use(async (config) => {
    const method = String(config?.method || "get").toLowerCase();
    const skipInterceptor = Boolean(config?.skipRequestCacheInterceptor);
    if (skipInterceptor || method !== "get") return config;

    const key = buildAxiosCacheKey(config);
    config.__cacheKey = key;

    const cached = await getCachedRequest(key).catch(() => null);
    if (!cached || Date.now() - cached.ts > INTERCEPTOR_TTL_MS) {
      return config;
    }

    config.adapter = async () => ({
      data: cached.data,
      status: 200,
      statusText: "OK",
      headers: {},
      config,
      request: { fromCache: true },
    });

    return config;
  });

  client.interceptors.response.use(
    async (response) => {
      const method = String(response?.config?.method || "get").toLowerCase();
      const skipInterceptor = Boolean(
        response?.config?.skipRequestCacheInterceptor
      );

      if (!skipInterceptor && method === "get" && response?.config?.__cacheKey) {
        await setCachedRequest(response.config.__cacheKey, {
          ts: Date.now(),
          data: response.data,
        }).catch(() => {});
      }

      return response;
    },
    (error) => Promise.reject(error)
  );
};

installCacheInterceptors(api);

// ─── Auth ────────────────────────────────────────────────────────────────────
export const authAPI = {
  signup: (data) => api.post("/auth/signup", data).then((r) => r.data),
  login: (data) => api.post("/auth/login", data).then((r) => r.data),
  googleLogin: (data) => api.post("/auth/googlelogin", data).then((r) => r.data),
  forgotPassword: (email) =>
    api.post("/auth/forgot-password", { email }).then((r) => r.data),
  resetPassword: (data) =>
    api.post("/auth/reset-password", data).then((r) => r.data),
  refresh: () => api.post("/auth/refresh", {}).then((r) => r.data),
  logout: () => api.post("/auth/logout").then((r) => r.data),
};

// ─── User ────────────────────────────────────────────────────────────────────
export const userAPI = {
  setupProfile: (formData) =>
    api
      .post("/user/profile-setup", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),

  getUsers: (params) => cachedGet("/user/users", { params }),

  getProfile: (username) => cachedGet(`/user/${username}`),

  getFollowers: (username, params) =>
    cachedGet(`/user/${username}/followers`, { params }),

  getFollowingUsers: (username, params) =>
    cachedGet(`/user/${username}/following`, { params }),

  getReplies: (username, params) =>
    cachedGet(`/user/${username}/replies`, { params }),

  getReposts: (profileId, params) =>
    cachedGet(`/user/${profileId}/reposts`, { params }),

  follow: (username) =>
    api.post(`/user/follow/${username}`).then((r) => r.data),

  unfollow: (username) =>
    api.post(`/user/unfollow/${username}`).then((r) => r.data),

  getFollowRequests: () => cachedGet("/user/follow-requests"),

  acceptFollowRequest: (requestId) =>
    api.post(`/user/follow-requests/${requestId}/accept`).then((r) => r.data),

  rejectFollowRequest: (requestId) =>
    api.post(`/user/follow-requests/${requestId}/reject`).then((r) => r.data),

  cancelFollowRequest: (username) =>
    api.delete(`/user/follow-request/${username}`).then((r) => r.data),

  getPendingRequest: (username) =>
    cachedGet(`/user/pending-request/${username}`),

  isFollowingMe: (username) =>
    cachedGet(`/user/is-following-me/${username}`),

  restrict: (username) =>
    api.post(`/user/restrict/${username}`).then((r) => r.data),

  block: (username) =>
    api.post(`/user/block/${username}`).then((r) => r.data),

  unblock: (username) =>
    api.post(`/user/unblock/${username}`).then((r) => r.data),

  getBlocked: () => api.get(`/user/blocked`).then((r) => r.data),

  mute: (username) =>
    api.post(`/user/mute/${username}`).then((r) => r.data),

  unmute: (username) =>
    api.post(`/user/unmute/${username}`).then((r) => r.data),

  getMuted: () => api.get(`/user/muted`).then((r) => r.data),
};

// ─── Sharing ─────────────────────────────────────────────────────────────────
export const shareAPI = {
  // Uncached: ranking shifts as you message people, and search is per-keystroke.
  targets: (params) =>
    api
      .get("/chats/share-targets", { params, skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  // { targetType, targetId, recipientIds?, groupIds?, newGroupMemberIds?, groupName?, note? }
  send: (payload) => api.post("/chats/share", payload).then((r) => r.data),

  hideSuggestion: (userId) =>
    api.post("/chats/share-targets/hide", { userId }).then((r) => r.data),
};

// ─── Admin ───────────────────────────────────────────────────────────────────
// Every call is staff-gated server-side. Reads bypass the 60s GET cache: a
// moderation queue showing minute-old data is worse than an extra request.
const adminGet = (url, params) =>
  api.get(url, { params, skipRequestCacheInterceptor: true }).then((r) => r.data);

export const adminAPI = {
  session: () => adminGet("/admin/session"),

  overview: (days) => adminGet("/admin/metrics/overview", { days }),
  growth: (days) => adminGet("/admin/metrics/growth", { days }),
  engagement: (days) => adminGet("/admin/metrics/engagement", { days }),
  moderationMetrics: (days) => adminGet("/admin/metrics/moderation", { days }),
  retention: (weeks) => adminGet("/admin/metrics/retention", { weeks }),

  listUsers: (params) => adminGet("/admin/users", params),
  getUser: (username) => adminGet(`/admin/users/${username}`),
  suspendUser: (username, body) =>
    api.post(`/admin/users/${username}/suspend`, body).then((r) => r.data),
  unsuspendUser: (username) =>
    api.post(`/admin/users/${username}/unsuspend`).then((r) => r.data),
  setVerification: (username, badge) =>
    api.post(`/admin/users/${username}/verification`, { badge }).then((r) => r.data),
  setRole: (username, role) =>
    api.post(`/admin/users/${username}/role`, { role }).then((r) => r.data),
  forceLogout: (username) =>
    api.post(`/admin/users/${username}/force-logout`).then((r) => r.data),

  listContent: (params) => adminGet("/admin/content", params),
  removeContent: (type, id, reason) =>
    api.delete(`/admin/content/${type}/${id}`, { data: { reason } }).then((r) => r.data),

  listReports: (params) => adminGet("/admin/reports", params),
  getReport: (id) => adminGet(`/admin/reports/${id}`),
  setReportStatus: (id, body) =>
    api.patch(`/admin/reports/${id}/status`, body).then((r) => r.data),

  listPlatformReports: (params) => adminGet("/admin/platform-reports", params),
  setPlatformReportStatus: (id, status) =>
    api.patch(`/admin/platform-reports/${id}/status`, { status }).then((r) => r.data),

  getSettings: () => adminGet("/admin/settings"),
  updateSettings: (body) => api.patch("/admin/settings", body).then((r) => r.data),

  auditLog: (params) => adminGet("/admin/audit", params),
};

// ─── Reports ─────────────────────────────────────────────────────────────────
export const reportAPI = {
  // payload: { targetType, targetId?, username?, category, subcategory?, details?, url? }
  create: (payload) => api.post("/reports", payload).then((r) => r.data),

  // Must bypass the 60s GET cache: a stale {report:null} right after submitting
  // would show the category list again instead of the review status.
  status: (params) =>
    api
      .get("/reports/status", { params, skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  platform: (formData) =>
    api
      .post("/reports/platform", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),
};

// ─── Posts ───────────────────────────────────────────────────────────────────
export const postAPI = {
  getFeed: (params, { bypassCache = false } = {}) =>
    cachedGet("/posts/feed", { params }, { bypassCache }),

  getPost: (postId) => cachedGet(`/posts/post/${postId}`),

  getUserPosts: (username, params) =>
    cachedGet(`/posts/${username}`, { params }),

  createPost: (formData) =>
    api
      .post("/posts/create", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),

  deletePost: (id) =>
    api.delete(`/posts/${id}`).then((r) => r.data),

  // Text-only edit; media is fixed at creation, so this is a plain JSON body.
  // `isAiGenerated` rides along so the author can drop the AI label while editing.
  editPost: (id, body) => api.patch(`/posts/${id}/edit`, body).then((r) => r.data),

  // Uncached: the history grows with every edit.
  getEditHistory: (id) =>
    api
      .get(`/posts/${id}/edit-history`, { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  notInterested: (id) =>
    api.post(`/posts/${id}/not-interested`).then((r) => r.data),

  undoNotInterested: (id) =>
    api.delete(`/posts/${id}/not-interested`).then((r) => r.data),

  likePost: (id) =>
    api.post(`/posts/${id}/like`).then((r) => r.data),

  repostPost: (id) =>
    api.post(`/posts/${id}/repost`).then((r) => r.data),

  trackView: (id) =>
    api.post(`/posts/${id}/view`).then((r) => r.data),

  trackBulkViews: (postIds) =>
    api.post("/posts/views/bulk", { postIds }).then((r) => r.data),

  toggleHideCount: (id) =>
    api.post(`/posts/${id}/toggle-hide-count`).then((r) => r.data),

  savePost: (postId) =>
    api.post(`/posts/save/${postId}`).then((r) => r.data),

  getSavedPosts: (params, { bypassCache = false } = {}) =>
    cachedGet("/posts/saved-posts", { params }, { bypassCache }),

  getLikedPosts: (params, { bypassCache = false } = {}) =>
    cachedGet("/posts/liked-posts", { params }, { bypassCache }),

  getPostLikes: (postId, params) =>
    cachedGet(`/posts/likes/${postId}`, { params }),

  getPostReposts: (postId, params) =>
    cachedGet(`/posts/reposts/${postId}`, { params }),

  getPostQuotes: (postId, params) =>
    cachedGet(`/posts/quotes/${postId}`, { params }),

  getPostActivity: (postId) => cachedGet(`/posts/activity/${postId}`),

  saveDraft: (formData) =>
    api
      .post("/posts/save-draft", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),

  getDrafts: (params) => cachedGet("/posts/drafts", { params }),

  deleteDraft: (id) =>
    api.delete(`/posts/draft/${id}`).then((r) => r.data),
};

/**
 * Poll voting and place search. `type` is "post" or "comment".
 *
 * Poll reads skip the GET cache: results change as people vote and a stale
 * copy would show a tally that's already moved on.
 */
export const attachmentAPI = {
  vote: (type, id, optionId) =>
    api.post(`/attachments/polls/${type}/${id}/vote`, { optionId }).then((r) => r.data),

  getPoll: (type, id) =>
    api
      .get(`/attachments/polls/${type}/${id}`, { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  // Cached by the interceptor and again on the server — place names are stable
  // and the upstream geocoder is rate limited.
  searchPlaces: (q) => cachedGet("/attachments/places/search", { params: { q } }),

  reverseGeocode: (lat, lng) => cachedGet("/attachments/places/reverse", { params: { lat, lng } }),
};

/**
 * Scheduled posts and replies. Every read here skips the GET cache — the list
 * changes on its own as the publisher works through it, so a 60-second stale
 * copy would show things that have already gone out.
 */
export const scheduleAPI = {
  list: () =>
    api
      .get("/schedule", { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  reschedule: (type, id, scheduledFor) =>
    api.patch(`/schedule/${type}/${id}`, { scheduledFor }).then((r) => r.data),

  publishNow: (type, id) =>
    api.post(`/schedule/${type}/${id}/publish`).then((r) => r.data),

  cancel: (type, id) =>
    api.delete(`/schedule/${type}/${id}`).then((r) => r.data),
};

// ─── Comments ────────────────────────────────────────────────────────────────
export const commentAPI = {
  createComment: (formData) =>
    api
      .post("/reply/comment", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),

  createNestedComment: (formData) =>
    api
      .post("/reply/nested-comment", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),

  getReplies: (postId, params) =>
    cachedGet(`/reply/replies/${postId}`, { params }),

  getCommentReplies: (commentId, params) =>
    cachedGet(`/reply/comments/replies/${commentId}`, { params }),

  getComments: (postId, params) =>
    cachedGet(`/reply/comments/${postId}`, { params }),

  likeComment: (commentId) =>
    api.post(`/reply/${commentId}/like`).then((r) => r.data),

  deleteComment: (commentId) =>
    api.delete(`/reply/${commentId}`).then((r) => r.data),

  editComment: (commentId, body) =>
    api.patch(`/reply/${commentId}/edit`, body).then((r) => r.data),

  getEditHistory: (commentId) =>
    api
      .get(`/reply/${commentId}/edit-history`, {
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

  getComment: (commentId) => cachedGet(`/reply/${commentId}`),

  repostComment: (id) =>
    api.post(`/reply/${id}/repost`).then((r) => r.data),
};

// ─── Notifications ────────────────────────────────────────────────────────────
export const notificationAPI = {
  getNotifications: (params) =>
    cachedGet("/notification/notifications", { params }),

  markAllRead: () =>
    api.put("/notification/mark-all-read").then((r) => r.data),
};

// ─── Groups ──────────────────────────────────────────────────────────────────
export const groupAPI = {
  getUserGroups: () => cachedGet("/groups/user"),
};

// ─── Chat (existing — kept for backwards compat) ─────────────────────────────
export const chatAPI = {
  // Chat list and management
  getConversations: (params) => cachedGet("/chats", { params: params || {} }),
  getPreferences: () => cachedGet("/chats/preferences"),
  updateChatTheme: (theme) =>
    api.patch("/chats/preferences/appearance", { theme }).then((r) => r.data),
  setDisappearingTimer: (chatId, seconds) =>
    api
      .put(`/chats/preferences/disappearing/${encodeURIComponent(chatId)}`, {
        seconds,
      })
      .then((r) => r.data),
  createCategory: (name) =>
    api.post("/chats/preferences/categories", { name }).then((r) => r.data),
  reorderCategories: (orderedCategoryIds) =>
    api
      .put("/chats/preferences/categories/reorder", { orderedCategoryIds })
      .then((r) => r.data),
  deleteCategory: (categoryId) =>
    api.delete(`/chats/preferences/categories/${categoryId}`).then((r) => r.data),
  assignCategory: (chatId, categoryId) =>
    api
      .put(`/chats/preferences/assignments/${chatId}`, { categoryId })
      .then((r) => r.data),
  updateChatState: (chatId, stateKey, nextState, pin) =>
    api
      .put(`/chats/preferences/state/${chatId}`, { stateKey, nextState, pin })
      .then((r) => r.data),
  setChatLockPin: (pin) =>
    api.put("/chats/preferences/lock-pin", { pin }).then((r) => r.data),
  toggleFavoriteChat: (chatId) =>
    api.post(`/chats/preferences/favorites/${chatId}/toggle`).then((r) => r.data),

  /**
   * After a toggleFavoriteChat call, patch the IndexedDB cachedGet entry for
   * /chats/preferences so that hard-refresh within the 60s TTL window still
   * shows the correct isAuthorFavorite state.
   */
  patchCachedPreferencesFavorites: async (favoriteChats) => {
    if (!Array.isArray(favoriteChats)) return;
    const key = buildGetCacheKey("/chats/preferences", undefined);
    const existing = await getCachedRequest(key).catch(() => null);
    if (existing?.data) {
      await setCachedRequest(key, {
        ts: Date.now(),
        data: { ...existing.data, favoriteChats },
      }).catch(() => {});
    }
  },

  getUnreadCount: () => cachedGet("/chats/unread-count"),

  archiveChat: (chatId, archive = true) =>
    api.post(`/chats/${chatId}/archive`, { archive }).then((r) => r.data),

  deleteChat: (username) =>
    api.delete(`/chats/${username}`).then((r) => r.data),

  // Message routes
  getMessages: (username, params) =>
    cachedGet(`/chats/messages/${username}`, { params }),

  getGroupMessages: (groupId, params) =>
    cachedGet(`/chats/groups/${groupId}/messages`, { params }),

  markMessagesAsRead: (messageIds) =>
    api.post("/chats/messages/mark-read", { messageIds }).then((r) => r.data),

  // Search
  searchMessages: (username, query) =>
    cachedGet(`/chats/messages/${username}/search`, { params: { query } }),

  globalSearch: (query) =>
    cachedGet("/chats/search/global", { params: { query } }),

  // Media
  getConversationMedia: (username, params) =>
    cachedGet(`/chats/messages/${username}/media`, { params }),

  sendMessage: () =>
    Promise.reject(new Error("Use socket for sending text messages")),

  unsendMessage: (messageId) =>
    api.delete(`/chats/message/${messageId}/unsend`).then((r) => r.data),

  deleteMessage: (messageId) =>
    api.delete(`/chats/message/${messageId}/delete`).then((r) => r.data),

  editMessage: (messageId, content) =>
    api.put(`/chats/message/${messageId}/edit`, content).then((r) => r.data),

  toggleReaction: (messageId, emoji) =>
    api
      .post(`/chats/message/${messageId}/reaction`, { emoji })
      .then((r) => r.data),

  reactToMessage: (messageId, data) =>
    api
      .post(`/chats/message/${messageId}/reaction`, data)
      .then((r) => r.data),

  forwardMessage: (messageId, data) =>
    api
      .post(`/chats/message/${messageId}/forward`, data)
      .then((r) => r.data),

  pinMessage: (messageId) =>
    api.post(`/chats/message/${messageId}/pin`).then((r) => r.data),

  getPinnedMessages: (conversationId) =>
    cachedGet(`/chats/${conversationId}/pinned`),

  uploadMedia: (formData) =>
    api
      .post("/chats/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),

  uploadVoice: (formData) =>
    api
      .post("/chats/upload/voice", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data),

  createPoll: (pollData) =>
    api.post("/chats/polls", pollData).then((r) => r.data),
};

export default api;
