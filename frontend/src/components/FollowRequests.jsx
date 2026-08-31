import { useState, useEffect, useContext } from "react";
import { toast } from "react-hot-toast";
import { UserContext } from "../contexts/UserContext";
import NoDataMessage from "./NoDataMessage";
import Avatar from "./Avatar";
import { Icons } from "./icons";
import { userAPI } from "../services/api";

const FollowRequests = () => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isBulkAccepting, setIsBulkAccepting] = useState(false);
  const [actionLoadingIds, setActionLoadingIds] = useState(new Set());
  const [error, setError] = useState(null);
  const { userAuth } = useContext(UserContext);

  const fetchRequests = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await userAPI.getFollowRequests();
      setRequests(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Error fetching follow requests:", err);
      if (err.response?.status === 401) {
        setError("Authentication error. Please log in again.");
      } else {
        setError("Failed to load follow requests. Please try again later.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async (requestId) => {
    if (actionLoadingIds.has(requestId)) return;
    setActionLoadingIds((prev) => new Set(prev).add(requestId));
    try {
      await userAPI.acceptFollowRequest(requestId);
      setRequests((prev) => prev.filter((req) => req._id !== requestId));
      toast.success("Follow request accepted");
    } catch (err) {
      console.error("Error accepting request:", err);
      toast.error(err?.response?.data?.message || "Failed to accept follow request.");
    } finally {
      setActionLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  const handleReject = async (requestId) => {
    if (actionLoadingIds.has(requestId)) return;
    setActionLoadingIds((prev) => new Set(prev).add(requestId));
    try {
      await userAPI.rejectFollowRequest(requestId);
      setRequests((prev) => prev.filter((req) => req._id !== requestId));
      toast.success("Follow request removed");
    } catch (err) {
      console.error("Error rejecting request:", err);
      toast.error(err?.response?.data?.message || "Failed to reject follow request.");
    } finally {
      setActionLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  const handleAcceptAll = async () => {
    if (isBulkAccepting || requests.length === 0) return;
    setIsBulkAccepting(true);
    try {
      const result = await userAPI.acceptAllFollowRequests();
      setRequests([]);
      toast.success(result.message || "All follow requests accepted");
    } catch (err) {
      console.error("Error accepting all requests:", err);
      toast.error(err?.response?.data?.error || "Failed to accept all follow requests.");
    } finally {
      setIsBulkAccepting(false);
    }
  };

  useEffect(() => {
    if (userAuth?.token) {
      fetchRequests();
    } else {
      setError("You must be logged in to view follow requests");
      setLoading(false);
    }
  }, [userAuth?.token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-4 mt-6 text-gray-600">
        <Icons.spinner className="animate-spin mx-auto text-neutral-400" />
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-red-400 bg-red-950/40 border border-red-900/50 rounded-xl my-4">{error}</div>;
  }

  return (
    <div className="w-full max-w-2xl mx-auto rounded-xl p-4 mt-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-xl font-bold text-white">Follow Requests</h3>
          <p className="text-xs text-neutral-400">Manage people who want to follow your private account</p>
        </div>
        {requests.length > 1 && (
          <button
            type="button"
            onClick={handleAcceptAll}
            disabled={isBulkAccepting}
            className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isBulkAccepting ? "Accepting..." : `Accept All (${requests.length})`}
          </button>
        )}
      </div>

      {requests.length === 0 ? (
        <div className="text-neutral-500 text-center py-10">
          <NoDataMessage message="No pending follow requests" />
        </div>
      ) : (
        <ul className="space-y-3">
          {requests.map((request) => {
            const isLoading = actionLoadingIds.has(request._id) || isBulkAccepting;
            return (
              <li
                key={request._id}
                className="flex items-center justify-between p-3.5 bg-[#141414] border border-neutral-800 rounded-xl hover:border-neutral-700 transition-colors"
              >
                <div className="flex items-center space-x-3">
                  <Avatar
                    src={request.from?.profilePic}
                    name={request.from?.name || request.from?.username}
                    size="md"
                  />
                  <div className="flex flex-col">
                    <span className="font-medium text-white text-sm">
                      {request.from?.username}
                    </span>
                    {request.from?.name && (
                      <span className="text-xs text-neutral-400">
                        {request.from.name}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    disabled={isLoading}
                    className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                    onClick={() => handleAccept(request._id)}
                  >
                    Accept
                  </button>
                  <button
                    disabled={isLoading}
                    className="px-3.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                    onClick={() => handleReject(request._id)}
                  >
                    Reject
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default FollowRequests;
