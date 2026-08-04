import React from "react";

/**
 * A member's role, as a pill.
 *
 * Extracted from GroupInfoPage so the People page shows the same three badges rather
 * than inventing its own — two screens listing the same members with different badges
 * is how you end up unsure whether "Admin" and "Owner" mean different things.
 *
 * `restricted` is a state with real consequences (they can't send anything) and used to
 * be visible only by opening the menu and reading whether it offered "Restrict" or
 * "Un-restrict".
 */
const GroupRoleBadge = ({ role }) => {
  if (role === "restricted") {
    return (
      <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 text-[11px] font-medium shrink-0">
        Restricted
      </span>
    );
  }
  if (role === "super_admin") {
    return (
      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[11px] font-medium shrink-0">
        Owner
      </span>
    );
  }
  if (role === "admin") {
    return (
      <span className="px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400 text-[11px] font-medium shrink-0">
        Admin
      </span>
    );
  }
  return null;
};

export default GroupRoleBadge;
