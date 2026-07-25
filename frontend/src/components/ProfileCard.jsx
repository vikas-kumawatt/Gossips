import React, { useContext } from "react";
import FollowButton from "./FollowButton";
import { UserContext } from "../contexts/UserContext";
import { Icons } from "./icons";

const ProfileCard = ({
  name,
  username,
  bio,
  followers,
  following,
  profilePic,
  isPrivate,
  isVerified,
  isModal = false,
  onClose,
}) => {
  const { userAuth } = useContext(UserContext);

  return (
    <>
      {isModal ? (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={onClose}
        >
          <div
            className="bg-[#0f0f0f] p-6 rounded-xl w-[300px] lg:w-[400px] relative border border-neutral-700 flex flex-col items-start"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute top-4 right-4">
              <img
                className="w-16 h-16 rounded-full bg-neutral-800 object-cover border border-neutral-800"
                src={profilePic}
                alt="Profile"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="flex flex-col">
              <h3 className="text-lg font-bold flex items-center">
                {name}{" "}
                <span className="ml-1.5 lg:ml-2 mt-0.5">
                  {isVerified === true && <Icons.verified />}
                </span>
              </h3>
              <p className="">{username}</p>
              <p className="mt-6">{bio}</p>
              <p className="text-neutral-500 mt-2">{followers} followers</p>
            </div>
            {userAuth?.username === username ? null : (
              <div className="mt-6 w-full flex justify-center bg-white rounded-xl font-medium h-10 text-black">
                <FollowButton
                  username={username}
                  currentUserFollowing={following}
                  isPrivate={isPrivate}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="bg-[#0f0f0f] p-6 rounded-xl w-[300px] shadow-xl border border-neutral-700 flex flex-col items-start z-50"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="absolute top-4 right-4">
            <img
              className="w-16 h-16 rounded-full bg-neutral-800 object-cover border border-neutral-800"
              src={profilePic}
              alt="Profile"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="flex flex-col">
            <h3 className="text-lg font-bold flex items-center">
              {name}{" "}
              <span className="ml-1.5 lg:ml-2 mt-0.5">
                {isVerified === true && <Icons.verified />}
              </span>
            </h3>
            <p className="">{username}</p>
            <p className="mt-6">{bio}</p>
            <p className="text-neutral-500 mt-2">{followers} followers</p>
          </div>
          {userAuth?.username === username ? null : (
            <div className="mt-6 w-full flex justify-center bg-white rounded-xl font-medium h-10 text-black">
              <FollowButton
                username={username}
                currentUserFollowing={following}
                isPrivate={isPrivate}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default ProfileCard;