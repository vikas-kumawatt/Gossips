import "../config/config.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import { DEFAULT_AVATAR_URL } from "../utils/constants.js";

/**
 * Repoint accounts still carrying the old hotlinked default avatar.
 *
 * `utils/constants.js` used to define the placeholder avatar as a URL on
 * cdn.vectorstock.com. Every account created through Google sign-in or OTP
 * signup without a picture had that URL written into `profilePic`, so changing
 * the constant fixes new accounts and does nothing for the ones already stored —
 * they keep pointing at a third-party CDN, and the client's CSP now blocks it,
 * which is how this was noticed.
 *
 * Dry by default, like the other scripts here: without `--apply` it reports the
 * count and changes nothing.
 *
 *   npm run avatars:fix          # report
 *   npm run avatars:fix:apply    # update
 *
 * Safe to run more than once — the second run matches nothing.
 */

const LEGACY_AVATAR_PREFIX = "https://cdn.vectorstock.com/";

const main = async () => {
  const apply = process.argv.includes("--apply");

  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Run this from server/ with a .env in place.");
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    /*
     * Matched on the host prefix rather than the exact URL. The old constant was
     * one specific image, but anything on that CDN is the same mistake and the
     * same CSP violation, and an exact match would quietly skip a variant.
     */
    const filter = { profilePic: { $regex: `^${LEGACY_AVATAR_PREFIX}` } };

    const affected = await User.countDocuments(filter);
    console.log(`${affected} account(s) still point at the old CDN avatar.`);

    if (affected === 0) return;

    if (!apply) {
      const sample = await User.find(filter).select("username").limit(10).lean();
      console.log("Sample:", sample.map((user) => user.username).join(", "));
      console.log(`\nDry run. Re-run with --apply to set them to "${DEFAULT_AVATAR_URL}".`);
      return;
    }

    const result = await User.updateMany(filter, {
      $set: { profilePic: DEFAULT_AVATAR_URL },
    });
    console.log(`Updated ${result.modifiedCount} account(s) to "${DEFAULT_AVATAR_URL}".`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
