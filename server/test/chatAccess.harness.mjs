/**
 * Access-control harness for the chat authorization batch.
 *
 * `utils/chatAccess.js` can't be imported directly here — it pulls in mongoose
 * and five models, and mongoose won't load in this environment. So the source
 * is read, its import block is swapped for stubs that record what was asked,
 * and the real function bodies run against them. Same for the two pure helpers
 * that live in `config/socket.js`.
 *
 * Run: node test/chatAccess.harness.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// mediaToken only needs node:crypto, so the real implementation runs here.
process.env.JWT_SECRET = process.env.JWT_SECRET || "harness-secret";
const { signMedia, verifyMedia, stripMediaToken, isAllowedGif } = await import(
  "../utils/mediaToken.js"
);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let passed = 0;
const failures = [];

const ok = (name, condition) => {
  if (condition) passed += 1;
  else failures.push(name);
};
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${name}\n      expected ${e}\n      actual   ${a}`);
};

// ── Stubs ────────────────────────────────────────────────────────────────────

const oid = (n) => String(n).padStart(24, "0");
const A = oid(1); // caller / sender
const B = oid(2); // the other party
const C = oid(3); // an outsider
const G = oid(9); // a group

/** Mongoose query stub: .select().lean() and direct await both resolve. */
const query = (result) => {
  const p = Promise.resolve(result);
  p.select = () => p;
  p.lean = () => p;
  return p;
};

const db = {
  relations: [], // { from, to, kind }
  settings: [], // { user, privacy: { whoCanMessage } }
  follows: [], // { follower, following, status }
  members: [], // { group, user, isBanned, role }
  groups: [], // { _id, isActive, isDeleted }
  messages: [], // message docs
};

const stubs = `
const mongoose = {
  isValidObjectId: (v) => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v),
  Types: { ObjectId: class { constructor(v) { this.v = v; } toString() { return this.v; } } },
  model: () => __db.MessageModel,
};
const Follow = {
  find: (q) => __q(__db.follows.filter((f) => __matchFollow(f, q))),
  isFollowing: async (follower, following) =>
    __db.follows.some(
      (f) =>
        String(f.follower) === String(follower) &&
        String(f.following) === String(following) &&
        f.status === "accepted"
    ),
};
const Group = {
  findById: (id) => __q(__db.groups.find((g) => g._id === String(id)) || null),
  // historyFloors reads several groups at once.
  find: (q) => __q(
    __db.groups.filter((g) => (q?._id?.$in || []).map(String).includes(g._id))
  ),
};
const GroupMember = {
  findOne: (q) => __q(
    __db.members.find(
      (m) => m.group === String(q.group) && m.user === String(q.user) && m.isBanned !== true
    ) || null
  ),
  // Same, for the caller's membership in each of them.
  find: (q) => __q(
    __db.members.filter(
      (m) =>
        (q?.group?.$in || []).map(String).includes(m.group) &&
        String(m.user) === String(q.user) &&
        m.isBanned !== true
    )
  ),
};
const UserRelation = {
  find: (q) => __q(__db.relations.filter((r) => __matchRelation(r, q))),
};
const UserSettings = {
  find: (q) => __q(
    __db.settings.filter((s) => q.user.$in.map(String).includes(String(s.user)))
  ),
};
`;

const helpers = {
  __q: query,
  __db: db,
  __matchRelation(r, q) {
    if (q.kind && r.kind !== q.kind) return false;
    return q.$or.some((clause) => {
      const fromOk = clause.from.$in
        ? clause.from.$in.map(String).includes(r.from)
        : String(clause.from) === r.from;
      const toOk = clause.to.$in
        ? clause.to.$in.map(String).includes(r.to)
        : String(clause.to) === r.to;
      return fromOk && toOk;
    });
  },
  __matchFollow(f, q) {
    if (q.status && f.status !== q.status) return false;
    const followerOk = q.follower?.$in
      ? q.follower.$in.map(String).includes(f.follower)
      : String(q.follower) === f.follower;
    const followingOk = q.following?.$in
      ? q.following.$in.map(String).includes(f.following)
      : String(q.following) === f.following;
    return followerOk && followingOk;
  },
};

let messageQueries = 0;

db.MessageModel = {
  groupConversationKey: (id) => `g:${id}`,
  findById: (id) => query(db.messages.find((m) => String(m._id) === String(id)) || null),
  findOne(filter) {
    messageQueries += 1;
    const since = filter.createdAt?.$gte;
    return query(
      db.messages.find(
        (m) =>
          m.conversation === filter.conversation &&
          String(m.sender) === String(filter.sender) &&
          (!since || new Date(m.createdAt) >= since)
      ) || null
    );
  },
};

/**
 * Strip a module's imports, prepend stubs, and evaluate it.
 *
 * `extra` adds bindings for modules this one needs that the shared stubs above
 * don't cover — `node:crypto`, say, whose import line gets stripped along with
 * everything else and has to be handed back in.
 */
const loadModule = async (relPath, prelude, extra = {}) => {
  const src = fs.readFileSync(path.join(root, relPath), "utf8");
  const body = src
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .join("\n")
    .replace(/^export (const|function|class) /gm, "$1 ");
  const wrapped = `${prelude}\n${body}\nreturn { ${exportsOf(src).join(", ")} };`;
  const scope = { ...helpers, ...extra };
  const fn = new Function(...Object.keys(scope), wrapped);
  return fn(...Object.values(scope));
};

const exportsOf = (src) =>
  [...src.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);

// chatAccess uses a multi-line `import { ... } from` block? It does not — every
// import is single-line — but assert that, so this harness fails loudly rather
// than silently testing a truncated module.
const chatAccessSrc = fs.readFileSync(path.join(root, "utils/chatAccess.js"), "utf8");
ok(
  "harness: chatAccess has no multi-line import block",
  !/^import\s*\{[^}]*$/m.test(chatAccessSrc)
);

const access = await loadModule("utils/chatAccess.js", stubs);

// ── idOf ─────────────────────────────────────────────────────────────────────

eq("idOf: string passes through", access.idOf(A), A);
eq("idOf: populated doc yields its _id", access.idOf({ _id: A, username: "x" }), A);
eq("idOf: ObjectId-like uses toString", access.idOf({ toString: () => A }), A);
eq("idOf: null", access.idOf(null), null);
eq("idOf: undefined", access.idOf(undefined), null);

// ── cleanIds ─────────────────────────────────────────────────────────────────

eq("cleanIds: drops non-ObjectIds", access.cleanIds([A, "nope", 42, null]), [A]);
eq("cleanIds: deduplicates", access.cleanIds([A, A, B]), [A, B]);
eq("cleanIds: excludes self", access.cleanIds([A, B], { exclude: A }), [B]);
eq("cleanIds: exclude accepts a doc", access.cleanIds([A, B], { exclude: { _id: A } }), [B]);
eq("cleanIds: non-array", access.cleanIds("nope"), []);
eq("cleanIds: undefined", access.cleanIds(undefined), []);
ok(
  "cleanIds: rejects a mongo operator object",
  access.cleanIds([{ $gt: null }]).length === 0
);

// ── isMessageParticipant / canSeeMessage ─────────────────────────────────────

const dm = { _id: oid(100), sender: A, receiver: B, isGroupMessage: false, deletedFor: [] };
const groupMsg = { _id: oid(101), sender: B, group: G, isGroupMessage: true, deletedFor: [] };

db.members.push({ group: G, user: A, isBanned: false, role: "member" });
db.members.push({ group: G, user: C, isBanned: true, role: "member" });

ok("participant: DM sender", await access.isMessageParticipant(dm, A));
ok("participant: DM receiver", await access.isMessageParticipant(dm, B));
ok("participant: DM outsider rejected", !(await access.isMessageParticipant(dm, C)));
ok("participant: group member", await access.isMessageParticipant(groupMsg, A));
ok("participant: banned group member rejected", !(await access.isMessageParticipant(groupMsg, C)));
ok("participant: null message", !(await access.isMessageParticipant(null, A)));
ok("participant: null user", !(await access.isMessageParticipant(dm, null)));
ok(
  "participant: populated sender still matches",
  await access.isMessageParticipant({ ...dm, sender: { _id: A } }, A)
);
ok(
  "participant: DM with no receiver, outsider rejected",
  !(await access.isMessageParticipant({ ...dm, receiver: null }, C))
);

ok("canSee: participant can see", await access.canSeeMessage(dm, A));
ok(
  "canSee: deleted-for-me hides it",
  !(await access.canSeeMessage({ ...dm, deletedFor: [A] }, A))
);
ok(
  "canSee: someone else's delete-for-me does not hide it",
  await access.canSeeMessage({ ...dm, deletedFor: [B] }, A)
);
ok("canSee: outsider rejected", !(await access.canSeeMessage(dm, C)));

// ── Group message-history floor (Group.settings.messageHistory) ───────────────
//
// `hidden` means a member reads nothing from before their own joinedAt. These assertions
// exist because the rule is an access control with several bypasses, and because its
// fail-open direction is far worse than its fail-closed one: a wrong `null` here hands a
// group's whole archive to someone it was configured to keep out.

