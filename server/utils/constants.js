export const DEFAULT_AVATAR_URL =
  "https://cdn.vectorstock.com/i/500p/66/13/default-avatar-profile-icon-social-media-user-vector-49816613.jpg";

// Fields safe to return when listing users publicly
export const USER_PUBLIC_SELECT =
  "username name bio profilePic isVerified isPrivate followers following";

// Fields needed when populating an author reference on a post/comment
export const AUTHOR_SELECT =
  "username name bio profilePic isVerified isPrivate followers";
