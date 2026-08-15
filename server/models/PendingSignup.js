import { Schema, model } from "mongoose";

/**
 * PendingSignup — a signup that has been submitted but not yet proved.
 *
 * ── Why this is not a `User` row ────────────────────────────────────────────
 *
 * The obvious design is to create the account at signup with `isEmailVerified:
 * false` and let a TTL reap it. That was the first attempt here, and it is
 * quietly unsafe: an unverified `User` row is an account that *exists*, keyed on
 * an address nobody has proved they own, and every path that touches it has to
 * get the distinction right forever.
 *
 * Concretely, it hands out a pre-hijack. Somebody signs up as victim@example.com
 * and never verifies. The real owner signs up later, is told either "user already
 * exists" or — worse, if repeat signups are allowed to refresh the pending row —
 * has their password silently written onto the squatted account. They then get a
 * code, enter it in good faith, and finish creating an account whose password the
 * attacker chose. The victim sees nothing unusual: they asked for a code, a code
 * arrived, it worked.
 *
 * Keeping the credentials here instead removes the class of bug rather than one
 * instance of it. Until the code is entered there is no account: nothing to
 * squat, nothing to overwrite, no email or username reserved, no row for the rest
 * of the app to have an opinion about, and no unverified state for `login`,
 * `refresh`, `switch` or the socket handshake to be careful around.
 *
 * ── Several rows per address, on purpose ────────────────────────────────────
 *
 * Not unique on `email`. Two people submitting the same address get two
 * independent rows with two codes and two passwords, and the code someone was
 * sent is the one that creates *their* account with *their* password. Collapsing
 * them into one upserted row reintroduces the hijack above in the case where the
 * attacker submits second: the victim would hold a live code that applies
 * somebody else's credentials.
 *
 * Growth is bounded by `MAX_PENDING_PER_EMAIL` in the auth controller and by the
 * ten-minute TTL below.
 */
const pendingSignupSchema = new Schema(
  {
    // Indexed, not unique — see above. Used to count outstanding attempts for an
    // address and to clear them once the address is claimed.
    email: { type: String, required: true, lowercase: true, trim: true, index: true },

    /*
     * The account this password will be attached to, when one already exists.
     *
     * Null for an ordinary signup, where verification creates the account. Set
     * for the one case where it doesn't: a Google-only account setting its first
     * password. That used to happen inline at signup with no code at all, which
     * meant a single unauthenticated request could put a chosen password on any
     * Google user's account and walk away with a session. It is the same flow as
     * every other signup now, and this field is the only thing that differs.
     */
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },

    name: { type: String, required: true, trim: true, maxlength: 200 },

    /*
     * Already bcrypt-hashed, by the same cost the User model uses.
     *
     * Hashed here rather than on the way out, because this row survives for ten
     * minutes and a dump of it must not be a list of plaintext passwords —
     * people reuse them, so it would be a credential leak for other sites even
     * though no account exists here yet.
     */
    passwordHash: { type: String, required: true },

    /*
     * An HMAC of the code, never the code. See `hashOtp` in the auth controller:
     * a plain digest of a six-digit number is a rainbow table someone has
     * already built.
     */
    codeHash: { type: String, required: true },

    /** Wrong guesses against the current code. Reset by a resend, not by time. */
    attempts: { type: Number, default: 0 },

    /** Codes mailed for this attempt. Never reset. */
    resendCount: { type: Number, default: 0 },

    lastSentAt: { type: Date, default: Date.now },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

/*
 * Mongo deletes the row once its code expires. Expiry is still checked in the
 * handler, because the TTL monitor runs about once a minute and a code must not
 * outlive its stated life by up to sixty seconds. This index is for cleanup, not
 * for correctness.
 */
pendingSignupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model("PendingSignup", pendingSignupSchema);
