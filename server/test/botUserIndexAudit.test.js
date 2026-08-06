import assert from "node:assert";
import test from "node:test";

process.env.BYOK_ENCRYPTION_SECRET = "test-secret-of-at-least-32-characters-long";

const User = (await import("../models/User.js")).default;
const { classifyIndexes, indexSignature } = await import("../scripts/auditUserIndexes.js");

/*
 * The real index list from the production `users` collection, as reported after the email
 * migration ran. Verifying the classifier against invented input would prove nothing — the
 * whole risk is that it misjudges *these* indexes, on a live collection, irreversibly.
 */
const LIVE = [
  { name: "_id_", key: { _id: 1 } },
  { name: "username_1", key: { username: 1 }, unique: true },
  { name: "googleId_1", key: { googleId: 1 }, unique: true, sparse: true },
  { name: "githubId_1", key: { githubId: 1 }, unique: true, sparse: true },
  { name: "createdAt_1", key: { createdAt: 1 } },
  { name: "isOnline_1", key: { isOnline: 1 } },
  { name: "username_1_email_1", key: { username: 1, email: 1 } },
  { name: "createdAt_-1", key: { createdAt: -1 } },
  { name: "followers_1", key: { followers: 1 } },
  { name: "following_1", key: { following: 1 } },
  { name: "accountStatus_1", key: { accountStatus: 1 } },
  { name: "lastActive_-1", key: { lastActive: -1 } },
  { name: "phoneNumber_1", key: { phoneNumber: 1 }, sparse: true },
  { name: "appleId_1", key: { appleId: 1 }, unique: true, sparse: true },
  { name: "facebookId_1", key: { facebookId: 1 }, unique: true, sparse: true },
  {
    name: "username_text_name_text_bio_text",
    key: { _fts: "text", _ftsx: 1 },
    weights: { username: 1, name: 1, bio: 1 },
  },
  { name: "role_1", key: { role: 1 } },
  { name: "usernameHistory.username_1", key: { "usernameHistory.username": 1 }, sparse: true },
  { name: "isVerified_1", key: { isVerified: 1 }, partialFilterExpression: { isVerified: true } },
  { name: "owner_1", key: { owner: 1 }, partialFilterExpression: { isBot: true } },
  {
    name: "email_1_humans",
    key: { email: 1 },
    unique: true,
    partialFilterExpression: { isBot: false },
  },
];

const classify = () =>
  classifyIndexes(LIVE, User.schema.indexes(), new Set(Object.keys(User.schema.paths)));

const verdictFor = (name) => classify().find((index) => index.name === name);

test("the primary key is never a candidate", () => {
  assert.equal(verdictFor("_id_").verdict, "keep");
});

test("THE POINT: indexes on fields the schema no longer has are droppable", () => {
  // These can never serve a query — there is no such field to query on.
  for (const name of ["githubId_1", "isOnline_1", "followers_1", "following_1", "lastActive_-1"]) {
    const index = verdictFor(name);
    assert.equal(index.verdict, "drop", `${name} should be droppable`);
    assert.match(index.reason, /no such field/);
  }
});

test("an opposite-direction duplicate of a declared index is droppable", () => {
  /*
   * The schema declares `{ createdAt: -1 }`. A single-key index is traversable in both
   * directions, so `createdAt_1` is the same index kept twice.
   */
  const index = verdictFor("createdAt_1");
  assert.equal(index.verdict, "drop");
  assert.match(index.reason, /opposite direction/);

  // And the declared one survives.
  assert.equal(verdictFor("createdAt_-1").verdict, "keep");
});

test("a compound led by a uniquely-indexed field is droppable", () => {
  /*
   * `username` is unique on its own, so `{username, email}` can never narrow a match past
   * the one document `username_1` already resolves to.
   */
  const index = verdictFor("username_1_email_1");
  assert.equal(index.verdict, "drop");
  assert.match(index.reason, /uniquely indexed alone/);
});

test("THE POINT: nothing the schema declares is ever dropped", () => {
  const declared = User.schema.indexes().map(([spec]) => indexSignature(spec));
  for (const index of classify()) {
    if (declared.includes(indexSignature(index.key))) {
      assert.equal(index.verdict, "keep", `${index.name} is declared and must be kept`);
    }
  }
});

test("the indexes this feature added are kept", () => {
  // Dropping either would break the bot feature: one is the humans-only email constraint,
  // the other is how an owner's bots are found and counted.
  assert.equal(verdictFor("email_1_humans").verdict, "keep");
  assert.equal(verdictFor("owner_1").verdict, "keep");
});

test("the text index is recognised despite its _fts key", () => {
  // A text index is named for its fields but keyed as `_fts`/`_ftsx`, so it never matches a
  // declared signature by name. Misclassifying it would drop the app's user search.
  assert.equal(verdictFor("username_text_name_text_bio_text").verdict, "keep");
});

test("a subdocument path is recognised through its parent", () => {
  // `usernameHistory.username` may not appear as a schema path in its own right; the parent
  // array does. Treating it as orphaned would drop a live index.
  assert.notEqual(verdictFor("usernameHistory.username_1").verdict, "drop");
});

test("unique constraints are never silently removed", () => {
  /*
   * The one rule that matters most. A unique index enforces data integrity, and the window
   * after dropping one can admit duplicates that then prevent it being rebuilt — so a unique
   * index is only droppable when its guarantee is provably held by another index.
   */
  for (const index of classify()) {
    if (index.unique && index.verdict === "drop") {
      assert.match(
        index.reason,
        /uniquely indexed alone|no such field/,
        `${index.name} is unique and would be dropped for an unproven reason`
      );
    }
  }
});

test("the sparse OAuth indexes survive, except the one for a field that's gone", () => {
  for (const name of ["googleId_1", "appleId_1", "facebookId_1"]) {
    assert.equal(verdictFor(name).verdict, "keep", `${name} is a live login path`);
  }
  // githubId is not in the schema — there is no GitHub login.
  assert.equal(verdictFor("githubId_1").verdict, "drop");
});

test("the audit accounts for every live index exactly once", () => {
  const results = classify();
  assert.equal(results.length, LIVE.length);
  assert.equal(new Set(results.map((r) => r.name)).size, LIVE.length);
  for (const index of results) {
    assert.ok(["keep", "drop", "review"].includes(index.verdict));
    assert.ok(index.reason, `${index.name} must carry a reason`);
  }
});

test("the drop list is exactly the seven expected, and nothing creeps in", () => {
  /*
   * A regression guard with teeth: if a future schema change makes the classifier newly
   * willing to drop something, this fails and someone has to look at it — which is the
   * correct outcome for a script that deletes indexes from a live collection.
   */
  const dropping = classify()
    .filter((index) => index.verdict === "drop")
    .map((index) => index.name)
    .sort();

  assert.deepEqual(dropping, [
    "createdAt_1",
    "followers_1",
    "following_1",
    "githubId_1",
    "isOnline_1",
    "lastActive_-1",
    "username_1_email_1",
  ]);
});
