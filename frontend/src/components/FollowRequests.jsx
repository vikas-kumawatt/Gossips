import { useState, useEffect, useContext } from 'react';
import { UserContext } from '../contexts/UserContext';
import NoDataMessage from './NoDataMessage';
import { Icons } from './icons';
import { userAPI } from '../services/api';

const FollowRequests = () => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { userAuth } = useContext(UserContext);

  const fetchRequests = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await userAPI.getFollowRequests();
      setRequests(data);
    } catch (err) {
      console.error('Error fetching follow requests:', err);
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
    try {
      await userAPI.acceptFollowRequest(requestId);
      setRequests(requests.filter(req => req._id !== requestId));
    } catch (err) {
      console.error('Error accepting request:', err);
      alert("Failed to accept follow request. Please try again.");
    }
  };

  const handleReject = async (requestId) => {
    try {
      await userAPI.rejectFollowRequest(requestId);
      setRequests(requests.filter(req => req._id !== requestId));
    } catch (err) {
      console.error('Error rejecting request:', err);
      alert("Failed to reject follow request. Please try again.");
    }
  };

  useEffect(() => {
    if (userAuth?.token) {
      fetchRequests();
    } else {
      setError("You must be logged in to view follow requests");
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAuth?.token]);

  if (loading) return <div className="flex items-center justify-center p-4 mt-6 text-gray-600"> <Icons.spinner className="animate-spin mx-auto" /> </div>;
  if (error) return <div className="p-4 text-red-600 bg-red-100 rounded-md">{error}</div>;

  return (
    <div className="w-full max-w-2xl mx-auto rounded-lg shadow-md p-4 mt-4">
      <h3 className="text-xl font-semibold mb-4 ">Follow Requests</h3>
      {requests.length === 0 ? (
        <div className="text-gray-500 text-center py-4">
          <NoDataMessage message="No pending follow requests" />
        </div>
      ) : (
        <ul className="space-y-4">
          {requests.map(request => (
            <li key={request._id} className="flex items-center justify-between p-3 bg-neutral-900 rounded-xl">
              <div className="flex items-center space-x-3">
                <img
                  src={request.from.profilePic || '/default-avatar.png'}
                  alt={`${request.from.username}'s profile`}
                  className="w-10 h-10 rounded-full object-cover"
                />
                <div className="flex flex-col">
                  <span className="font-medium">{request.from.username}</span>
                  {request.from.name && <span className="text-sm text-neutral-500">{request.from.name}</span>}
                </div>
              </div>
              <div className="flex space-x-2">
                <button
                  className="px-3 h-8 bg-blue-600 text-white rounded-md cursor-pointer"
                  onClick={() => handleAccept(request._id)}
                >
                  Accept
                </button>
                <button
                  className="px-3 h-8 bg-gray-300 text-black rounded-md cursor-pointer"
                  onClick={() => handleReject(request._id)}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default FollowRequests;
