import React, { useContext, useRef, useState, useEffect } from "react";
import { UserContext } from "../contexts/UserContext";
import { Navigate, useNavigate } from "react-router-dom";
import { Toaster, toast } from "react-hot-toast";
import axios from "axios";
import { Icons } from "../components/icons";
import UsernameField from "../components/UsernameField";
import PublicAccountConfirmModal from "../components/PublicAccountConfirmModal";
import { clampGraphemes, graphemeLength } from "../lib/graphemes";
import { BIO_MAX_LENGTH, NAME_MAX_GRAPHEMES } from "../lib/profileConstants";

const ProfileSetup = () => {
  const { userAuth, setUserAuth } = useContext(UserContext);
  const navigate = useNavigate();
  const [profileData, setProfileData] = useState({
    name: "",
    bio: "",
    link: "",
    isPrivate: false,
    isVerified: false,
    loading: false,
  });
  const [isConfirmPublicOpen, setIsConfirmPublicOpen] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (userAuth) {
      setProfileData((prevState) => ({
        ...prevState,
        name: userAuth.name || "",
        bio: userAuth.bio || "",
        link: userAuth.link || "",
        profilePic: userAuth.profilePic || "",
        isPrivate:
          userAuth.isPrivate !== undefined ? userAuth.isPrivate : false,
      }));
      if (userAuth.profilePic) {
        setImagePreview(userAuth.profilePic);
      }
    }
  }, [userAuth]);

  const handleImageClick = () => {
    fileInputRef.current.click();
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.match(/image\/(jpeg|jpg|png|gif)/i)) {
      toast.error("Please upload a valid image file (JPEG, PNG, GIF)");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image size should be less than 5MB");
      return;
    }

    setImageFile(file);

    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleChange = (e) => {
    const { value } = e.target;
    if (value.length <= BIO_MAX_LENGTH) {
      setProfileData((prev) => ({
        ...prev,
        bio: value,
      }));
      adjustHeight();
    }
  };

  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 72)}px`;
    }
  };

  useEffect(() => {
    adjustHeight();
  }, [profileData.bio]);

  const handleLinkChange = (e) => {
    setProfileData((prev) => ({
      ...prev,
      link: e.target.value,
    }));
  };

  const handleContinue = async () => {
    const { name, bio, link, isPrivate } = profileData;

    setProfileData((prev) => ({ ...prev, loading: true }));

    try {
      const formData = new FormData();
      formData.append("name", name.trim());
      formData.append("bio", bio.trim());
      formData.append("link", link.trim());
      formData.append("isPrivate", isPrivate);

      if (imageFile) {
        formData.append("profilePic", imageFile);
      }

      const response = await axios.post(
        `${import.meta.env.VITE_SERVER}/user/profile-setup`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${userAuth.token}`,
            "Content-Type": "multipart/form-data",
          },
        }
      );

      if (response.status === 200) {
        const timestamp = new Date().getTime();
        const updatedProfilePic = response.data.profilePic
          ? `${response.data.profilePic}?t=${timestamp}`
          : userAuth.profilePic;

        const updatedUser = {
          ...userAuth,
          /*
           * `??` rather than `||`: the server echoes what it stored, and with
           * `||` clearing your name to empty would silently keep the old one.
           */
          name: response.data.name ?? name.trim(),
          bio: response.data.bio ?? bio.trim(),
          link: response.data.link ?? link.trim(),
          isPrivate: isPrivate,
          profilePic: updatedProfilePic,
          version: (userAuth.version || 0) + 1,
        };

        setUserAuth(updatedUser);

        toast.success(response.data.message || "Profile updated successfully!");

        setTimeout(() => {
          navigate(`/${userAuth.username}`);
        }, 1500);
      }
    } catch (error) {
      const errorMessage =
        error.response?.data?.error || "Failed to update profile";
      toast.error(errorMessage);
    } finally {
      setProfileData((prev) => ({ ...prev, loading: false }));
    }
  };

  return !userAuth?.token ? (
    <Navigate to="/login" />
  ) : (
    <section className="w-full h-screen flex justify-center items-center bg-neutral-950 relative">
      <Toaster />
      <div className="w-[90%] max-w-[500px] flex flex-col items-center">
        <h1 className="text-white text-3xl font-bold mb-2">Profile</h1>
        <p className="text-neutral-400 text-center mb-8">
          Customize your Gossips profile
        </p>

        <div className="w-full border border-neutral-700 rounded-2xl px-6 py-4 mb-6">
          <div className="relative flex flex-col justify-between mb-4 mt-4">
            <h2 className="text-white text-sm mb-2">Name</h2>
            {/* Was a locked label showing the name and handle. Both are
                editable now — this one freely, since a display name isn't in
                any URL or mention, so changing it breaks no links.

                Any script, any emoji, any of the decorative Unicode alphabets.
                No `maxLength`: it counts UTF-16 units, so it would cut a
                25-emoji name in half and sometimes mid-character. */}
            <input
              className="w-full max-w-[calc(100%-72px)] bg-transparent text-white text-sm outline-none placeholder:text-neutral-600"
              placeholder="Your name"
              value={profileData.name}
              onChange={(e) =>
                setProfileData((prev) => ({
                  ...prev,
                  name: clampGraphemes(e.target.value, NAME_MAX_GRAPHEMES),
                }))
              }
            />
            {/* Only once it's worth watching — a counter on an empty field is
                just clutter. */}
            {graphemeLength(profileData.name) > NAME_MAX_GRAPHEMES - 10 && (
              <div className="text-right text-xs text-neutral-400 mt-1">
                {graphemeLength(profileData.name)}/{NAME_MAX_GRAPHEMES}
              </div>
            )}

            <div
              className="absolute top-1/2 right-0 transform -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full flex items-center justify-center text-white cursor-pointer overflow-hidden group"
              onClick={handleImageClick}
            >
              <img
                key={imagePreview || profileData.profilePic}
                src={imagePreview || profileData.profilePic}
                className="w-full h-full object-cover rounded-full group-hover:opacity-70 transition-opacity"
                alt="Profile"
              />
              <div className="absolute inset-0 bg-black bg-opacity-40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <i className="fi fi-rr-camera text-white"></i>
              </div>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleImageChange}
              />
            </div>
          </div>

          {/* Saves on its own, not with the button below — see UsernameField. */}
          <UsernameField />

          <div className="mb-0">
            <h2 className="text-white text-sm font-medium mb-2">Bio</h2>
            <div className="flex flex-row gap-2">
              <i className="fi fi-br-plus text-neutral-700 text-xs mt-3"></i>
              <textarea
                className="w-full rounded-xl p-2 text-white text-sm bg-transparent resize-none outline-none overflow-hidden"
                ref={textareaRef}
                placeholder="Write bio"
                maxLength={BIO_MAX_LENGTH}
                rows={1}
                value={profileData.bio}
                onChange={handleChange}
                style={{ minHeight: "24px", maxHeight: "72px" }}
              />
            </div>
            <div className="text-right text-xs text-neutral-400 mt-1">
              {profileData.bio.length}/{BIO_MAX_LENGTH}
            </div>
          </div>

          <div className="mb-5">
            <h2 className="text-white text-sm font-medium mb-3">Link</h2>
            <div className="flex flex-row gap-4">
              <i className="fi fi-br-plus text-neutral-700 text-xs mt-1"></i>
              <input
                className="w-full text-white text-sm bg-transparent resize-none outline-none overflow-hidden"
                placeholder="Add link (e.g., https://example.com)"
                value={profileData.link}
                onChange={handleLinkChange}
              />
            </div>
          </div>

          <div className="mb-4">
            <div className="relative flex flex-col justify-between mb-4 mt-4">
              <h2 className="text-white text-sm font-medium mb-3">
                Private profile
              </h2>

              {!profileData.isPrivate ? (
                <p className="text-neutral-400 text-sm max-w-[85%]">
                  If you switch to private, only followers can see your posts.
                  Your replies will be visible to followers and individual
                  profiles you reply to.
                </p>
              ) : (
                <p className="text-neutral-400 text-sm max-w-[85%]">
                  If you switch to public, anyone can see your posts and
                  replies.
                </p>
              )}

              <label className="inline-flex items-center cursor-pointer absolute top-1/2 right-0 transform -translate-y-1/2">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={profileData.isPrivate}
                  onChange={() => {
                    if (profileData.isPrivate) {
                      // Switching from private -> public requires confirmation
                      setIsConfirmPublicOpen(true);
                    } else {
                      setProfileData((prev) => ({ ...prev, isPrivate: true }));
                    }
                  }}
                />
                <div
                  className={`relative w-11 h-6 bg-neutral-800 rounded-full transition-colors
              ${profileData.isPrivate ? "peer-checked:bg-white" : "peer-checked:bg-neutral-800"}`}
                >
                  <div
                    className={`absolute top-[2px] start-[2px] h-5 w-5 rounded-full transition-all
              ${profileData.isPrivate ? "translate-x-full bg-black" : "bg-white"}`}
                  ></div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="w-full flex items-center gap-3">
          <button
            className="w-full rounded-xl p-3 font-medium flex items-center justify-center text-white bg-neutral-800 cursor-pointer hover:bg-neutral-700"
            onClick={() => navigate(`/${userAuth.username}`)}
            disabled={profileData.loading}
          >
            Cancel
          </button>

          <button
            className="w-full rounded-xl p-3 font-medium flex items-center justify-center text-black bg-white cursor-pointer hover:bg-neutral-100"
            onClick={handleContinue}
            disabled={profileData.loading}
          >
            {profileData.loading ? (
              <Icons.spinner className="w-4 h-4 animate-spin" />
            ) : (
              "Update"
            )}
          </button>
        </div>
      </div>

      <PublicAccountConfirmModal
        isOpen={isConfirmPublicOpen}
        onClose={() => setIsConfirmPublicOpen(false)}
        onConfirm={() => {
          setProfileData((prev) => ({ ...prev, isPrivate: false }));
          setIsConfirmPublicOpen(false);
        }}
      />
    </section>
  );
};

export default ProfileSetup;
