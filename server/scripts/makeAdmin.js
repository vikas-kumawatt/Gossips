import "../config/config.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import { isStaffRole } from "../utils/roles.js";

/**
 * Grant or revoke a staff role from the command line.
 *
 * `models/User.js` says the `role` field is "never settable through any public
 * route — only scripts/makeAdmin.js and a super_admin acting through the admin
 * panel can change it". The admin panel half is real (`POST
 * /admin/users/:username/role`, behind `requireSuperAdmin`), but this script did
 * not exist, which left no way to create the *first* super admin: the only route
 * that can grant the role requires someone who already holds it.
 *
 * The documented bootstrap was "edit the database directly". This is that, with
 * the checks a hand-written `updateOne` doesn't have — it refuses bots, refuses
 * accounts that aren't active, prints what it is about to do, and writes an
 * `AuditLog` row so a role change made from a terminal is as traceable as one
 * made from the panel.
 *
 * Usage, from `server/`:
 *
 *   npm run make-admin -- <username>                 # inspect, change nothing
 *   npm run make-admin -- <username> --role=admin
 *   npm run make-admin -- <username> --role=super_admin
 *   npm run make-admin -- <username> --role=user     # revoke
 *
 * Dry by default, deliberately. Every other script in this directory does the
 * same (`--apply` on the purge and index scripts), and the failure mode of a
 * mistyped username here is granting staff access to the wrong account.
 */

const ROLES = ["user", "admin", "super_admin"];

const usage = () => {
  console.log(
    [
      "",
      "Usage: npm run make-admin -- <username> [--role=user|admin|super_admin]",
      "",
      "  Without --role, prints the account's current role and exits.",
      "",
    ].join("\n")
  );
};

const main = async () => {
  const args = process.argv.slice(2);
  const username = args.find((arg) => !arg.startsWith("--"))?.toLowerCase();
  const roleArg = args.find((arg) => arg.startsWith("--role="))?.slice("--role=".length);

  if (!username) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (roleArg && !ROLES.includes(roleArg)) {
    console.error(`Unknown role "${roleArg}". Expected one of: ${ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Run this from server/ with a .env in place.");
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    /*
     * `+role` because the field is projected by default, but being explicit here
     * means this keeps working if it ever gains `select: false` — which is the
     * direction a field like this tends to move.
     */
    const user = await User.findOne({ username }).select("+role");

    if (!user) {
      console.error(`No account with username "${username}".`);
      process.exitCode = 1;
      return;
    }

    /*
     * A bot has no password and no session, so a staff role on one is not a
     * login anybody can use — but it would let its owner's automation act with
     * staff privileges through any path that checks the role rather than the
     * session. Refused outright.
     */
    if (user.isBot) {
      console.error(`"${username}" is a bot account. Staff roles are for people.`);
      process.exitCode = 1;
      return;
    }

    const current = user.role || "user";
    console.log(`${user.username}: role=${current} status=${user.accountStatus}`);

    if (!roleArg) {
      console.log("\nNo --role given, so nothing was changed.");
      return;
    }

    if (current === roleArg) {
      console.log(`\nAlready ${roleArg}. Nothing to do.`);
      return;
    }

    /*
     * `requireAdmin` denies a suspended or deactivated staff account anyway, so
     * granting one a role produces an account that reads as staff in the
     * database and is refused at every route. Better to say so here.
     */
    if (user.accountStatus !== "active" && isStaffRole(roleArg)) {
      console.error(
        `\n"${username}" is ${user.accountStatus}, and the admin middleware refuses` +
          " non-active accounts. Reinstate the account first."
      );
      process.exitCode = 1;
      return;
    }

    user.role = roleArg;
    await user.save();

    /*
     * The same trail the panel writes. `actor` is the account itself because a
     * shell has no signed-in user, and recording that honestly is better than
     * inventing one or skipping the row — "this changed and nobody knows who"
     * is the outcome the audit log exists to prevent.
     */
    const { default: AuditLog } = await import("../models/AuditLog.js");
    await AuditLog.create({
      actor: user._id,
      actorUsername: user.username,
      actorRole: current,
      // From AUDIT_ACTIONS in models/AuditLog.js — the field is an enum, so a
      // near-miss like "user.role" fails validation rather than being stored.
      action: "user.role_change",
      targetType: "user",
      targetId: user._id,
      targetLabel: user.username,
      details: { from: current, to: roleArg, via: "scripts/makeAdmin.js" },
    });

    console.log(`\nDone. ${user.username}: ${current} -> ${roleArg}`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
