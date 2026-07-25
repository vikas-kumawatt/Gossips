import Group from "../models/Group.js";

/**
 * Returns true if userId is an active (non-banned) member of the group.
 */
export async function isGroupMember(groupId, userId) {
  const group = await Group.findById(groupId).select("members").lean();
  return (
    group?.members.some(
      (m) => m.user.toString() === userId.toString() && !m.isBanned
    ) ?? false
  );
}

/**
 * Returns the list of group IDs that userId is an active member of.
 */
export async function getUserGroupIds(userId) {
  const groups = await Group.find({
    "members.user": userId,
    isActive: true,
    isDeleted: false,
  })
    .select("_id")
    .lean();
  return groups.map((g) => g._id);
}
