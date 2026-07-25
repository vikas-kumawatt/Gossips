import React, { useState, useContext } from "react";
import { UserContext } from "../contexts/UserContext";
import axios from "axios";
import { Icons } from "../components/icons";

const CreateGroupModal = ({ isOpen, onClose, onGroupCreated }) => {
  const { userAuth } = useContext(UserContext);
  const [step, setStep] = useState(1);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupType, setGroupType] = useState("private");
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const searchUsers = async (query) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      const response = await axios.get(
        `${import.meta.env.VITE_SERVER}/user/search?q=${encodeURIComponent(query)}`,
        {
          headers: { Authorization: `Bearer ${userAuth.token}` },
        }
      );
      setSearchResults(response.data.users || []);
    } catch (error) {
      console.error("Error searching users:", error);
    }
  };

  const handleSearchChange = (e) => {
    const query = e.target.value;
    setSearchQuery(query);
    
    if (query.trim()) {
      searchUsers(query);
    } else {
      setSearchResults([]);
    }
  };

  const toggleUserSelection = (user) => {
    setSelectedUsers(prev =>
      prev.some(u => u._id === user._id)
        ? prev.filter(u => u._id !== user._id)
        : [...prev, user]
    );
  };

  const createGroup = async () => {
    if (!groupName.trim()) {
      setError("Group name is required");
      return;
    }

    if (selectedUsers.length === 0) {
      setError("Please select at least one member");
      return;
    }

    setLoading(true);
    try {
      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}/groups`,
        {
          name: groupName,
          description: groupDescription,
          type: groupType,
          members: selectedUsers.map(user => user._id)
        },
        { headers: { Authorization: `Bearer ${userAuth.token}` } }
      );

      onGroupCreated(response.data.group);
      onClose();
      resetForm();
    } catch (error) {
      console.error("Error creating group:", error);
      setError(error.response?.data?.error || "Failed to create group");
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setStep(1);
    setGroupName("");
    setGroupDescription("");
    setGroupType("private");
    setSelectedUsers([]);
    setSearchQuery("");
    setSearchResults([]);
    setError("");
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl max-w-md w-full max-h-[90vh] overflow-hidden">
        <div className="p-4 border-b border-neutral-800 flex justify-between items-center">
          <h3 className="font-medium text-lg">
            {step === 1 ? "Create New Group" : "Add Members"}
          </h3>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white"
          >
            <Icons.close className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Group Name
                </label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Enter group name"
                  className="w-full bg-neutral-800 text-white placeholder-neutral-400 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  maxLength={100}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Description (Optional)
                </label>
                <textarea
                  value={groupDescription}
                  onChange={(e) => setGroupDescription(e.target.value)}
                  placeholder="Enter group description"
                  className="w-full bg-neutral-800 text-white placeholder-neutral-400 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
                  rows={3}
                  maxLength={500}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Group Type
                </label>
                <select
                  value={groupType}
                  onChange={(e) => setGroupType(e.target.value)}
                  className="w-full bg-neutral-800 text-white rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </div>

              <button
                onClick={() => setStep(2)}
                disabled={!groupName.trim()}
                className="w-full bg-violet-600 text-white py-3 rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Search and Add Members
                </label>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={handleSearchChange}
                  placeholder="Search users..."
                  className="w-full bg-neutral-800 text-white placeholder-neutral-400 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>

              <div className="max-h-48 overflow-y-auto">
                {searchResults.map(user => (
                  <div
                    key={user._id}
                    className="flex items-center gap-3 p-3 hover:bg-neutral-800 rounded-lg cursor-pointer"
                    onClick={() => toggleUserSelection(user)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedUsers.some(u => u._id === user._id)}
                      onChange={() => {}}
                      className="w-4 h-4 text-blue-500 rounded"
                    />
                    <img
                      src={user.profilePic || "/default-avatar.png"}
                      alt={user.username}
                      className="w-10 h-10 rounded-full"
                    />
                    <div>
                      <p className="text-white font-medium">{user.name || user.username}</p>
                      <p className="text-neutral-400 text-sm">@{user.username}</p>
                    </div>
                  </div>
                ))}
              </div>

              {selectedUsers.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-neutral-300 mb-2">
                    Selected Members ({selectedUsers.length})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selectedUsers.map(user => (
                      <div
                        key={user._id}
                        className="flex items-center gap-2 bg-neutral-800 px-3 py-1 rounded-full"
                      >
                        <img
                          src={user.profilePic || "/default-avatar.png"}
                          alt={user.username}
                          className="w-6 h-6 rounded-full"
                        />
                        <span className="text-white text-sm">{user.username}</span>
                        <button
                          onClick={() => toggleUserSelection(user)}
                          className="text-neutral-400 hover:text-white"
                        >
                          <Icons.close className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 bg-neutral-800 text-white py-3 rounded-lg font-medium hover:bg-neutral-700 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={createGroup}
                  disabled={selectedUsers.length === 0 || loading}
                  className="flex-1 bg-violet-600 text-white py-3 rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
                >
                  {loading ? "Creating..." : "Create Group"}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="text-red-400 text-sm mt-3 text-center">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CreateGroupModal;