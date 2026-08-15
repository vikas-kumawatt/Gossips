/**
 * How this API verifies its own tokens.
 *
 * `jwt.verify` with no `algorithms` accepts whatever the token's own header
 * claims, which is the algorithm-confusion class of bug: the library decides how
 * to check a signature from a field the attacker controls. Both tokens are
 * signed with `jwt.sign(payload, secret)` and so are HS256, and pinning that is
 * free.
 *
 * One list, because two copies drift — the same argument as config/origins.js.
 * There were five verify sites and naming the algorithm at four of them would be
 * worse than at none, since the unpinned one would read as reviewed.
 */
export const JWT_ALGORITHMS = ["HS256"];

export const JWT_VERIFY_OPTIONS = { algorithms: JWT_ALGORITHMS };

/**
 * Which token may authenticate an ordinary request — an allow-list, not a denylist.
 *
 * The three verify sites (`protect`, `optionalProtect`, the socket handshake) each
 * used to reject `typ === "refresh"` by name. That was correct for exactly as long
 * as "refresh" was the only other kind of token, and email verification adds a
 * second: a `verify` ticket is signed with the same secret, so under a denylist it
 * would have authenticated every protected route in the app — handing a full
 * session to an account that has not yet proved it owns its address. That is the
 * whole feature defeated by an omission at three call sites.
 *
 * So the rule is inverted. A token authenticates only if it says it is an access
 * token, and any future `typ` is refused by default rather than by remembering to
 * add it here.
 *
 * `undefined` is allowed because tokens minted before the `typ` claim existed carry
 * none, and rejecting them would sign those users out. Note what that concedes: a
 * pre-`typ` *refresh* token also has no `typ`, lives seven days, and is therefore
 * accepted here for up to a week after the claim shipped. That is the behaviour the
 * old `typ === "refresh"` denylist had too, so this is not a regression — but it is
 * a hole with an expiry date rather than a safe default, and once seven days have
 * passed since the `typ` claim first deployed this case should simply be removed.
 */
export const isAccessToken = (decoded) =>
  decoded?.typ === undefined || decoded?.typ === "access";
