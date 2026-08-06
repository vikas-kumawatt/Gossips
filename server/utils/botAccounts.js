/**
 * The line between a human account and a bot account.
 *
 * A bot is a `User` row with `isBot: true`, no password, no verified email and no session.
 * That makes it structurally similar to two things it must never be confused with: a fresh
 * OAuth signup (also passwordless) and a legacy row from before a field existed.
 *
 * So the separation is enforced as a *query fragment* rather than an `if` after the fetch,
 * following `ACTIVE_ACCOUNT` in utils/chatAccess.js. The reasoning there applies verbatim:
 * "a permission check that exists twice is a permission check that will eventually only be
 * right once". A filter composed into the lookup cannot be forgotten by a path that copies
 * the lookup, and a new credential endpoint that reuses the query inherits the rule for
 * free — which is the opposite of what happens with a check bolted on afterwards.
 */

/*
 * `$ne: true` rather than `false`.
 *
 * Every account created before `isBot` existed has no such field at all, and `{ isBot:
 * false }` matches none of them — so an equality check would lock every existing human out
 * of login. This is the same trap `ACTIVE_ACCOUNT` documents for `accountStatus`, and it is
 * the single most likely way to break this feature's rollout.
 */
export const HUMAN_ACCOUNT = { isBot: { $ne: true } };

/** True for a bot row, tolerant of a lean document or a full one. */
export const isBotAccount = (user) => Boolean(user?.isBot);

/**
 * What a human is told when they aim a credential flow at a bot account.
 *
 * Deliberately the same wording the "no such user" paths use. A distinct message — or a
 * distinct status code — would turn every credential endpoint into an oracle for "is this
 * username a bot", which is information the platform discloses on the profile anyway but
 * should not hand out through an error channel that is otherwise uniform. Uniform failures
 * are what make enumeration useless.
 */
export const BOT_CREDENTIAL_REFUSAL = "Invalid credentials";
