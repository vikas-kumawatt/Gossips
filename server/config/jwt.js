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