{
  const JOINED = new Date("2026-03-01T00:00:00Z");
  const floor = access.historyFloorFor;

  // The deploy-safety case, and the reason this isn't a plain allowlist. Every group that
  // existed before the field did has no `settings.messageHistory` at all; if absent floored,
  // deploying this would hide every existing group's entire history at once.
  eq("history: absent setting means no floor", floor(undefined, JOINED), null);
  eq("history: null setting means no floor", floor(null, JOINED), null);
  eq("history: visible means no floor", floor("visible", JOINED), null);

  eq(
    "history: hidden floors at joinedAt",
    floor("hidden", JOINED)?.toISOString(),
    JOINED.toISOString()
  );
  eq(
    "history: a joinedAt string is parsed, not passed through",
    floor("hidden", JOINED.toISOString())?.toISOString(),
    JOINED.toISOString()
  );

  /*
   * An unrecognised value floors. `updateGroup` allowlists the enum, so one can only
   * arrive by a direct database write — and "I don't know what this setting means" must
   * not resolve to "show everything".
   */
  for (const bogus of ["public", "VISIBLE", "hidden_from_new", "", 0, true]) {
    ok(
      `history: unrecognised setting ${JSON.stringify(bogus)} fails closed`,
      floor(bogus, JOINED) !== null
    );
  }

  // Hidden with no joinedAt: floor at "now", so nothing that already exists is readable.
  // Failing open here would hand the archive to precisely the row we know least about.
  {
    const noJoin = floor("hidden", undefined);
    ok("history: hidden with no joinedAt floors rather than opening", noJoin instanceof Date);
    ok(
      "history: that floor excludes everything already written",
      noJoin > new Date(Date.now() - 5000)
    );
    ok("history: an invalid joinedAt is not trusted as a date", floor("hidden", "not-a-date") > JOINED);
  }

  eq("history: no floor produces no predicate", JSON.stringify(access.historyFloorFilter(null)), "{}");
  eq(
    "history: a floor produces a $gte bound",
    access.historyFloorFilter(JOINED).createdAt.$gte.toISOString(),
    JOINED.toISOString()
  );
}

/*
 * canSeeMessage, which is the per-message half — it gates forwarding and what a new reply
 * may point at. Both take a message id from the client, so neither is covered by flooring
 * the list queries.
 */
{
  const HG = oid(700); // a group with history hidden
  const JOINED = new Date("2026-03-01T00:00:00Z");
  db.groups.push({ _id: HG, isActive: true, isDeleted: false, settings: { messageHistory: "hidden" } });
  db.members.push({ group: HG, user: A, isBanned: false, role: "member", joinedAt: JOINED });

  const before = {
    _id: oid(701), sender: B, group: HG, isGroupMessage: true, deletedFor: [],
    createdAt: new Date("2026-02-01T00:00:00Z"),
  };
  const after = { ...before, _id: oid(702), createdAt: new Date("2026-04-01T00:00:00Z") };

  ok("canSee: hidden history refuses a pre-join group message", !(await access.canSeeMessage(before, A)));
  ok("canSee: hidden history allows a post-join group message", await access.canSeeMessage(after, A));
  ok(
    "canSee: a message exactly at joinedAt is readable",
    await access.canSeeMessage({ ...before, createdAt: JOINED }, A)
  );

  /*
   * Your own pre-join message is refused too. You cannot send before joining — but leaving
   * deletes the membership row, so rejoining gives a new joinedAt and your own older
   * messages fall below it. One rule, no sender exemption, and this pins that.
   */
  ok(
    "canSee: the floor applies to the caller's own older message",
    !(await access.canSeeMessage({ ...before, sender: A }, A))
  );

  // Deny rather than guess: a caller projecting away createdAt would otherwise skip the
  // check silently.
  ok(
    "canSee: a group message with no createdAt is refused under a floor",
    !(await access.canSeeMessage({ ...before, createdAt: undefined }, A))
  );

  // The group with no setting at all (G, seeded above) is unaffected — the regression that
  // matters most, since every existing group looks like this.
  ok(
    "canSee: a group with no history setting is unrestricted",
    await access.canSeeMessage({ ...groupMsg, createdAt: new Date("2020-01-01T00:00:00Z") }, A)
  );

  // A DM has no group, so it never consults the floor.
  ok(
    "canSee: a DM is unaffected by group history rules",
    await access.canSeeMessage({ ...dm, createdAt: new Date("2020-01-01T00:00:00Z") }, A)
  );

  // A group document that exists with no `messageHistory` — what every group looks like
  // before anyone touches the setting.
  const UNSET = oid(703);
  db.groups.push({ _id: UNSET, isActive: true, isDeleted: false });
  db.members.push({ group: UNSET, user: A, isBanned: false, role: "member", joinedAt: JOINED });

  const floors = await access.historyFloors([HG, UNSET, oid(704)], A);
  eq("history: batch floors the hidden group", floors.get(String(HG))?.toISOString(), JOINED.toISOString());
  eq("history: batch leaves a group with no setting alone", floors.get(String(UNSET)), null);
  /*
   * Every requested id gets an entry, including one that resolves to nothing. It used to
   * key off the query result, so a missing id returned `undefined` — which every call site
   * reads as "no floor". Same outcome as `null` today, but it made the fail-open path an
   * accident of iteration order rather than a decision, and `.has()` could not tell them
   * apart.
   */
  ok("history: batch answers for an id that resolves to nothing", floors.has(String(oid(704))));
  eq("history: and that answer is an explicit no-floor", floors.get(String(oid(704))), null);
}

// ── blockedIdSet ─────────────────────────────────────────────────────────────

db.relations.push({ from: A, to: B, kind: "block" }); // A blocked B
db.relations.push({ from: C, to: A, kind: "block" }); // C blocked A

{
  const set = await access.blockedIdSet(A, [B, C]);
  ok("blocked: outbound block found", set.has(B));
  ok("blocked: inbound block found", set.has(C));
  ok(
    "blocked: caller is not in their own blocked set",
    !set.has(A)
  );
  eq("blocked: size", set.size, 2);
}
{
  const set = await access.blockedIdSet(A, []);
  eq("blocked: empty input short-circuits", set.size, 0);
}

// ── messageableIdSet ─────────────────────────────────────────────────────────

const P_EVERYONE = oid(11);
const P_NONE = oid(12);
const P_FOLLOWERS = oid(13);
const P_MUTUAL = oid(14);
const P_UNSET = oid(15);

db.settings.push({ user: P_EVERYONE, privacy: { whoCanMessage: "everyone" } });
db.settings.push({ user: P_NONE, privacy: { whoCanMessage: "none" } });
db.settings.push({ user: P_FOLLOWERS, privacy: { whoCanMessage: "followers" } });
db.settings.push({ user: P_MUTUAL, privacy: { whoCanMessage: "followers_following" } });

{
  const set = await access.messageableIdSet(A, [
    P_EVERYONE,
    P_NONE,
    P_FOLLOWERS,
    P_MUTUAL,
    P_UNSET,
  ]);
  ok("messageable: everyone allowed", set.has(P_EVERYONE));
  ok("messageable: none blocked", !set.has(P_NONE));
  ok("messageable: followers blocked when they don't follow you", !set.has(P_FOLLOWERS));
  ok("messageable: mutual blocked with no edge either way", !set.has(P_MUTUAL));
  ok("messageable: no settings row defaults to everyone", set.has(P_UNSET));
}

// P_FOLLOWERS accepts messages from people they follow -> they must follow A.
db.follows.push({ follower: P_FOLLOWERS, following: A, status: "accepted" });
// P_MUTUAL: A follows them, which satisfies followers_following.
db.follows.push({ follower: A, following: P_MUTUAL, status: "accepted" });

{
  const set = await access.messageableIdSet(A, [P_FOLLOWERS, P_MUTUAL]);
  ok("messageable: followers allowed once they follow you", set.has(P_FOLLOWERS));
  ok("messageable: mutual allowed on an outbound edge", set.has(P_MUTUAL));
}
{
  // A pending follow request is not an accepted edge.
  db.follows.push({ follower: oid(16), following: A, status: "pending" });
  db.settings.push({ user: oid(16), privacy: { whoCanMessage: "followers" } });
  const set = await access.messageableIdSet(A, [oid(16)]);
  ok("messageable: pending follow does not count", !set.has(oid(16)));
}

// ── groupMembership / resolveGroupSend ───────────────────────────────────────

db.groups.push({ _id: G, name: "Live", isActive: true, isDeleted: false });
const GONE = oid(19);
db.groups.push({ _id: GONE, name: "Gone", isActive: true, isDeleted: true });
db.members.push({ group: GONE, user: A, isBanned: false, role: "member" });

const RESTRICTED_G = oid(20);
db.groups.push({ _id: RESTRICTED_G, name: "Locked", isActive: true, isDeleted: false });
db.members.push({ group: RESTRICTED_G, user: A, isBanned: false, role: "restricted" });

// getPermissions is a document method; the stub rows need it.
for (const m of db.members) {
  m.getPermissions = () => ({
    sendMessages: m.role !== "restricted",
    sendMedia: m.role !== "restricted",
    pinMessages: ["admin", "super_admin"].includes(m.role),
  });
}

ok("membership: member found", Boolean(await access.groupMembership(G, A)));
ok("membership: banned member not found", !(await access.groupMembership(G, C)));
ok("membership: invalid group id", !(await access.groupMembership("nope", A)));
ok("membership: invalid user id", !(await access.groupMembership(G, "nope")));

