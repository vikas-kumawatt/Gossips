import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import axios from "axios";
import { UserContext } from "./contexts/UserContext";
import UserAuthForm from "./pages/UserAuthForm";
import Home from "./pages/Home";
import ProfileSetup from "./pages/ProfileSetup";
import ProtectedRoute from "./common/ProtectedRoute";
import ProfilePage from "./pages/ProfilePage";
import NotFoundPage from "./pages/NotFoundPage";
import SearchPage from "./pages/SearchPage";
import ActivityPage from "./pages/ActivityPage";
import FollowRequests from "./components/FollowRequests";
import { FollowProvider } from "./contexts/FollowContext.jsx";
import { MuteProvider } from "./contexts/MuteContext.jsx";
import { BlockProvider } from "./contexts/BlockContext.jsx";
import { ReportProvider } from "./contexts/ReportContext.jsx";
import { PostInteractionProvider } from "./contexts/PostInteractionContext.jsx";
import PostPage from "./pages/PostPage.jsx";
import SavedPostsPage from "./pages/SavedPostsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import ResetPassword from "./pages/ResetPassword.jsx";
import LikedPostsPage from "./pages/LikedPostsPage.jsx";
import ChatPage from "./pages/ChatPage.jsx";
import UserConversationPage from "./pages/UserConversationPage.jsx";
import ConversationDetailsPage from "./pages/ConversationDetailsPage.jsx";
import GroupChatPage from "./pages/GroupChatPage.jsx";
import GroupInfoPage from "./pages/GroupInfoPage.jsx";
import ChatLayout from "./pages/ChatLayout.jsx";
import TermsPage from "./pages/TermsPage.jsx";
import PrivacyPage from "./pages/PrivacyPage.jsx";
import CookiesPage from "./pages/CookiesPage.jsx";
import AiLabelsPage from "./pages/AiLabelsPage.jsx";
import ScheduledPostsPage from "./pages/ScheduledPostsPage.jsx";
import AdminLayout from "./pages/admin/AdminLayout.jsx";
import AdminDashboard from "./pages/admin/AdminDashboard.jsx";
import AdminUsers from "./pages/admin/AdminUsers.jsx";
import AdminReports from "./pages/admin/AdminReports.jsx";
import AdminContent from "./pages/admin/AdminContent.jsx";
import AdminAnalytics from "./pages/admin/AdminAnalytics.jsx";
import AdminSettings from "./pages/admin/AdminSettings.jsx";
import AdminAuditLog from "./pages/admin/AdminAuditLog.jsx";

import { SocketProvider } from "./contexts/SocketContext";
import { ChatProvider } from "./contexts/ChatProvider";
import {
  AUTH_EVENT,
  attachAuthInterceptors,
  persistUser,
  safeParseUser,
} from "./services/authSession";
import "./services/api";
import { syncPushRegistration } from "./services/pushNotifications";
import UnreadNotificationsSync from "./components/UnreadNotificationsSync";
import HashtagPage from "./pages/HashtagPage";

/**
 * `/group/:id` moved under `/chat/group/:id` so it inherits ChatLayout.
 *
 * `<Navigate to="/chat/group/:groupId">` would navigate to that literal string
 * — route params aren't interpolated into a `to` prop — so the redirect needs
 * to read the param itself.
 */
function LegacyGroupRedirect() {
  const { groupId } = useParams();
  return <Navigate to={`/chat/group/${groupId}`} replace />;
}

