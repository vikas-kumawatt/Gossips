import React, { useContext, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Icons } from "../components/icons";
import { UserContext } from "../contexts/UserContext";
import { groupAPI } from "../services/api";
import { isValidInviteToken } from "../lib/groupLink";

/**
 * The landing page for an invite link: join, then open the group.
 *
 * Deliberately *not* inside ChatLayout. Someone arriving here is usually not signed in
 * and often doesn't have the app open — rendering the chat shell around a spinner would
 * flash a two-pane layout at them before redirecting.
 *
 * Signed out is the common case, so it redirects to login carrying the destination
 * rather than showing an error. `<Navigate>` with `state.from` is what ProtectedRoute
 * already uses, so the return trip is the path that already works.
 */
const GroupJoinPage = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  const { userAuth } = useContext(UserContext);
  const [error, setError] = useState(null);

  /*
   * StrictMode mounts an effect twice in development, and this one performs a write.
   * The endpoint is idempotent, so a double join is harmless — but it would fire two
   * requests and race two navigations, so it runs once.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (!userAuth?.token || attempted.current) return;
    if (!isValidInviteToken(token)) {
      setError("That invite link isn't valid.");
      return;
    }
    attempted.current = true;

    (async () => {
      try {
        const res = await groupAPI.joinByInvite(token);
        const id = res?.group?._id;
        /*
         * `replace`, so the back button doesn't return to this page and try to join
         * again. The link has done its job the moment the group opens.
         */
        if (id) navigate(`/chat/group/${id}`, { replace: true });
        else navigate("/chat", { replace: true });
      } catch (err) {
        setError(
          err?.response?.data?.error ||
            "This invite link has expired or the group is no longer available."
        );
      }
    })();
  }, [token, userAuth?.token, navigate]);

  if (!userAuth?.token) {
    return <Navigate to="/login" state={{ from: `/join/g/${token}` }} replace />;
  }

  if (error) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center gap-4 px-6 text-center">
        <Icons.lock className="w-10 h-10 text-neutral-500" />
        <p className="text-sm text-neutral-400 max-w-[280px]">{error}</p>
        <button
          type="button"
          onClick={() => navigate("/chat", { replace: true })}
          className="px-4 py-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-sm"
        >
          Go to your chats
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center gap-3">
      <Icons.spinner className="animate-spin w-8 h-8 text-neutral-400" />
      <p className="text-sm text-neutral-500">Joining the group…</p>
    </div>
  );
};

export default GroupJoinPage;