{
  const r = await access.resolveGroupSend(G, A);
  ok("groupSend: allowed for a member", r.ok === true);
}
{
  const r = await access.resolveGroupSend(G, C);
  ok("groupSend: banned member refused", r.ok === false);
  ok("groupSend: banned member reason", /not in that group/i.test(r.reason));
}
{
  const r = await access.resolveGroupSend(GONE, A);
  ok("groupSend: deleted group refused", r.ok === false);
  ok("groupSend: deleted group reason", /no longer active/i.test(r.reason));
}
{
  const r = await access.resolveGroupSend(RESTRICTED_G, A);
  ok("groupSend: restricted role refused", r.ok === false);
  ok("groupSend: restricted role reason", /can't post/i.test(r.reason));
}
{
  const r = await access.resolveGroupSend(oid(77), A);
  ok("groupSend: unknown group refused", r.ok === false);
}

// ── resolveReplyTo ───────────────────────────────────────────────────────────

const CONV_AB = [A, B].sort().join(":");
const CONV_AC = [A, C].sort().join(":");
const CONV_G = `g:${G}`;

db.messages.push({
  _id: oid(200),
  conversation: CONV_AB,
  sender: A,
  receiver: B,
  isGroupMessage: false,
  deletedFor: [],
});
db.messages.push({
  _id: oid(201),
  conversation: CONV_AC,
  sender: C,
  receiver: oid(4),
  isGroupMessage: false,
  deletedFor: [],
});
db.messages.push({
  _id: oid(202),
  conversation: CONV_G,
  sender: B,
  group: G,
  isGroupMessage: true,
  deletedFor: [],
});

eq(
  "replyTo: same conversation accepted",
  String(await access.resolveReplyTo(oid(200), { conversation: CONV_AB, userId: A })),
  oid(200)
);
// The shipped client sends replyTo as a whole object, not an id — see
// UserConversationPage's sendMessage and GroupChatPage's.
eq(
  "replyTo: accepts the object shape the client actually sends",
  String(
    await access.resolveReplyTo(
      { _id: oid(200), content: "hi", senderUsername: "x", messageType: "text" },
      { conversation: CONV_AB, userId: A }
    )
  ),
  oid(200)
);
eq(
  "replyTo: object shape from another conversation still rejected",
  await access.resolveReplyTo({ _id: oid(201), content: "hi" }, { conversation: CONV_AB, userId: A }),
  null
);
eq(
  "replyTo: other conversation rejected",
  await access.resolveReplyTo(oid(201), { conversation: CONV_AB, userId: A }),
  null
);
eq(
  "replyTo: group message quoted from a DM rejected",
  await access.resolveReplyTo(oid(202), { conversation: CONV_AB, userId: A }),
  null
);
eq(
  "replyTo: group message in its own group accepted",
  String(await access.resolveReplyTo(oid(202), { conversation: CONV_G, userId: A })),
  oid(202)
);
eq(
  "replyTo: non-member cannot quote a group message",
  await access.resolveReplyTo(oid(202), { conversation: CONV_G, userId: C }),
  null
);
eq("replyTo: null passes through", await access.resolveReplyTo(null, { conversation: CONV_AB, userId: A }), null);
eq(
  "replyTo: garbage id rejected",
  await access.resolveReplyTo("../../etc/passwd", { conversation: CONV_AB, userId: A }),
  null
);
eq(
  "replyTo: unknown id rejected",
  await access.resolveReplyTo(oid(999), { conversation: CONV_AB, userId: A }),
  null
);
eq(
  "replyTo: operator object rejected",
  await access.resolveReplyTo({ $gt: null }, { conversation: CONV_AB, userId: A }),
  null
);

// ── socket.js pure helpers ───────────────────────────────────────────────────

const socketSrc = fs.readFileSync(path.join(root, "config/socket.js"), "utf8");

const slice = (from, fnName) => {
  const start = socketSrc.indexOf(from);
  const fnAt = socketSrc.indexOf(fnName, start);
  const end = socketSrc.indexOf("\n}\n", fnAt) + 3;
  if (start < 0 || fnAt < 0 || end < 3) throw new Error(`could not slice ${fnName}`);
  return socketSrc.slice(start, end);
};

const budget = new Function(
  `${slice("const RATE_LIMITS = {", "function withinBudget")}
   ${slice("function sweepRateBuckets", "function sweepRateBuckets")}
   return { RATE_LIMITS, rateBuckets, withinBudget, sweepRateBuckets };`
)();

{
  const { withinBudget, RATE_LIMITS, rateBuckets, sweepRateBuckets } = budget;

  // Signalling must not be able to starve call control: running out of budget
  // mid-call would leave a user unable to hang up.
  ok("budget: iceCandidate has its own bucket", Boolean(RATE_LIMITS.iceCandidate));
  ok("budget: endCall has its own bucket", Boolean(RATE_LIMITS.endCall));
  ok(
    "budget: iceCandidate cannot exhaust endCall",
    RATE_LIMITS.iceCandidate.points > RATE_LIMITS._default.points / 2
  );
  // The client re-emits this on every message-array change in both directions.
  ok(
    "budget: markConversationAsRead is above ordinary conversation volume",
    RATE_LIMITS.markConversationAsRead.points >= 300
  );
  const u = "rate-user";
  const cap = RATE_LIMITS.sendMessage.points;
  let allowed = 0;
  for (let i = 0; i < cap + 10; i += 1) if (withinBudget(u, "sendMessage")) allowed += 1;
  eq("budget: sendMessage capped at its own limit", allowed, cap);

  ok("budget: a different event has its own bucket", withinBudget(u, "typing"));
  ok("budget: a different user is unaffected", withinBudget("other", "sendMessage"));

  ok(
    "budget: unknown events fall into the default bucket",
    withinBudget(u, "somethingNobodyAddedALimitFor")
  );
  eq(
    "budget: unknown events do not create per-event buckets",
    rateBuckets.get(u).has("somethingNobodyAddedALimitFor"),
    false
  );
  ok("budget: default bucket exists", rateBuckets.get(u).has("_default"));

  // Window expiry.
  rateBuckets.get(u).set("sendMessage", { count: cap, resetAt: Date.now() - 1 });
  ok("budget: window resets", withinBudget(u, "sendMessage"));

  // Prototype-pollution guard: "constructor" must not resolve a rule.
  ok("budget: inherited keys are not treated as rules", withinBudget(u, "constructor"));
  eq(
    "budget: inherited keys use the default bucket",
    rateBuckets.get(u).has("constructor"),
    false
  );

  // The sweep must not become a way to reset a live budget.
  const sweepUser = "sweep-user";
  withinBudget(sweepUser, "sendMessage");
  sweepRateBuckets();
  ok("sweep: keeps a live bucket", rateBuckets.get(sweepUser)?.has("sendMessage"));
  eq(
    "sweep: does not reset a live count",
    rateBuckets.get(sweepUser).get("sendMessage").count,
    1
  );

  rateBuckets.get(sweepUser).set("sendMessage", { count: 99, resetAt: Date.now() - 1 });
  sweepRateBuckets();
  eq("sweep: drops an expired user entirely", rateBuckets.has(sweepUser), false);
}

// ── conversationRoom ─────────────────────────────────────────────────────────

const roomFn = access.conversationRoom;

eq("room: group message", roomFn({ isGroupMessage: true, group: { toString: () => G } }), G);
eq("room: DM both parties", roomFn({ sender: { toString: () => A }, receiver: { toString: () => B } }), [A, B]);
eq(
  "room: DM with a missing receiver does not throw",
  roomFn({ sender: { toString: () => A }, receiver: null }),
  [A]
);
eq(
  "room: DM with an undefined receiver does not throw",
  roomFn({ sender: { toString: () => A } }),
  [A]
);
eq(
  "room: populated sender and receiver",
  roomFn({ sender: { _id: A }, receiver: { _id: B } }),
  [A, B]
);

// ── Send gates (socket.js) ───────────────────────────────────────────────────

/*
 * The content rules moved to utils/messageContent.js — they were duplicated
 * between socket.js and chatController.js — so they are imported here rather than
 * sliced out of the socket source. The module is pure, so the real one loads.
 */
const content = await import("../utils/messageContent.js");

/*
 * `parseSendPayload` is imported, not sliced.
 *
 * It moved out of config/socket.js into utils/messageContent.js when the DM send path was
 * extracted into a service, and the slice above stopped finding it. Importing the real module
 * is what should have happened anyway: a text-extracted copy can pass while the shipped
 * function differs, which is the one thing a harness must never allow.
 */
const { parseSendPayload } = content;
const MAX_MEDIA_PER_MESSAGE = content.MAX_MEDIA_PER_MESSAGE;

/*
 * The `messagingBlockedReason` harness used to sit here, with eight assertions.
 *
 * That function no longer exists. The maintenance and feature-flag gate now runs
 * inside services/directMessage.js and services/groupMessage.js, so a bot and an
 * HTTP caller are gated identically to a socket — rather than the gate being
 * something only socket.js remembered to apply.
 *
 * The assertions are not lost. They are the same checks, made against the real
 * functions instead of a declaration recovered from a file by string search:
 *
 *   test/botDirectMessageService.test.js   the DM gate
 *   test/groupMessageService.test.js       the group gate
 *
 * Which is what should have happened here anyway: a text-extracted copy can pass
 * while the shipped function differs, the one thing a harness must never allow —
 * the note above `parseSendPayload` makes the same point.
 */

// -- parseSendPayload --

const HTTPS_URL = "https://res.cloudinary.com/x/image/upload/a.png";

/** A media item shaped the way the upload endpoint returns it, signed. */
const signed = (over = {}) => {
  const d = { url: HTTPS_URL, type: "image", fileSize: 1234, ...over };
  return { ...d, token: signMedia(d) };
};

ok("payload: rejects empty", Boolean(parseSendPayload({ content: "", media: [], messageType: "text" }).error));
ok(
  "payload: rejects whitespace-only",
  Boolean(parseSendPayload({ content: "   \n ", media: [], messageType: "text" }).error)
);
ok(
  "payload: rejects a missing body entirely",
  Boolean(parseSendPayload({ messageType: "text" }).error)
);
eq(
  "payload: text only is fine",
  parseSendPayload({ content: " hi ", media: [], messageType: "text" }).content,
  "hi"
);
ok(
  "payload: media with no text is fine",
  !parseSendPayload({ content: "", media: [signed()], messageType: "media" }).error
);
ok(
  "payload: rejects content over the schema cap",
  Boolean(parseSendPayload({ content: "x".repeat(10001), messageType: "text" }).error)
);
ok(
  "payload: accepts content at the cap",
  !parseSendPayload({ content: "x".repeat(10000), messageType: "text" }).error
);
ok(
  "payload: caps the media array",
  Boolean(
    parseSendPayload({
      media: Array.from({ length: MAX_MEDIA_PER_MESSAGE + 1 }, () => signed()),
      messageType: "media",
    }).error
  )
);
ok(
  "payload: accepts media at the cap",
  !parseSendPayload({
    media: Array.from({ length: MAX_MEDIA_PER_MESSAGE }, () => signed()),
    messageType: "media",
  }).error
);
ok(
  "payload: non-array media is treated as none",
  Boolean(parseSendPayload({ content: "", media: "nope", messageType: "text" }).error)
);
ok(
  "payload: non-string content is treated as none",
  Boolean(parseSendPayload({ content: { $ne: null }, media: [], messageType: "text" }).error)
);

// Attachment shape. The url is rendered by every other participant's browser.
ok(
  "payload: rejects an attachment with no url",
  Boolean(parseSendPayload({ media: [{ type: "image" }], messageType: "media" }).error)
);
ok(
  "payload: rejects a non-https attachment url",
  Boolean(
    parseSendPayload({ media: [signed({ url: "javascript:alert(1)" })], messageType: "media" })
      .error
  )
);
ok(
  "payload: rejects an http attachment url",
  Boolean(
    parseSendPayload({ media: [signed({ url: "http://cdn/a.png" })], messageType: "media" })
      .error
  )
);
ok(
  "payload: rejects an attachment type outside the schema enum",
  Boolean(parseSendPayload({ media: [signed({ type: "script" })], messageType: "media" }).error)
);
ok(
  "payload: rejects a null attachment",
  Boolean(parseSendPayload({ media: [null], messageType: "media" }).error)
);
ok(
  "payload: allows an attachment with no declared type",
  !parseSendPayload({ media: [signed({ type: undefined })], messageType: "media" }).error
);

for (const t of ["text", "media", "voice", "gif", "location", "sticker"]) {
  ok(`payload: ${t} is client-settable`, !parseSendPayload({ content: "x", messageType: t }).error);
}
/*
 * Removed from the schema enum entirely, or produced only by the server.
 *
 * `file` joined this list when documents were removed from the product: the composer has
 * no way to attach one, the upload endpoint refuses every document mimetype, and a client
 * naming the type directly must be refused too or that is the way back in.
 */
for (const t of ["file", "system", "call", "payment", "post_share", "poll", "reply", "forward", "story_reply", "contact"]) {
  ok(
    `payload: ${t} is server-only and refused`,
    Boolean(parseSendPayload({ content: "x", messageType: t }).error)
  );
}
ok(
  "payload: unknown type refused",
  Boolean(parseSendPayload({ content: "x", messageType: "nonsense" }).error)
);
ok(
  "payload: missing type refused rather than defaulted",
  Boolean(parseSendPayload({ content: "x" }).error)
);

// -- resolveGroupSend: the one gate every group write goes through --

const GATED = oid(30);
const IMAGE = [{ type: "image", url: "https://cdn.example/a.png" }];
const DOC = [{ type: "document", url: "https://cdn.example/a.pdf" }];

/** Point the gated group's settings and the caller's membership at a scenario. */
const scenario = ({ settings = {}, role = "member", mutedUntil = null, perms = {} } = {}) => {
  db.groups = db.groups.filter((g) => g._id !== GATED);
  db.groups.push({ _id: GATED, name: "Gated", isActive: true, isDeleted: false, settings });
  db.members = db.members.filter((m) => !(m.group === GATED && m.user === A));
  db.members.push({
    group: GATED,
    user: A,
    isBanned: false,
    role,
    mutedUntil,
    getPermissions: () => ({
      sendMessages: perms.sendMessages ?? role !== "restricted",
      sendMedia: perms.sendMedia ?? role !== "restricted",
    }),
  });
};

const gate = (media) => access.resolveGroupSend(GATED, A, { media });

scenario();
eq("group gate: ordinary member may post", (await gate([])).ok, true);
eq("group gate: ordinary member may post media", (await gate(IMAGE)).ok, true);

scenario({ perms: { sendMessages: false } });
eq("group gate: no sendMessages permission refused", (await gate([])).ok, false);

scenario({ perms: { sendMedia: false } });
ok("group gate: no sendMedia permission refuses media", /media/i.test((await gate(IMAGE)).reason));
eq("group gate: no sendMedia permission still allows text", (await gate([])).ok, true);

scenario({ mutedUntil: new Date(Date.now() + 60_000) });
ok("group gate: a muted member is refused", /muted/i.test((await gate([])).reason));
ok(
  "group gate: mute is reported before the media permission",
  /muted/i.test((await gate(IMAGE)).reason)
);

scenario({ mutedUntil: new Date(Date.now() - 60_000) });
eq("group gate: an expired mute does not block", (await gate([])).ok, true);

scenario({ settings: { mediaSharing: false } });
eq("group gate: mediaSharing off refuses media", (await gate(IMAGE)).ok, false);
eq("group gate: mediaSharing off still allows text", (await gate([])).ok, true);

/*
 * There is no `fileSharing` setting to test.
 *
 * It gated `type === "document"`, which nothing can produce now — the media type is gone
 * from the schema enum, so `mediaSharing` above is the only sharing rule left. What still
 * matters is that a document *descriptor* can't be smuggled past the media gate, which
 * the signature test further down covers.
 */
scenario({ settings: { mediaSharing: false } });
eq("group gate: a document descriptor is refused like any other media", (await gate(DOC)).ok, false);

// Slow mode
const CONV_GATED = `g:${GATED}`;
const putRecent = (ageMs) => {
  db.messages = db.messages.filter((m) => m.conversation !== CONV_GATED);
  if (ageMs !== null) {
    db.messages.push({
      _id: oid(300),
      conversation: CONV_GATED,
      sender: A,
      group: GATED,
      isGroupMessage: true,
      deletedFor: [],
      createdAt: new Date(Date.now() - ageMs),
    });
  }
};

scenario({ settings: { slowModeSeconds: 0 } });
putRecent(1_000);
messageQueries = 0;
eq("group gate: slow mode off allows", (await gate([])).ok, true);
eq("group gate: slow mode off costs no query", messageQueries, 0);

scenario({ settings: { slowModeSeconds: 30 } });
putRecent(5_000);
ok("group gate: slow mode refuses inside the window", /slow mode/i.test((await gate([])).reason));
ok(
  "group gate: slow mode reports a sane wait",
  /wait ([1-9]|[12][0-9]|30)s/.test((await gate([])).reason)
);

putRecent(60_000);
eq("group gate: slow mode allows once the window has passed", (await gate([])).ok, true);
putRecent(null);
eq("group gate: slow mode allows a first message", (await gate([])).ok, true);

// A future createdAt must not produce an unbounded lockout.
putRecent(-60 * 60 * 1000);
{
  const r = await gate([]);
  ok("group gate: a future timestamp is clamped to the window", /wait (30|[12][0-9]|[1-9])s/.test(r.reason));
}

scenario({ settings: { slowModeSeconds: -5 } });
putRecent(1_000);
eq("group gate: a negative slow mode is treated as off", (await gate([])).ok, true);

scenario({ role: "admin", settings: { slowModeSeconds: 300 } });
putRecent(1_000);
eq("group gate: group admins are exempt from slow mode", (await gate([])).ok, true);
scenario({ role: "super_admin", settings: { slowModeSeconds: 300 } });
eq("group gate: super admins are exempt from slow mode", (await gate([])).ok, true);
scenario({ settings: { slowModeSeconds: 300 } });
eq("group gate: ordinary members are not exempt", (await gate([])).ok, false);

putRecent(null);

// ── Media signature (CF7) ────────────────────────────────────────────────────

{
  const item = signed();
  ok("media token: round-trips", verifyMedia(item));
  ok("media token: unsigned rejected", !verifyMedia({ url: HTTPS_URL, type: "image" }));
  ok("media token: empty token rejected", !verifyMedia({ ...item, token: "" }));
  ok("media token: wrong token rejected", !verifyMedia({ ...item, token: "abc" }));

  // The whole point: the type is what the upload endpoint decided, and
  // relabelling it must not survive.
  ok(
    "media token: a document relabelled as an image is rejected",
    !verifyMedia({ ...signed({ type: "document" }), type: "image" })
  );
  ok(
    "media token: swapping the url is rejected",
    !verifyMedia({ ...item, url: "https://evil.example/x.png" })
  );
  ok(
    "media token: changing the size is rejected",
    !verifyMedia({ ...item, fileSize: 999999999 })
  );
  eq("media token: stripped before storage", stripMediaToken(item).token, undefined);
  eq("media token: strip keeps the rest", stripMediaToken(item).url, HTTPS_URL);

  // GIFs are hotlinked from the picker, never uploaded, so there is nothing to
  // sign — the host allow-list stands in for the signature.
  const gif = { type: "gif", url: "https://media.giphy.com/media/abc/giphy.gif" };
  ok("gif: an allow-listed host is accepted unsigned", isAllowedGif(gif));
  ok(
    "gif: a look-alike host is refused",
    !isAllowedGif({ ...gif, url: "https://media.giphy.com.evil.example/x.gif" })
  );
  ok("gif: http is refused", !isAllowedGif({ ...gif, url: "http://media.giphy.com/x.gif" }));
  ok("gif: the exemption is type-scoped", !isAllowedGif({ ...gif, type: "document" }));
  ok("gif: garbage url refused", !isAllowedGif({ type: "gif", url: "not a url" }));

  ok(
    "payload: an unsigned GIF from the picker still sends",
    !parseSendPayload({ media: [gif], messageType: "gif" }).error
  );
  ok(
    "payload: an unsigned non-GIF is still refused",
    Boolean(
      parseSendPayload({ media: [{ type: "image", url: HTTPS_URL }], messageType: "media" }).error
    )
  );
}

// ── Read watermark (readState.js) ────────────────────────────────────────────

const readStateStubs = `
const mongoose = {
  isValidObjectId: (v) => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v),
};
const ConversationRead = __readDb.ConversationRead;
const Message = __readDb.Message;
const UserRelation = { eitherBlocks: async (a, b) => __readDb.blocks.has(a + ":" + b) || __readDb.blocks.has(b + ":" + a) };
const audienceAllows = __readDb.audienceAllows;
const privacyOf = __readDb.privacyOf;
`;

const readDb = {
  rows: [], // { user, conversation, lastReadAt }
  messages: [],
  blocks: new Set(),
  emitted: [],
  privacy: { readReceipts: true, whoCanSeeReadReceipts: "everyone" },
  audienceResult: true,
};
readDb.privacyOf = async () => readDb.privacy;
readDb.audienceAllows = async () => readDb.audienceResult;
readDb.ConversationRead = {
  find: (f) =>
    query(
      readDb.rows.filter((r) => {
        if (f.user?.$ne) return String(r.user) !== String(f.user.$ne);
        if (f.user && String(r.user) !== String(f.user)) return false;
        if (f.conversation?.$in) return f.conversation.$in.includes(r.conversation);
        if (f.conversation && r.conversation !== f.conversation) return false;
        return true;
      })
    ),
  findOne: (f) =>
    query(
      readDb.rows.find(
        (r) => String(r.user) === String(f.user) && r.conversation === f.conversation
      ) || null
    ),
  findOneAndUpdate(filter, update, options = {}) {
    let row = readDb.rows.find(
      (r) => String(r.user) === String(filter.user) && r.conversation === filter.conversation
    );
    if (!row) {
      if (!options.upsert) return { lean: async () => null };
      row = { user: String(filter.user), conversation: filter.conversation, lastReadAt: new Date(0) };
      readDb.rows.push(row);
    }
    // $max is the whole point: a slow tab must not drag the watermark back.
    if (update.$max?.lastReadAt && update.$max.lastReadAt > row.lastReadAt) {
      row.lastReadAt = update.$max.lastReadAt;
    }
    if (update.$max?.lastDeliveredAt) row.lastDeliveredAt = update.$max.lastDeliveredAt;
    return { lean: async () => ({ ...row }) };
  },
  async updateOne(filter, update) {
    let row = readDb.rows.find(
      (r) => String(r.user) === String(filter.user) && r.conversation === filter.conversation
    );
    if (!row) {
      row = { user: String(filter.user), conversation: filter.conversation, lastReadAt: new Date(0) };
      readDb.rows.push(row);
    }
    if (update.$set?.lastReadAt) row.lastReadAt = update.$set.lastReadAt;
  },
};
readDb.Message = {
  findOne: (f) => {
    const found = readDb.messages
      .filter(
        (m) =>
          m.conversation === f.conversation &&
          String(m.sender) !== String(f.sender.$ne ?? " ")
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const p = query(found || null);
    p.sort = () => p;
    return p;
  },
  aggregate: async ([{ $match }]) => {
    const counts = new Map();
    for (const m of readDb.messages) {
      const clause = $match.$or.find((c) => c.conversation === m.conversation);
      if (!clause) continue;
      if (String(m.sender) === String($match.sender.$ne)) continue;
      if (m.createdAt <= clause.createdAt.$gt) continue;
      counts.set(m.conversation, (counts.get(m.conversation) || 0) + 1);
    }
    return [...counts].map(([_id, count]) => ({ _id, count }));
  },
  // markConversationUnread returns the real count now rather than letting the
  // client assume 1 — see CF8.
  countDocuments: async (f) =>
    readDb.messages.filter(
      (m) =>
        m.conversation === f.conversation &&
        String(m.sender) !== String(f.sender?.$ne ?? " ") &&
        m.createdAt > f.createdAt.$gt
    ).length,
};

const readState = await new Function(
  "__readDb",
  "__q",
  `${readStateStubs}
   ${fs
     .readFileSync(path.join(root, "utils/readState.js"), "utf8")
     .split("\n")
     .filter((l) => !/^import\s/.test(l))
     .join("\n")
     .replace(/^export (const|function) /gm, "$1 ")}
   return { EPOCH, watermarksFromRows, lastReadAt, markConversationRead,
            markConversationUnread, unreadCountsByConversation,
            peerReadWatermarks, peerReadAt, dmPeerId, notifyConversationRead,
            chatIdForConversation };`
)(readDb, query);

const CONV = `${A}:${B}`;

/*
 * Read one user's watermarks back out of the stub.
 *
 * These three blocks assert on `markConversationRead`, `unreadCountsByConversation` and
 * `markConversationUnread`; the watermark map is how they observe the result, not what
 * they are testing. They used to get it from `readWatermarks`, which queried for it —
 * that function is gone, because since CF23/CF24 both production callers already hold the
 * rows and re-reading them was a second round trip for data in a local variable. So the
 * rows come straight off the double here and go through the same `watermarksFromRows` the
 * controllers use, which keeps the map's shape under test rather than restated.
 */
const watermarksFor = (user) =>
  readState.watermarksFromRows(readDb.rows.filter((r) => String(r.user) === String(user)));

eq("watermark: unknown conversation reads as the epoch",
  readState.lastReadAt(new Map(), CONV).getTime(), 0);

{
  const t1 = new Date("2026-01-01T10:00:00Z");
  const t2 = new Date("2026-01-01T11:00:00Z");
  await readState.markConversationRead(A, CONV, t2);
  await readState.markConversationRead(A, CONV, t1); // a slow second tab
  const wm = watermarksFor(A);
  eq(
    "watermark: an older write cannot drag it backwards",
    readState.lastReadAt(wm, CONV).toISOString(),
    t2.toISOString()
  );
}

{
  // Unread is "newer than the watermark, and not mine".
  readDb.messages = [
    { conversation: CONV, sender: B, createdAt: new Date("2026-01-01T09:00:00Z") },
    { conversation: CONV, sender: B, createdAt: new Date("2026-01-01T12:00:00Z") },
    { conversation: CONV, sender: B, createdAt: new Date("2026-01-01T13:00:00Z") },
    { conversation: CONV, sender: A, createdAt: new Date("2026-01-01T14:00:00Z") },
  ];
  const wm = watermarksFor(A);
  const counts = await readState.unreadCountsByConversation(A, [CONV], wm);
  eq("unread: counts only what arrived after the watermark", counts.get(CONV), 2);

  const theirs = await readState.unreadCountsByConversation(B, [CONV], new Map());
  eq("unread: my own messages never count toward my unread", theirs.get(CONV), 1);
}

{
  // Mark-as-unread walks the watermark back behind the newest inbound message.
  const marked = await readState.markConversationUnread(A, CONV);
  ok("mark unread: reports success", Boolean(marked));
  const wm = watermarksFor(A);
  const counts = await readState.unreadCountsByConversation(A, [CONV], wm);
  ok("mark unread: the chat is unread again", counts.get(CONV) >= 1);
  /*
   * The count it reports has to be the count the next fetch will produce (CF8).
   * The client used to assume 1, and the watermark lands a millisecond before the
   * newest inbound message — so anything sharing that millisecond is unread too
   * and the badge disagreed with the list on the next load.
   */
  eq(
    "mark unread: the reported count matches what the aggregation sees",
    marked.unreadCount,
    counts.get(CONV)
  );
}

{
  /*
   * Two inbound messages in the same millisecond — the case that made the
   * assumed 1 wrong. Both sit after a watermark set to (that instant − 1ms), so
   * the honest answer is 2.
   */
  const sameMs = new Date("2026-02-01T09:00:00.000Z");
  readDb.rows.length = 0;
  readDb.messages = [
    { conversation: CONV, sender: B, createdAt: sameMs },
    { conversation: CONV, sender: B, createdAt: sameMs },
  ];
  const marked = await readState.markConversationUnread(A, CONV);
  eq("mark unread: two messages in one millisecond both count", marked.unreadCount, 2);
}

{
  readDb.messages = [{ conversation: CONV, sender: A, createdAt: new Date() }];
  eq(
    "mark unread: nothing inbound means nothing to mark",
    await readState.markConversationUnread(A, CONV),
    null
  );
}

/*
 * Reading someone's watermark is a read receipt too.
 *
 * The socket emit path checks privacy; these two REST paths hand the peer's
 * exact timestamp to the caller on every thread load and every chat-list load,
 * so they have to check the same three things or the toggle is cosmetic.
 */
{
  readDb.rows = [{ user: B, conversation: CONV, lastReadAt: new Date("2026-02-01T00:00:00Z") }];
  readDb.privacy = { readReceipts: true, whoCanSeeReadReceipts: "everyone" };
  readDb.audienceResult = true;
  readDb.blocks.clear();

  eq(
    "peer watermark: visible by default",
    (await readState.peerReadAt(A, B, CONV)).toISOString(),
    "2026-02-01T00:00:00.000Z"
  );
  eq(
    "peer watermarks (list): visible by default",
    (await readState.peerReadWatermarks(A, [CONV]))?.get(CONV)?.toISOString(),
    "2026-02-01T00:00:00.000Z"
  );

  readDb.privacy = { ...readDb.privacy, readReceipts: false };
  eq(
    "peer watermark: hidden when they turned receipts off",
    (await readState.peerReadAt(A, B, CONV)).getTime(),
    0
  );
  eq(
    "peer watermarks (list): hidden when they turned receipts off",
    (await readState.peerReadWatermarks(A, [CONV])).has(CONV),
    false
  );

  readDb.privacy = { ...readDb.privacy, readReceipts: true };
  readDb.audienceResult = false;
  eq(
    "peer watermark: hidden when the audience excludes you",
    (await readState.peerReadAt(A, B, CONV)).getTime(),
    0
  );
  readDb.audienceResult = true;

  readDb.blocks.add(`${A}:${B}`);
  eq("peer watermark: hidden across a block", (await readState.peerReadAt(A, B, CONV)).getTime(), 0);
  readDb.blocks.clear();

  readDb.rows = [];
}

// The chat list and the message layer use different key namespaces; one mapper
// translates, so a badge cleared over the socket lands on the right row.
eq("chatId: DM key", readState.chatIdForConversation(`${A}:${B}`, A), `user_${B}`);
eq("chatId: DM key from the other side", readState.chatIdForConversation(`${A}:${B}`, B), `user_${A}`);
eq("chatId: group key", readState.chatIdForConversation(`g:${G}`, A), `group_${G}`);
eq("chatId: non-string", readState.chatIdForConversation(null, A), null);

eq("dmPeerId: finds the other party", readState.dmPeerId(`${A}:${B}`, A), B);
eq("dmPeerId: works from either side", readState.dmPeerId(`${A}:${B}`, B), A);
eq("dmPeerId: null for a group key", readState.dmPeerId(`g:${G}`, A), null);
eq("dmPeerId: null when the caller isn't in it", readState.dmPeerId(`${B}:${C}`, A), null);

// Read receipts honour the privacy toggles for the first time.
{
  const io = { to: (room) => ({ emit: (event, payload) => readDb.emitted.push({ room, event, payload }) }) };
  const send = () =>
    readState.notifyConversationRead({ io, userId: A, conversation: CONV, readAt: new Date() });

  readDb.emitted = [];
  await send();
  eq("receipts: emitted by default", readDb.emitted.length, 1);
  eq("receipts: addressed to the peer", readDb.emitted[0].room, B);

  readDb.emitted = [];
  readDb.privacy = { ...readDb.privacy, readReceipts: false };
  await send();
  eq("receipts: suppressed when the reader turned them off", readDb.emitted.length, 0);

  readDb.privacy = { ...readDb.privacy, readReceipts: true };
  readDb.emitted = [];
  readDb.audienceResult = false;
  await send();
  eq("receipts: suppressed when the audience excludes the peer", readDb.emitted.length, 0);
  readDb.audienceResult = true;

  readDb.emitted = [];
  readDb.blocks.add(`${A}:${B}`);
  await send();
  eq("receipts: suppressed across a block", readDb.emitted.length, 0);
  readDb.blocks.clear();

  readDb.emitted = [];
  await readState.notifyConversationRead({ io, userId: A, conversation: `g:${G}`, readAt: new Date() });
  eq("receipts: not emitted for groups", readDb.emitted.length, 0);
}

// ── audienceAllows ───────────────────────────────────────────────────────────

{
  const OWNER = oid(40);
  const VIEWER = oid(41);
  eq("audience: everyone", await access.audienceAllows(VIEWER, OWNER, "everyone"), true);
  eq("audience: unset defaults to everyone", await access.audienceAllows(VIEWER, OWNER, undefined), true);
  eq("audience: none", await access.audienceAllows(VIEWER, OWNER, "none"), false);
  eq("audience: you always see your own", await access.audienceAllows(OWNER, OWNER, "none"), true);
  eq("audience: missing ids", await access.audienceAllows(null, OWNER, "everyone"), false);

  eq(
    "audience: followers excludes a non-follower",
    await access.audienceAllows(VIEWER, OWNER, "followers"),
    false
  );
  db.follows.push({ follower: VIEWER, following: OWNER, status: "accepted" });
  eq(
    "audience: followers includes a follower",
    await access.audienceAllows(VIEWER, OWNER, "followers"),
    true
  );

  const OTHER = oid(42);
  eq(
    "audience: followers_following excludes a stranger",
    await access.audienceAllows(OTHER, OWNER, "followers_following"),
    false
  );
  db.follows.push({ follower: OWNER, following: OTHER, status: "accepted" });
  eq(
    "audience: followers_following includes someone the owner follows",
    await access.audienceAllows(OTHER, OWNER, "followers_following"),
    true
  );
}

// ── canReadConversation ──────────────────────────────────────────────────────

ok("conversation access: DM participant", await access.canReadConversation(`${A}:${B}`, A));
ok("conversation access: DM outsider refused", !(await access.canReadConversation(`${A}:${B}`, C)));
ok("conversation access: group member", await access.canReadConversation(`g:${G}`, A));
ok("conversation access: banned group member refused", !(await access.canReadConversation(`g:${G}`, C)));
ok("conversation access: garbage refused", !(await access.canReadConversation("nonsense", A)));
ok("conversation access: non-string refused", !(await access.canReadConversation({ $ne: null }, A)));

// ── scrub (CF2) ──────────────────────────────────────────────────────────────

{
  const { scrub } = await import("../middleware/sanitizeMongo.js");

  // The operator key is removed, not the field holding it — `{token: {}}`
  // reaching a filter matches nothing, which is the intended outcome.
  const flat = { token: { $ne: null }, name: "ok" };
  scrub(flat);
  eq("scrub: strips a nested operator key", flat.token.$ne, undefined);
  eq("scrub: leaves ordinary keys", flat.name, "ok");

  const topLevel = { $where: "1", ok: 1 };
  scrub(topLevel);
  eq("scrub: strips a top-level operator", topLevel.$where, undefined);
  eq("scrub: leaves its sibling", topLevel.ok, 1);

  const dotted = { "a.b": 1, c: 2 };
  scrub(dotted);
  eq("scrub: strips dotted keys", dotted["a.b"], undefined);

  const nested = { a: { b: { c: { $gt: null } } } };
  scrub(nested);
  eq("scrub: reaches into nested objects", nested.a.b.c.$gt, undefined);

  const inArray = { list: [{ $where: "1" }, { ok: 1 }] };
  scrub(inArray);
  eq("scrub: reaches into arrays", inArray.list[0].$where, undefined);
  eq("scrub: leaves array siblings", inArray.list[1].ok, 1);

  // The depth guard used to `return` before cleaning, so one level past the
  // limit smuggled operators straight through — a sanitiser failing open.
  let deep = { $ne: null };
  for (let i = 0; i < 12; i += 1) deep = { nest: deep };
  scrub(deep);
  let probe = deep;
  let found = false;
  while (probe && typeof probe === "object") {
    if ("$ne" in probe) found = true;
    probe = probe.nest;
  }
  ok("scrub: an over-deep operator does not survive", !found);

  // The array branch recurses too, and only the object branch self-limited —
  // so a deeply nested array literal was a stack-overflow payload on every
  // request and every socket packet.
  let deepArray = ["x"];
  for (let i = 0; i < 50_000; i += 1) deepArray = [deepArray];
  let survived = true;
  try {
    scrub({ body: deepArray });
  } catch {
    survived = false;
  }
  ok("scrub: a deeply nested array does not blow the stack", survived);
}

// ── Disappearing messages and mute (R6) ──────────────────────────────────────

{
  // These read UserSettings through a shape the earlier stub doesn't serve, so
  // give it findOne/find over the same rows.
  const settingsRows = [];
  db.settings.findOneShim = null;

  const chatStub = await new Function(
    "__rows",
    "__q",
    `const UserSettings = {
       find: (f) => __q(__rows.filter((r) => f.user.$in.map(String).includes(String(r.user)))),
       findOne: (f) => __q(__rows.find((r) => String(r.user) === String(f.user)) || null),
     };
     ${fs
       .readFileSync(path.join(root, "utils/chatAccess.js"), "utf8")
       .split("\n")
       .filter((l) => !/^import\s/.test(l))
       .join("\n")
       .replace(/^export (const|function) /gm, "$1 ")}
     return { conversationTtlSeconds, isConversationMuted };`
  )(settingsRows, query);

  const CONV_TTL = `${A}:${B}`;

  /*
   * The stored key is the chat-list id from *that user's* side, not the
   * conversation key — A files this thread under `user_<B>` and B files the
   * very same thread under `user_<A>`. The first version of these tests used
   * the conversation key for both, which matched nothing, so the whole feature
   * read as "no TTL set" and the suite passed green over a dead code path.
   */
  const keyFor = (user) => (user === A ? `user_${B}` : `user_${A}`);

  const setDisappearing = (user, seconds) => {
    settingsRows.length = 0;
    settingsRows.push(
      { user: A, chat: { disappearingByChat: [], mutedChats: [] } },
      { user: B, chat: { disappearingByChat: [], mutedChats: [] } }
    );
    const row = settingsRows.find((r) => r.user === user);
    if (seconds !== null) row.chat.disappearingByChat.push({ chatId: keyFor(user), seconds });
  };

  setDisappearing(A, null);
  eq(
    "ttl: nobody set it, so nothing expires",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    null
  );

  setDisappearing(A, 3600);
  eq(
    "ttl: the sender's setting applies",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    3600
  );

  setDisappearing(B, 60);
  eq(
    "ttl: the recipient's setting applies to the sender's messages too",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    60
  );

  // Both set it — the shorter one wins, so neither party can quietly extend
  // the other's choice.
  settingsRows.length = 0;
  settingsRows.push(
    { user: A, chat: { disappearingByChat: [{ chatId: keyFor(A), seconds: 3600 }] } },
    { user: B, chat: { disappearingByChat: [{ chatId: keyFor(B), seconds: 60 }] } }
  );
  eq(
    "ttl: the shorter of the two wins",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    60
  );

  // Reversed, so "shortest" can't be satisfied by "whichever came last".
  settingsRows.length = 0;
  settingsRows.push(
    { user: A, chat: { disappearingByChat: [{ chatId: keyFor(A), seconds: 60 }] } },
    { user: B, chat: { disappearingByChat: [{ chatId: keyFor(B), seconds: 3600 }] } }
  );
  eq(
    "ttl: shorter still wins when it comes first",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    60
  );

  // Junk in the stored setting must not become a past expiry — that would be
  // an unsend with no time limit.
  for (const bad of [0, -5, null, "soon", NaN]) {
    settingsRows.length = 0;
    settingsRows.push({ user: A, chat: { disappearingByChat: [{ chatId: keyFor(A), seconds: bad }] } });
    eq(
      `ttl: ${JSON.stringify(bad)} is ignored rather than applied`,
      await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
      null
    );
  }

  // The conversation key must NOT match — that was the original bug.
  settingsRows.length = 0;
  settingsRows.push({ user: A, chat: { disappearingByChat: [{ chatId: CONV_TTL, seconds: 60 }] } });
  eq(
    "ttl: the conversation key is not the stored key",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    null
  );

  // A stored value from before the cap existed is clamped on read.
  settingsRows.length = 0;
  settingsRows.push({
    user: A,
    chat: { disappearingByChat: [{ chatId: keyFor(A), seconds: 365 * 24 * 60 * 60 }] },
  });
  eq(
    "ttl: an over-long stored setting is clamped",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    90 * 24 * 60 * 60
  );

  settingsRows.length = 0;
  settingsRows.push({ user: A, chat: { disappearingByChat: [{ chatId: "other", seconds: 60 }] } });
  eq(
    "ttl: a setting for a different conversation doesn't leak",
    await chatStub.conversationTtlSeconds(CONV_TTL, [A, B]),
    null
  );

  // Mute
  settingsRows.length = 0;
  settingsRows.push({ user: A, chat: { mutedChats: [`user_${B}`] } });
  eq("mute: a muted conversation reports muted", await chatStub.isConversationMuted(A, `user_${B}`), true);
  eq("mute: a different conversation is not", await chatStub.isConversationMuted(A, `user_${C}`), false);
  settingsRows.length = 0;
  eq("mute: no settings row means not muted", await chatStub.isConversationMuted(A, `user_${B}`), false);
}

// ── Reaction emoji (#62) ─────────────────────────────────────────────────────
//
// `emoji` was taken verbatim at all three reaction entry points. Size is what
// made it more than cosmetic: the value is stored on the reaction row, copied
// into the message's cached reactionSummary, and rebroadcast to the room on
// every later reaction to that message.

{
  const { parseReactionEmoji, parseSkinTone, MAX_EMOJI_LENGTH } = await import(
    "../utils/reactions.js"
  );

  for (const good of ["👍", "❤️", "😀", "👨‍👩‍👧‍👦", "🇮🇳", "1️⃣", "#️⃣", "👍🏽", "🏳️‍🌈"]) {
    eq(`emoji: accepts ${good}`, parseReactionEmoji(good), good);
  }

  eq("emoji: trims surrounding space", parseReactionEmoji("  👍  "), "👍");

  // The whole point of the item: unbounded input.
  eq("emoji: rejects a megabyte of text", parseReactionEmoji("x".repeat(1_000_000)), null);
  eq(
    "emoji: rejects a long run of real emoji",
    parseReactionEmoji("😀".repeat(MAX_EMOJI_LENGTH)),
    null
  );
  eq("emoji: rejects two emoji", parseReactionEmoji("🙂🙂"), null);

  /*
   * The length cap, pinned on its own.
   *
   * The two assertions above don't test it: both inputs are refused by the
   * one-grapheme rule, so raising MAX_EMOJI_LENGTH leaves them passing. A
   * pictographic base followed by a run of variation selectors is a *single*
   * grapheme cluster of valid emoji code points, so length is the only thing
   * standing in its way.
   *
   * The 200 is a literal rather than derived from the constant — deriving it
   * would grow the input alongside the cap and the probe would never fire. So
   * this also asserts the cap stays small: raise it past 200 and this fails,
   * which is the conversation worth having.
   */
  ok("emoji: the cap is small enough to be a cap", MAX_EMOJI_LENGTH < 200);
  eq(
    "emoji: rejects one grapheme that is longer than the cap",
    parseReactionEmoji("😀" + "️".repeat(200)),
    null
  );
  eq(
    "emoji: accepts the same shape inside the cap",
    parseReactionEmoji("😀️"),
    "😀️"
  );

  // `if (!emoji)` was the old check, so everything below reached the database.
  eq("emoji: rejects plain text", parseReactionEmoji("lol"), null);
  eq("emoji: rejects a single letter", parseReactionEmoji("a"), null);
  eq("emoji: rejects a bare digit (Emoji_Component, not an emoji)", parseReactionEmoji("1"), null);
  eq("emoji: rejects markup", parseReactionEmoji("<script>alert(1)</script>"), null);
  eq("emoji: rejects empty", parseReactionEmoji(""), null);
  eq("emoji: rejects whitespace", parseReactionEmoji("   "), null);
  eq("emoji: rejects undefined", parseReactionEmoji(undefined), null);
  // This is the case that produced the literal string "undefined" in the
  // database, because the upsert ran without runValidators.
  eq("emoji: rejects the string 'undefined'", parseReactionEmoji("undefined"), null);
  eq("emoji: rejects a number", parseReactionEmoji(5), null);
  eq("emoji: rejects an operator object", parseReactionEmoji({ $ne: null }), null);
  eq("emoji: rejects an array", parseReactionEmoji(["👍"]), null);

  eq("skinTone: passes 1..6", parseSkinTone(4), 4);
  eq("skinTone: defaults on 0", parseSkinTone(0), 1);
  eq("skinTone: defaults above 6", parseSkinTone(99), 1);
  eq("skinTone: defaults on a fraction", parseSkinTone(2.5), 1);
  eq("skinTone: defaults on text", parseSkinTone("many"), 1);
  eq("skinTone: defaults on undefined", parseSkinTone(undefined), 1);
}

// ── Chat-lock unlock grants (CF19) ───────────────────────────────────────────
//
// The grant is what the thread, search, media and pinned reads verify instead of
// re-prompting for the PIN. It has to be unforgeable, bound to one conversation
// and one account, and expire.

{
  // Only node:crypto and a UserSettings lookup, and the lookup isn't exercised
  // here — the signing half is what carries the security properties.
  const lock = await loadModule(
    "utils/chatLock.js",
    `const crypto = __crypto;\nconst UserSettings = { findOne: () => __q(null) };`,
    {
      __crypto: (await import("node:crypto")).default,
      __q: query,
      // The real one, not a stub: the domain prefix and the required-secret
      // check are part of what these assertions are testing.
      signFor: (await import("../utils/signingSecret.js")).signFor,
    }
  );

  const { grant } = lock.issueUnlockGrant(A, `user_${B}`);

  ok("unlock: a fresh grant verifies", lock.verifyUnlockGrant(A, `user_${B}`, grant));

  // Bound to the conversation. Without chatId in the signature, unlocking one
  // chat would unlock every locked chat the account has.
  ok(
    "unlock: a grant for one chat does not open another",
    !lock.verifyUnlockGrant(A, `user_${C}`, grant)
  );
  // Bound to the account, so a grant lifted from one session is inert in another.
  ok(
    "unlock: another account's grant is refused",
    !lock.verifyUnlockGrant(C, `user_${B}`, grant)
  );

  // The expiry is signed as well as checked, so editing the plaintext half
  // invalidates the signature rather than extending the grant.
  const [, mac] = grant.split(".");
  const extended = `${Date.now() + 10 * 60 * 60 * 1000}.${mac}`;
  ok("unlock: the expiry can't be edited", !lock.verifyUnlockGrant(A, `user_${B}`, extended));

  /*
   * A *validly signed* grant whose expiry has passed.
   *
   * Reusing a live grant's signature with an older timestamp doesn't test this:
   * the signature covers the timestamp, so that input is refused by the MAC
   * comparison and the expiry check never runs. The HMAC is recomputed here
   * against the real payload format — including the `chatlock:v1` domain prefix
   * from utils/signingSecret.js — so the only thing left to reject it is the
   * clock. Duplicating the format is the cost of testing it, and if the format
   * changes, this fails loudly rather than passing vacuously. It has done so
   * once already, which is the argument for keeping it.
   */
  {
    const crypto = (await import("node:crypto")).default;
    const past = Date.now() - 1000;
    const mac = crypto
      .createHmac("sha256", process.env.JWT_SECRET)
      .update(`chatlock:v1\n${A}\n${`user_${B}`}\n${past}`)
      .digest("base64url");
    ok(
      "unlock: a correctly signed but expired grant is refused",
      !lock.verifyUnlockGrant(A, `user_${B}`, `${past}.${mac}`)
    );
    // The same construction one hour ahead must be accepted, or the assertion
    // above would pass even if verification rejected everything.
    const future = Date.now() + 60 * 60 * 1000;
    const liveMac = crypto
      .createHmac("sha256", process.env.JWT_SECRET)
      .update(`chatlock:v1\n${A}\n${`user_${B}`}\n${future}`)
      .digest("base64url");
    ok(
      "unlock: the same construction in the future is accepted",
      lock.verifyUnlockGrant(A, `user_${B}`, `${future}.${liveMac}`)
    );
  }

  // Fails closed on every malformed shape rather than throwing.
  for (const [name, value] of [
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["no separator", "abcdef"],
    ["separator first", ".abcdef"],
    ["no signature", `${Date.now() + 60_000}.`],
    ["non-numeric expiry", `soon.${mac}`],
    ["an object", { $ne: null }],
    ["an array", [grant]],
  ]) {
    ok(`unlock: refuses a grant that is ${name}`, !lock.verifyUnlockGrant(A, `user_${B}`, value));
  }

  ok(
    "unlock: a grant is not reusable after re-signing with a tampered mac",
    !lock.verifyUnlockGrant(A, `user_${B}`, `${grant.split(".")[0]}.${"A".repeat(mac.length)}`)
  );

  eq("unlock: the header name is the one CORS allows", lock.UNLOCK_HEADER, "x-chat-unlock");
}

// ── Chat preference lists (#65) ──────────────────────────────────────────────

{
  // No imports at all, so the real module loads directly.
  const prefs = await import("../utils/chatPreferences.js");

  eq("chatId: accepts a user id", prefs.parseChatId(`user_${A}`), `user_${A}`);
  eq("chatId: accepts a group id", prefs.parseChatId(`group_${G}`), `group_${G}`);
  // Uppercase hex is a valid ObjectId string, and 'A' < 'a' — the same hazard
  // that made a whole class of messages invisible before conversation keys were
  // lowercased. Here it made the preference a silent no-op.
  eq(
    "chatId: canonicalises uppercase hex",
    prefs.parseChatId("user_AAAAAAAAAAAAAAAAAAAAAAAA"),
    "user_aaaaaaaaaaaaaaaaaaaaaaaa"
  );
  eq("chatId: canonicalises the prefix", prefs.parseChatId(`USER_${A}`), `user_${A}`);

  for (const [name, value] of [
    ["an arbitrary string", "whatever"],
    ["a bare id", A],
    ["an unknown prefix", `post_${A}`],
    ["a short id", "user_abc"],
    ["a long id", `user_${A}0`],
    ["non-hex", "user_zzzzzzzzzzzzzzzzzzzzzzzz"],
    ["an operator object", { $ne: null }],
    ["an array", [`user_${A}`]],
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
  ]) {
    eq(`chatId: rejects ${name}`, prefs.parseChatId(value), null);
  }

  // The cap. Growing one UserSettings document past 16MB makes every later save
  // fail permanently, so the list has to refuse growth well before that.
  const full = Array.from({ length: prefs.MAX_PREFERENCE_ENTRIES }, (_, i) => `user_${oid(i)}`);
  ok("cap: a full list refuses a new entry", prefs.atPreferenceCap(full, `user_${oid(9999)}`));
  ok(
    "cap: a full list still allows an existing entry through",
    !prefs.atPreferenceCap(full, full[0])
  );
  ok("cap: an under-full list allows growth", !prefs.atPreferenceCap(full.slice(0, -1), "user_new"));
  ok("cap: an empty list allows growth", !prefs.atPreferenceCap([], `user_${A}`));
  ok("cap: a non-array is treated as empty", !prefs.atPreferenceCap(undefined, `user_${A}`));

  // The object-shaped lists (archivedChats, themeByChat, categoryAssignments,
  // disappearingByChat) go through the same check.
  const objectList = full.map((chatId) => ({ chatId, archivedAt: 0 }));
  ok("cap: object entries count too", prefs.atPreferenceCap(objectList, `user_${oid(9999)}`));
  ok(
    "cap: an existing object entry is an update, not growth",
    !prefs.atPreferenceCap(objectList, objectList[0].chatId)
  );

  /*
   * This used to assert `MAX_PREFERENCE_ENTRIES === MAX_CHAT_LIST`. That constant is gone
   * with the 500-conversation chat-list cap it named (CF23/CF24), so the relationship it
   * checked no longer exists. What still matters is that the ceiling is a finite positive
   * number: `getChats` expands these lists into `$in`/`$nin` clauses, so an unbounded one
   * is an unbounded query.
   */
  ok(
    "cap: the preference ceiling is a finite bound",
    Number.isInteger(prefs.MAX_PREFERENCE_ENTRIES) && prefs.MAX_PREFERENCE_ENTRIES > 0
  );

  /*
   * Legacy entries written before the writers canonicalised.
   *
   * Uppercase hex is a valid ObjectId string, so entries like `user_5F2A…` can be
   * sitting in these lists. Once every writer lowercases its input, an exact
   * comparison never finds one — which makes it *unremovable*: unmuting looks like
   * it worked, the entry stays, no UI can see it, and it counts against the cap
   * forever. So reads match case-insensitively while writes store the canonical
   * form.
   */
  const upper = `user_${"5F2AB3C4D5E6F7089A1B2C3D".toLowerCase().toUpperCase()}`;
  const lower = upper.toLowerCase();

  ok("legacy: an uppercase entry matches its canonical id", prefs.sameChatId(upper, lower));
  ok("legacy: and the comparison is symmetric", prefs.sameChatId(lower, upper));
  ok("legacy: a different chat still doesn't match", !prefs.sameChatId(upper, `user_${oid(7)}`));
  ok(
    "legacy: object-shaped entries match too",
    prefs.sameChatId({ chatId: upper, theme: "dark" }, lower)
  );

  eq(
    "legacy: removal finds the uppercase entry",
    prefs.withoutChatId([upper, `user_${oid(7)}`], lower),
    [`user_${oid(7)}`]
  );
  eq(
    "legacy: removal finds the object-shaped uppercase entry",
    prefs.withoutChatId([{ chatId: upper }, { chatId: `user_${oid(7)}` }], lower),
    [{ chatId: `user_${oid(7)}` }]
  );
  eq("legacy: removal of an absent id changes nothing", prefs.withoutChatId([lower], "user_x"), [
    lower,
  ]);
  eq("legacy: removal tolerates a non-array", prefs.withoutChatId(undefined, lower), []);

  // And the cap treats it as an existing entry rather than as growth, so somebody
  // sitting at the ceiling can still turn a legacy one off.
  const fullWithLegacy = [
    upper,
    ...Array.from({ length: prefs.MAX_PREFERENCE_ENTRIES - 1 }, (_, i) => `user_${oid(i)}`),
  ];
  ok(
    "legacy: a full list still lets its uppercase entry through",
    !prefs.atPreferenceCap(fullWithLegacy, lower)
  );
}

// ── The sanitiser must not fail open (CF2, arrays) ───────────────────────────

{
  const { scrub } = await import("../middleware/sanitizeMongo.js");

  /*
   * Nesting past the depth limit inside *arrays* used to skip the scrub entirely.
   *
   * The object branch deletes its keys once it reaches the limit, but the array
   * branch returned before doing anything — so wrapping a payload in nine layers of
   * arrays carried its `$`-operators straight through, on HTTP and on every socket
   * packet. A bound is still needed (a deep array literal is a stack-overflow
   * payload), so the branch is discarded rather than trusted.
   */
  const deepInArrays = (depth) => {
    let node = { $where: "1" };
    for (let i = 0; i < depth; i += 1) node = [node];
    return { payload: node };
  };

  const shallow = deepInArrays(3);
  scrub(shallow);
  eq(
    "scrub: reaches an operator nested inside arrays",
    shallow.payload[0][0][0].$where,
    undefined
  );

  const deep = deepInArrays(12);
  scrub(deep);
  // Walk down as far as the structure still goes and assert nothing survived.
  let node = deep.payload;
  let survivors = 0;
  while (Array.isArray(node) && node.length) node = node[0];
  if (node && typeof node === "object" && "$where" in node) survivors += 1;
  eq("scrub: an operator past the depth limit does not survive in an array", survivors, 0);

  // The same payload one level *inside* the limit is scrubbed the ordinary way,
  // so the assertion above isn't passing merely because everything is discarded.
  const atLimit = deepInArrays(7);
  scrub(atLimit);
  let inner = atLimit.payload;
  while (Array.isArray(inner) && inner.length) inner = inner[0];
  eq("scrub: inside the limit the object is kept but cleaned", inner?.$where, undefined);
  ok("scrub: inside the limit the object still exists", inner !== undefined);
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
