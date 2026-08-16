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
 * This used to also accept `decoded.typ === undefined`, so that tokens minted
 * before the claim existed kept working rather than signing those users out. The
 * comment recorded what that conceded — a pre-`typ` *refresh* token also carries
 * no `typ`, lives seven days, and was therefore accepted as an access token for
 * up to a week — and said the case should be removed once seven days had passed
 * since `typ` first deployed.
 *
 * It has. `typ: "access"` has been minted since the initial commit, and the
 * longest-lived token in the system is the seven-day refresh token, so nothing
 * without the claim can still be inside its validity window. The allowance is
 * removed rather than left to be inherited by whoever reads this next.
 */
export const isAccessToken = (decoded) => decoded?.typ === "access";