function App() {
  const [userAuth, setUserAuth] = useState({ token: null, savedPosts: [] });
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  // Read by the cross-tab listener below, which is registered once and would
  // otherwise close over the first render's value forever.
  const currentUserIdRef = useRef(null);

  useEffect(() => {
    attachAuthInterceptors(axios);
    const userInSession = safeParseUser();
    if (userInSession?.token) setUserAuth(userInSession);

    const syncAuthState = () => {
      const nextUser = safeParseUser();

      /*
       * localStorage is shared across tabs, so switching account in one tab
       * fires this in all the others. Swapping identity in place there would
       * leave every provider, cache, socket and open composer belonging to the
       * account we just left — a reply typed as A would send as B. The tab
       * that did the switching reloads itself; this reloads the rest.
       */
      const nextId = String(nextUser?.id || nextUser?._id || "");
      const currentId = String(currentUserIdRef.current || "");
      if (nextUser?.token && currentId && nextId && nextId !== currentId) {
        window.location.reload();
        return;
      }

      setUserAuth(nextUser?.token ? nextUser : { token: null, savedPosts: [] });
    };

    window.addEventListener("storage", syncAuthState);
    window.addEventListener(AUTH_EVENT, syncAuthState);

    return () => {
      window.removeEventListener("storage", syncAuthState);
      window.removeEventListener(AUTH_EVENT, syncAuthState);
    };
  }, []);

  useEffect(() => {
    currentUserIdRef.current = userAuth?.id || userAuth?._id || null;
    if (userAuth && userAuth.token) {
      persistUser(userAuth, false);
    } else {
      persistUser(null, false);
    }
  }, [userAuth]);

  /*
   * Register this device for push, once the app has an authenticated user (CF30b).
   *
   * Here rather than in the login form because there are five ways to arrive
   * authenticated — email, Google, signup, an account switch, and a reload with a
   * stored token — and the registration belongs to all of them. Keyed on the id
   * rather than the token so a token refresh doesn't re-register.
   *
   * `syncPushRegistration` never prompts and never throws: it does nothing at all
   * unless the Firebase env vars are set *and* the user has already granted
   * permission, so on an unconfigured deployment this is one function call that
   * returns immediately. A prompt on login is the pattern browsers penalise and users
   * dismiss permanently, so asking is a separate, user-initiated action.
   */
  const pushUserRef = useRef(null);
  useEffect(() => {
    const id = userAuth?.id || userAuth?._id || null;
    if (!userAuth?.token || !id) return;
    if (pushUserRef.current === id) return;
    pushUserRef.current = id;
    syncPushRegistration();
  }, [userAuth]);

  return (
    <UserContext.Provider
      value={{
        userAuth,
        setUserAuth,
        unreadNotificationCount,
        setUnreadNotificationCount,
      }}
    >
      <SocketProvider>
        {/* Renders nothing; owns the unread count in one place. */}
        <UnreadNotificationsSync />
        <ChatProvider>
          <PostInteractionProvider>
            <FollowProvider>
            <MuteProvider>
            <BlockProvider>
            <ReportProvider>
            <Routes>
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    {" "}
                    <Home />{" "}
                  </ProtectedRoute>
                }
              />
              <Route path="signup" element={<UserAuthForm type="signup" />} />
              <Route path="login" element={<UserAuthForm type="login" />} />
              {/* Before the ":profileId" catch-all, and "tag" is on the
                  reserved-username list so it can never be a real profile. */}
              <Route
                path="/tag/:tag"
                element={
                  <ProtectedRoute>
                    <HashtagPage />
                  </ProtectedRoute>
                }
              />
              <Route path=":profileId" element={<ProfilePage />} />
              <Route
                path="/:username/post/:Postid"
                element={
                  <ProtectedRoute>
                    {" "}
                    <PostPage />{" "}
                  </ProtectedRoute>
                }
              />
              <Route
                path="/search"
                element={
                  <ProtectedRoute>
                    <SearchPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/activity"
                element={
                  <ProtectedRoute>
                    <ActivityPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/followrequests"
                element={
                  <ProtectedRoute>
                    <FollowRequests />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/profile-setup"
                element={
                  <ProtectedRoute>
                    {" "}
                    <ProfileSetup />{" "}
                  </ProtectedRoute>
                }
              />
              <Route
                path="/saved"
                element={
                  <ProtectedRoute>
                    <SavedPostsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/liked"
                element={
                  <ProtectedRoute>
                    <LikedPostsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/scheduled"
                element={
                  <ProtectedRoute>
                    <ScheduledPostsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/settings"
                element={
                  <ProtectedRoute>
                    <SettingsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chat"
                element={
                  <ProtectedRoute>
                    <ChatLayout />
                  </ProtectedRoute>
                }
              >
                <Route
                  path=":username/details"
                  element={<ConversationDetailsPage />}
                />
                <Route path=":username" element={<UserConversationPage />} />
              </Route>
              {/*
                Groups live under /chat, inside ChatLayout, like DMs do.

                They used to be a sibling route, so opening a group threw away
                the two-pane layout entirely — and the only control back out was
                `md:hidden`, which meant that on desktop there was no way to
                leave a group chat but the browser's back button.
              */}
              <Route
                path="/chat/group"
                element={
                  <ProtectedRoute>
                    <ChatLayout />
                  </ProtectedRoute>
                }
              >
                <Route path=":groupId/info" element={<GroupInfoPage />} />
                <Route path=":groupId" element={<GroupChatPage />} />
              </Route>
              {/* The old path, kept so existing links and anything already open
                  keep working rather than landing on NotFoundPage. */}
              <Route path="/group/:groupId" element={<LegacyGroupRedirect />} />
              <Route
                path="/reset-password/:token"
                element={<ResetPassword />}
              />
              {/* Staff only. ProtectedRoute just requires a login; AdminLayout
                  then asks the server whether this account is staff, and every
                  /admin endpoint enforces it independently. */}
              <Route
                path="/admin"
                element={
                  <ProtectedRoute>
                    <AdminLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<AdminDashboard />} />
                <Route path="users" element={<AdminUsers />} />
                <Route path="reports" element={<AdminReports />} />
                <Route path="content" element={<AdminContent />} />
                <Route path="analytics" element={<AdminAnalytics />} />
                <Route path="audit" element={<AdminAuditLog />} />
                <Route path="settings" element={<AdminSettings />} />
              </Route>

              <Route path="/terms" element={<TermsPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/cookies" element={<CookiesPage />} />
              <Route path="/ai-labels" element={<AiLabelsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </ReportProvider>
            </BlockProvider>
            </MuteProvider>
            </FollowProvider>
          </PostInteractionProvider>
        </ChatProvider>
      </SocketProvider>
    </UserContext.Provider>
  );
}

export default App;
