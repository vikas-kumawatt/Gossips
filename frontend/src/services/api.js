import axios from "axios";
import { attachAuthInterceptors } from "./authSession";
import { getCachedRequest, setCachedRequest } from "../utils/requestCache";
import { unlockHeaders } from "./chatUnlock";

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

  /**
   * Which accounts this device can switch to. The server checks each stored
   * session, so an entry missing from this list is one whose session is gone.
   */
  /*
   * `_retry: true` opts these three out of the 401 interceptor. A 401 here is
   * the answer — "that account's session is gone" — not an expired access
   * token, and letting the interceptor treat it as one would rotate the
   * *current* account's session and silently replay the request.
   */
  listAccounts: () =>
    api
      .get("/auth/accounts", { skipRequestCacheInterceptor: true, _retry: true })
      .then((r) => r.data),

  switchAccount: (accountId) =>
    api.post("/auth/switch", { accountId }, { _retry: true }).then((r) => r.data),

  // `accountId` signs out one account and leaves the others alone; omitting it
  // signs out whoever is active.
  logout: (accountId) =>
    api
      .post("/auth/logout", accountId ? { accountId } : {}, { _retry: true })
      .then((r) => r.data),
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

  /**
   * @param options `{ bypassCache: true }` where the caller can change the state in
   *   the payload — `relationship.youRestricted` and `youBlocked` are both editable
   *   from the conversation page, and a 60-second-old copy would show a restriction
   *   the user has just removed as still in place.
   */
  getProfile: (username, options) => cachedGet(`/user/${username}`, {}, options),

  // Uncached on purpose. It's opened rarely, and the whole point of the panel
  // is spotting an account that just renamed itself — a stale change count
  // would be the one number worth getting right.
  getProfileAbout: (username) =>
    api
      .get(`/user/${username}/about`, { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  getUsernameStatus: () =>
    api
      .get("/user/username-status", { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  /**
   * Advisory: the answer can be stale by the time you submit, so the change
   * itself re-checks. `signal` lets the form drop a reply that a later
   * keystroke has already made irrelevant.
   */
  checkUsername: (username, signal) =>
    api
      .get("/user/username-availability", {
        params: { username },
        signal,
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

  changeUsername: (username) =>
    api.patch("/user/username", { username }).then((r) => r.data),

  getPrivacySettings: () =>
    api
      .get("/user/privacy-settings", { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  updatePrivacySettings: (updates) =>
    api.patch("/user/privacy-settings", updates).then((r) => r.data),

  // Uncached: rows carry the viewer's live follow state, and a 60-second
  // stale copy shows "Follow" on someone you just followed.
  getFollowers: (username, params) =>
    api
      .get(`/user/${username}/followers`, { params, skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  getFollowingUsers: (username, params) =>
    api
      .get(`/user/${username}/following`, { params, skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  // Owner-only: take someone off your followers list.
  removeFollower: (username) =>
    api.delete(`/user/followers/${username}`).then((r) => r.data),

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

  unrestrict: (username) =>
    api.post(`/user/unrestrict/${username}`).then((r) => r.data),

  block: (username) =>
    api.post(`/user/block/${username}`).then((r) => r.data),

  unblock: (username) =>
    api.post(`/user/unblock/${username}`).then((r) => r.data),

  /**
   * The blocked list, uncached.
   *
   * This went through the global GET cache interceptor, so it was served from
   * IndexedDB for 60 seconds and nothing invalidated it after a block or an unblock.
   * BlockContext hydrates from this on mount — so blocking someone and reloading
   * inside that minute rehydrated the *pre-block* list, and every Block/Unblock
   * label in the app silently reverted. That is the whole of the "block state is not
   * persistent" bug. It is a small list read once per session; there is nothing to
   * gain by caching it and a correctness bug to lose.
   */
  getBlocked: () =>
    api
      .get(`/user/blocked`, { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  /*
   * Push registration (CF30b).
   *
   * The session is resolved server-side from the `X-Device-Id` header that
   * `attachAuthInterceptors` already sends — deliberately not from a session id in
   * the body, which would let a caller point somebody else's session at their own
   * device and receive that account's notifications.
   */
  setPushToken: (token, platform = "web") =>
    api.put("/user/push-token", { token, platform }).then((r) => r.data),

  clearPushToken: () => api.delete("/user/push-token").then((r) => r.data),

  /**
   * People search, uncached — the query changes on every keystroke, so a cache
   * entry is never reused and only costs a write.
   */
  searchUsers: (q) =>
    api
      .get("/user/search", { params: { q }, skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  mute: (username) =>
    api.post(`/user/mute/${username}`).then((r) => r.data),

  unmute: (username) =>
    api.post(`/user/unmute/${username}`).then((r) => r.data),

  getMuted: () => api.get(`/user/muted`).then((r) => r.data),
};

// ─── Hashtags ────────────────────────────────────────────────────────────────
export const hashtagAPI = {
  /**
   * `params.sort` is "top" | "latest" | "oldest". One merged list of posts and
   * replies; "top" pages on an offset, the other two on a keyset cursor.
   */
  getContent: (tag, params) =>
    cachedGet(`/tags/${encodeURIComponent(tag)}`, { params }),

  /*
   * Under /search, not /tags: every single-segment path there is a legal tag
   * name, so /tags/search would shadow the page for #search.
   */
  search: (params) => cachedGet("/search/hashtags", { params }),

  getTrending: (params) => cachedGet("/search/hashtags/trending", { params }),
};

// ─── Search ──────────────────────────────────────────────────────────────────
/**
 * Every read here skips the GET cache. Results change as people post, the query
 * changes per keystroke, and recent searches change as you search — a 60-second
 * stale copy would show a list that has already moved on.
 */
export const searchAPI = {
  content: (params) =>
    api
      .get("/search/content", { params, skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  history: () =>
    api
      .get("/search/history", { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  // { kind: "query", query } | { kind: "user", username }
  addHistory: (payload) => api.post("/search/history", payload).then((r) => r.data),

  removeHistory: (entryId) =>
    api.delete(`/search/history/${entryId}`).then((r) => r.data),

  clearHistory: () => api.delete("/search/history").then((r) => r.data),
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
  setVerification: (username, verified) =>
    api.post(`/admin/users/${username}/verification`, { verified }).then((r) => r.data),
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
  /**
   * `params.category` picks the tab: all, follow_requests, follows, replies,
   * mentions, quotes, reposts, verified. Filtered by the query rather than in
   * the browser, so each tab paginates on its own.
   */
  getNotifications: (params, { bypassCache = false } = {}) =>
    cachedGet("/notification/notifications", { params }, { bypassCache }),

  /*
   * Never cached. This is the number the badge is drawn from and the whole
   * reason it's fetched is that a stale one is what was wrong before.
   */
  getUnreadCount: () =>
    api
      .get("/notification/unread-count", { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  markAllRead: () =>
    api.put("/notification/mark-all-read").then((r) => r.data),
};

// ─── Groups ──────────────────────────────────────────────────────────────────
export const groupAPI = {
  getUserGroups: () => cachedGet("/groups/user"),

  /*
   * Group management. None of this existed — there was one endpoint on the
   * server and no way to rename a group, add or remove anyone, change a role
   * or leave.
   *
   * Uncached, all of it. A member list that is 60 seconds stale is a list that
   * still shows someone you just removed, which reads as the removal having
   * failed.
   */
  createGroup: (payload) => api.post("/groups", payload).then((r) => r.data),

  getGroup: (groupId) =>
    api
      .get(`/groups/${groupId}`, { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  getMembers: (groupId, params) =>
    api
      .get(`/groups/${groupId}/members`, { params, skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  updateGroup: (groupId, updates) =>
    api.patch(`/groups/${groupId}`, updates).then((r) => r.data),

  /**
   * The group photo.
   *
   * Multipart, so no explicit Content-Type — the browser sets it with the boundary, and
   * naming it by hand omits the boundary and the server parses nothing.
   */
  updateAvatar: (groupId, file) => {
    const form = new FormData();
    form.append("avatar", file);
    return api.patch(`/groups/${groupId}/avatar`, form).then((r) => r.data);
  },

  addMembers: (groupId, userIds) =>
    api.post(`/groups/${groupId}/members`, { userIds }).then((r) => r.data),

  updateMember: (groupId, userId, updates) =>
    api.patch(`/groups/${groupId}/members/${userId}`, updates).then((r) => r.data),

  removeMember: (groupId, userId) =>
    api.delete(`/groups/${groupId}/members/${userId}`).then((r) => r.data),

  /*
   * Ban and unban. `GroupMember.isBanned` gates every membership lookup — the
   * member list, the counts, the socket room, every send path — and nothing had
   * ever written it.
   *
   * A ban differs from a removal in one way that matters: a removed member can be
   * added straight back by anyone with `addMembers`, a banned one can't until the
   * ban is lifted. `banned` is stated rather than toggled so a retry can't undo
   * the ban it was retrying.
   */
  setMemberBan: (groupId, userId, banned, reason) =>
    api
      .put(`/groups/${groupId}/members/${userId}/ban`, { banned, reason })
      .then((r) => r.data),

  leaveGroup: (groupId) =>
    api.post(`/groups/${groupId}/leave`).then((r) => r.data),

  /*
   * ── Invite links ──────────────────────────────────────────────────────────
   *
   * Uncached, all three. The token can be rotated by any admin at any moment, and a
   * 60-second cached copy is a link that has already been revoked — which fails for
   * whoever it was sent to with no way to tell why.
   */
  getInvite: (groupId) =>
    api
      .get(`/groups/${groupId}/invite`, { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  rotateInvite: (groupId) =>
    api.post(`/groups/${groupId}/invite/rotate`).then((r) => r.data),

  joinByInvite: (token) =>
    api.post(`/groups/join/${encodeURIComponent(token)}`).then((r) => r.data),
};

// ─── Chat (existing — kept for backwards compat) ─────────────────────────────
export const chatAPI = {
  // Chat list and management
  /*
   * Not cached, and the server says so too: getChats sets
   * `Cache-Control: no-store`, which the IndexedDB layer here doesn't honour.
   * With a 60-second TTL and no invalidation on any mutation, archiving,
   * blocking or deleting a chat re-fetched the same stale list and looked like
   * it had done nothing at all.
   */
  getConversations: (params) =>
    api
      .get("/chats", { params: params || {}, skipRequestCacheInterceptor: true })
      .then((r) => r.data),
  /**
   * @param options `{ bypassCache: true }` to skip the 60-second IndexedDB entry.
   *   Every preference mutation re-reads this to pick up the server's canonical
   *   lists, and a cached response would show the state from before the change.
   *   The conversation page reads the theme from the cached form, which is what the
   *   cache is for.
   */
  getPreferences: (options) => cachedGet("/chats/preferences", {}, options),
  // Omit chatId to move the account-wide default; pass one to override a single
  // conversation. The server treats an absent chatId as "the default", so the
  // old one-argument call still means what it used to.
  updateChatTheme: (theme, chatId) =>
    api
      .patch("/chats/preferences/appearance", chatId ? { theme, chatId } : { theme })
      .then((r) => r.data),
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
  // `currentPin` is required by the server whenever a PIN already exists —
  // omitting it is only valid for the very first one.
  setChatLockPin: (pin, currentPin) =>
    api
      .put("/chats/preferences/lock-pin", { pin, currentPin })
      .then((r) => r.data),

  // The way out of a forgotten PIN. Clears the hash and unlocks every chat it
  // was protecting, so it needs the account password rather than the PIN.
  resetChatLockPin: (password) =>
    api
      .post("/chats/preferences/lock-pin/reset", { password })
      .then((r) => r.data),
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

  /**
   * Same problem, same fix, for the theme: the conversation view reads its
   * theme from the cached /chats/preferences entry, and picking one in the
   * details page and going straight back lands inside the 60s TTL — so the
   * chat would repaint with the old theme until the cache expired.
   *
   * The entry keeps its original timestamp: only the theme is known to be
   * fresh, and bumping `ts` would extend the TTL of everything else in there.
   */
  patchCachedPreferencesTheme: async ({ theme, themeByChat }) => {
    const key = buildGetCacheKey("/chats/preferences", undefined);
    const existing = await getCachedRequest(key).catch(() => null);
    if (existing?.data) {
      await setCachedRequest(key, {
        ts: existing.ts,
        data: {
          ...existing.data,
          ...(theme ? { theme } : {}),
          ...(themeByChat ? { themeByChat } : {}),
        },
      }).catch(() => {});
    }
  },

  // Not cached: read state is the one thing a 60-second stale response makes
  // visibly wrong — the badge is the reason you'd refresh in the first place.
  getUnreadCount: () =>
    api
      .get("/chats/unread-count", { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  archiveChat: (chatId, archive = true) =>
    api.post(`/chats/${chatId}/archive`, { archive }).then((r) => r.data),

  deleteChat: (username) =>
    api.delete(`/chats/${username}`).then((r) => r.data),

  // Message routes.
  //
  // Deliberately uncached. Opening a conversation clears the context's message
  // array, so re-entering one always refetches — and with a 60s TTL that
  // refetch served the stale page. Send a message, go back to the list, open it
  // again: your own message was gone for up to a minute.
  /*
   * `chatId` is passed so the unlock grant can ride along.
   *
   * The chat lock is enforced server-side now: these five reads answer 423 for a
   * locked conversation unless the request carries a grant proving the PIN was
   * entered. The grant is per conversation, so only the caller knows which one to
   * attach — an interceptor couldn't. Callers that never touch a locked chat can
   * omit it and nothing changes.
   */
  getMessages: (username, params, chatId) =>
    api
      .get(`/chats/messages/${username}`, {
        params,
        headers: unlockHeaders(chatId),
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

  getGroupMessages: (groupId, params) =>
    api
      .get(`/chats/groups/${groupId}/messages`, {
        params,
        headers: unlockHeaders(`group_${groupId}`),
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

  markMessagesAsRead: (messageIds) =>
    api.post("/chats/messages/mark-read", { messageIds }).then((r) => r.data),

  /**
   * Prove the PIN for one locked conversation. Returns `{ chatId, grant,
   * expiresAt }`; the caller stores it with `saveUnlockGrant`.
   */
  verifyChatLockPin: (chatId, pin) =>
    api
      .post("/chats/preferences/lock-pin/verify", { chatId, pin })
      .then((r) => r.data),

  /*
   * Search and media are uncached, and the lock is why.
   *
   * `cachedGet` keys on url + params, so a response fetched *with* an unlock
   * grant would be served again later *without* one — the IndexedDB entry
   * outlives the grant, and it survives a reload, which is precisely the case a
   * chat lock exists for. Skipping the cache is also the right call on its own
   * merits here: in-chat search is per-keystroke and the media grid paginates,
   * so a 60-second stale entry was never useful for either.
   */
  searchMessages: (username, query, chatId, params = {}) =>
    api
      .get(`/chats/messages/${username}/search`, {
        params: { query, ...params },
        headers: unlockHeaders(chatId),
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

  globalSearch: (query) =>
    cachedGet("/chats/search/global", { params: { query } }),

  /**
   * ICE servers for a call, fetched per call rather than cached.
   *
   * TURN credentials are short-lived with most providers, and a cached entry would
   * hand a peer connection an expired one — which fails as "the call didn't connect"
   * with nothing to point at. The server also sends `Cache-Control: no-store`, so the
   * interceptor is skipped on both sides of the wire.
   */
  getCallIceServers: () =>
    api
      .get("/chats/call/ice-servers", { skipRequestCacheInterceptor: true })
      .then((r) => r.data),

  // Media
  getConversationMedia: (username, params, chatId) =>
    api
      .get(`/chats/messages/${username}/media`, {
        params,
        headers: unlockHeaders(chatId),
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

  /**
   * Throw away uploads that were never sent.
   *
   * Pass the server's descriptors back verbatim — the signature on each is what
   * authorizes the deletion, so a rebuilt object won't verify. See CF28.
   */
  discardChatMedia: (items) =>
    api.post("/chats/upload/discard", { items }).then((r) => r.data),

  sendMessage: () =>
    Promise.reject(new Error("Use socket for sending text messages")),

  /*
   * Two different actions, easy to confuse, so the names say which is which:
   *
   *   unsendMessage      — for everyone. Sender only, inside the one-hour
   *                        window; leaves a tombstone in the thread.
   *   deleteMessageForMe — hides it from your own copy of the conversation.
   *                        Either participant, no time limit.
   *
   * `deleteMessageForMe` was the name the provider had always called and the
   * name the server controller uses, but the client method here was called
   * `deleteMessage` — so every "Delete for me" threw
   * "chatAPI.deleteMessageForMe is not a function" and the raw TypeError was
   * shown to the user as a toast.
   */
  unsendMessage: (messageId) =>
    api.delete(`/chats/message/${messageId}/unsend`).then((r) => r.data),

  deleteMessageForMe: (messageId) =>
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

  /**
   * Pin or unpin. `pinned` states the target rather than toggling, so a
   * double-click or a retry after a slow response can't cancel itself out —
   * asking for the state it's already in succeeds and changes nothing. Omitting it
   * still toggles, for any caller that hasn't been updated.
   */
  pinMessage: (messageId, pinned) =>
    api
      .post(
        `/chats/message/${messageId}/pin`,
        typeof pinned === "boolean" ? { pinned } : {}
      )
      .then((r) => r.data),

  // Groups have their own route: the server builds a DM or a group
  // conversation key from the route, not from the id, because the same 24-hex
  // id can't tell it which one it is.
  // Uncached for the same reason as search and media above: a cache entry
  // fetched with an unlock grant would be served again without one.
  getPinnedMessages: (conversationId, params) =>
    api
      .get(`/chats/${conversationId}/pinned`, {
        params,
        headers: unlockHeaders(`user_${conversationId}`),
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

  getGroupPinnedMessages: (groupId, params) =>
    api
      .get(`/chats/groups/${groupId}/pinned`, {
        params,
        headers: unlockHeaders(`group_${groupId}`),
        skipRequestCacheInterceptor: true,
      })
      .then((r) => r.data),

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
