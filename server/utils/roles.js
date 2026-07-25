import User from "../models/User.js";

/**
 * `role` was added to User after accounts already existed, and `.lean()` reads
 * don't apply schema defaults — so documents written before the field existed
 * come back with `role: undefined`.
 *
 * That's not just a rendering problem: `target.role !== "user"` is true for
 * undefined, which made every legacy account look like staff and therefore
 * untouchable by an ordinary admin. Always compare through `roleOf`.
 */
export const roleOf = (userOrRole) => {
  if (typeof userOrRole === "string") return userOrRole || "user";
  return userOrRole?.role || "user";
};

export const isStaffRole = (role) => ["admin", "super_admin"].includes(roleOf(role));

/**
 * One-off, idempotent backfill so the field is present on every document.
 * Runs at boot; after the first pass it matches nothing and costs one query.
 */
export const backfillRoles = async () => {
  try {
    const result = await User.updateMany(
      { role: { $exists: false } },
      { $set: { role: "user" } }
    );
    if (result.modifiedCount) {
      console.log(`Backfilled role="user" on ${result.modifiedCount} account(s)`);
    }
  } catch (error) {
    console.error("backfillRoles failed:", error.message);
  }
};
