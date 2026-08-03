import Group from "../models/Group.js";
import GroupMember from "../models/GroupMember.js";

/**
 * `Group.counts`, derived rather than maintained.
 *
 * Every path that changed membership kept the counts fresh its own way and each
 * one was wrong differently:
 *
 *   - The three group-creation paths `$set` `counts.members` from an array length
 *     with no transaction around `insertMany` + the count write, so a partial
 *     insert committed rows and then claimed a number that didn't match them. Two
 *     of the three set `counts.admins`; the share flow never has.
 *   - `addGroupMembers` `$inc`s by however many rows `insertMany` reported, which
 *     is right — unless the failure wasn't E11000, in which case rows committed
 *     with no `$inc` at all and nothing ever recomputed (CF32).
 *   - `leaveGroup` reads the remaining count and then `$inc`s, unguarded, so two
 *     members leaving at once could drive `counts.members` below zero. `min: 0` is
 *     a validator and `updateOne` doesn't run validators (CF31).
 *   - Orphaned rows whose user no longer exists are filtered out of the member
 *     list but were still counted, so the number disagreed with the list (CF34).
 *
 * All of those are the same mistake: a cache updated by arithmetic from several
 * places at once, with no transaction to make the arithmetic safe. Deriving the
 * numbers from the rows makes every one of them impossible — there is nothing to
 * drift from, and a concurrent change just means the later recompute wins with the
 * correct answer either way.
 *
 * The cost is two `countDocuments` per membership change. Both are served by the
 * `{group, joinedAt}` index as a prefix, membership changes are rare next to
 * messages, and groups are capped at 512 members.
 */

/** Admin *and* owner — what every existing decrement in this app treats as staff. */
const STAFF_ROLES = ["admin", "super_admin"];

/**
 * Recount one group's members and admins and store the result.
 *
 * Banned rows are excluded, because every membership query excludes them: a banned
 * member is absent from the list, the rooms and every send path, so counting them
 * would make the badge disagree with what anyone can see.
 *
 * Returns the counts, so callers can answer with them instead of re-reading.
 */
export const recomputeGroupCounts = async (groupId) => {
  const [members, admins] = await Promise.all([
    GroupMember.countDocuments({ group: groupId, isBanned: { $ne: true } }),
    GroupMember.countDocuments({
      group: groupId,
      isBanned: { $ne: true },
      role: { $in: STAFF_ROLES },
    }),
  ]);

  await Group.updateOne(
    { _id: groupId },
    { $set: { "counts.members": members, "counts.admins": admins } }
  );

  return { members, admins };
};
