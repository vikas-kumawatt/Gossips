/**
 * Rules about group members that more than one screen needs.
 *
 * The rank logic in particular was inline in GroupInfoPage, and the People page needs
 * exactly the same answers — a permission bit alone is not enough to decide what a
 * menu may offer, and getting it wrong means showing actions the server will refuse
 * with a 403.
 *
 * No React, so it's testable on its own.
 */

export const isCurrentlyMuted = (mutedUntil) =>
  !!mutedUntil && new Date(mutedUntil) > new Date();

/** The `updateGroupMember` body for each role action, so callers don't hand-roll it. */
export const MEMBER_ACTION_PATCH = {
  make_admin: { role: "admin" },
  remove_admin: { role: "member" },
  restrict_in_group: { role: "restricted" },
  unrestrict_in_group: { role: "member" },
  unmute: { mutedUntil: null },
};

/**
 * What the viewer is allowed to do to this member.
 *
 * Rank matters, not just the permission bit. The server refuses everything against a
 * `super_admin` whoever asks, and refuses anything touching an *admin* unless the
 * caller is the owner — and `removeMembers` is true for every admin, so gating on it
 * alone offers menu items that come back 403 whenever one admin acts on another.
 *
 * @param member      A row from `getGroupMembers`.
 * @param permissions The viewer's own `membership.permissions`.
 * @param isSelf      Whether this row is the viewer.
 */
export const memberCapabilities = (member, permissions, isSelf) => {
  const role = member?.role;
  const outranked =
    role !== "super_admin" && (role !== "admin" || !!permissions?.manageAdmins);

  const canManageAdmins = !isSelf && !!permissions?.manageAdmins && role !== "super_admin";
  const canModerate = !isSelf && !!permissions?.removeMembers && outranked;

  return {
    outranked,
    canManageAdmins,
    canModerate,
    isAdmin: role === "admin" || role === "super_admin",
    /*
     * Account-level actions — restrict, block, report — are available to anyone about
     * anyone but themselves. They are not group moderation: they are the same actions
     * the DM header offers, and being an admin has nothing to do with them.
     */
    canActPersonally: !isSelf,
  };
};

/**
 * Split members into the three buckets the People page shows.
 *
 * "You" first because it is the row people look for to leave or check their own role,
 * then accounts you follow — the ones whose names you actually recognise — then
 * everyone else. Order within a bucket is whatever the server sent, which is newest
 * member first.
 */
export const sectionMembers = (members, viewerId) => {
  const viewer = String(viewerId || "");
  const you = [];
  const following = [];
  const others = [];

  (members || []).forEach((member) => {
    const id = String(member?.user?._id || "");
    if (!id) return;
    if (id === viewer) you.push(member);
    else if (member.isFollowing) following.push(member);
    else others.push(member);
  });

  return [
    { key: "you", label: "You", members: you },
    { key: "following", label: "Following", members: following },
    { key: "others", label: "Others", members: others },
    // Empty buckets are dropped here rather than in the renderer, so the page never
    // draws a heading with nothing under it.
  ].filter((section) => section.members.length > 0);
};

/**
 * The "Ana, Ben and 4 others" line for the group info row.
 *
 * Two names, because that is what fits on one line on a phone without truncating both
 * of them. Prefers people the viewer follows: of a hundred members, the two worth
 * naming are the two they might recognise.
 */
export const describeMembers = (members, viewerId, total) => {
  const viewer = String(viewerId || "");
  const others = (members || []).filter(
    (member) => String(member?.user?._id || "") !== viewer
  );
  const ranked = [
    ...others.filter((member) => member.isFollowing),
    ...others.filter((member) => !member.isFollowing),
  ];

  const named = ranked.slice(0, 2).map((member) => member.user?.username).filter(Boolean);
  if (!named.length) return total > 0 ? `${total} member${total === 1 ? "" : "s"}` : "";

  // `total` counts everyone including the viewer, so the remainder is measured against
  // the people we didn't name rather than against the list we happened to have loaded.
  const remaining = Math.max(0, (total || ranked.length + 1) - named.length - 1);
  if (remaining === 0) return named.join(", ");
  return `${named.join(", ")} and ${remaining} other${remaining === 1 ? "" : "s"}`;
};
