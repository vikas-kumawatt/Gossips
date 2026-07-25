/**
 * Grant or revoke a staff role.
 *
 *   node scripts/makeAdmin.js <email> [role]
 *
 *   role: super_admin (default) | admin | user   ("user" revokes staff access)
 *
 * This is the only way to create the first super_admin — no API route can
 * grant a role to an account that doesn't already have one. Run it from the
 * server directory with the same .env the app uses.
 */
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";

const VALID_ROLES = ["user", "admin", "super_admin"];

const run = async () => {
  const [, , email, roleArg = "super_admin"] = process.argv;

  if (!email) {
    console.error("Usage: node scripts/makeAdmin.js <email> [user|admin|super_admin]");
    process.exit(1);
  }
  if (!VALID_ROLES.includes(roleArg)) {
    console.error(`Invalid role "${roleArg}". Expected one of: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) {
    console.error("No Mongo connection string found (MONGO_URI / MONGODB_URI / DB_URI).");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const user = await User.findOne({ email: email.toLowerCase().trim() }).select(
    "_id email username role accountStatus"
  );

  if (!user) {
    console.error(`No account found for ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const previous = user.role;
  if (previous === roleArg) {
    console.log(`@${user.username} is already "${roleArg}" — nothing to do.`);
    await mongoose.disconnect();
    return;
  }

  user.role = roleArg;
  await user.save();

  console.log(`@${user.username} (${user.email}): ${previous} → ${roleArg}`);
  if (user.accountStatus !== "active") {
    console.warn(
      `Warning: this account is "${user.accountStatus}", so it still can't sign in.`
    );
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("makeAdmin failed:", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
