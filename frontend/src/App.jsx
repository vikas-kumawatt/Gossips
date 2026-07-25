import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
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

function App() {
  const [userAuth, setUserAuth] = useState({ token: null, savedPosts: [] });
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);

  useEffect(() => {
    attachAuthInterceptors(axios);
    const userInSession = safeParseUser();
    if (userInSession?.token) setUserAuth(userInSession);

    const syncAuthState = () => {
      const nextUser = safeParseUser();
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
    if (userAuth && userAuth.token) {
      persistUser(userAuth, false);
    } else {
      persistUser(null, false);
    }
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
              <Route
                path="/group/:groupId"
                element={
                  <ProtectedRoute>
                    <GroupChatPage />
                  </ProtectedRoute>
                }
              />
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
