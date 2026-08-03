import { Schema, model } from "mongoose";

/**
 * GroupMember — one document per (group, user).
 * Replaces the embedded Group.members[] array.
 */
const groupMemberSchema = new Schema(
  {
    group: { type: Schema.Types.ObjectId, ref: "Group", required: true },
    user:  { type: Schema.Types.ObjectId, ref: "User",  required: true },

    role: {
      type: String,
      enum: ["super_admin", "admin", "member", "restricted"],
      default: "member",
    },

    addedBy:  { type: Schema.Types.ObjectId, ref: "User" },
    joinedAt: { type: Date, default: Date.now },

    // State
    mutedUntil: { type: Date, default: null },
    /*
     * isBanned is read on every membership lookup — it is what keeps a banned
     * account out of the member list, the counts, the group's socket room and
     * every send path.
     *
     * The row is kept rather than deleted, which is the whole reason a ban is a
     * different thing from a removal: a removed member can be added back by
     * anyone with `addMembers`, and a banned one can't until the ban is lifted.
     * The three fields below are the audit trail that makes that decision
     * reviewable — who banned them, when, and why.
     */
    isBanned:   { type: Boolean, default: false },
    bannedAt:   { type: Date },
    bannedBy:   { type: Schema.Types.ObjectId, ref: "User" },
    banReason:  { type: String, maxlength: 300 },

    // Per-member permission overrides (omit unless explicitly set; resolve from role otherwise)
    permissionOverrides: {
      sendMessages:    Boolean,
      sendMedia:       Boolean,
      addMembers:      Boolean,
      removeMembers:   Boolean,
      changeGroupInfo: Boolean,
      pinMessages:     Boolean,
      manageAdmins:    Boolean,
    },
  },
  { timestamps: true }
);

/*
 * The field-level index:true on group and user is gone — each was a strict
 * prefix of one of the compounds below, so Mongo could already serve those
 * queries and the extra indexes only cost writes. Same for role, which nothing
 * queries by.
 */

// One row per (group, user)
groupMemberSchema.index({ group: 1, user: 1 }, { unique: true });

// "List members of group X by recency"
groupMemberSchema.index({ group: 1, joinedAt: -1 });

// "What groups is this user in?" (sidebar load)
groupMemberSchema.index({ user: 1, joinedAt: -1 });

/** Compute permissions for a role (no DB call). */
groupMemberSchema.statics.getDefaultPermissions = function (role) {
  const base = {
    sendMessages:    true,
    sendMedia:       true,
    addMembers:      false,
    removeMembers:   false,
    changeGroupInfo: false,
    pinMessages:     false,
    manageAdmins:    false,
  };
  switch (role) {
    case "super_admin":
      return { ...base, addMembers: true, removeMembers: true, changeGroupInfo: true, pinMessages: true, manageAdmins: true };
    case "admin":
      return { ...base, addMembers: true, removeMembers: true, changeGroupInfo: true, pinMessages: true };
    case "restricted":
      return { ...base, sendMessages: false, sendMedia: false };
    default:
      return base;
  }
};

/** Resolve effective permissions for a member, applying overrides. */
groupMemberSchema.methods.getPermissions = function () {
  const defaults = groupMemberSchema.statics.getDefaultPermissions(this.role);
  if (!this.permissionOverrides) return defaults;
  const merged = { ...defaults };
  for (const [key, val] of Object.entries(this.permissionOverrides)) {
    if (typeof val === "boolean") merged[key] = val;
  }
  return merged;
};

export default model("GroupMember", groupMemberSchema);
