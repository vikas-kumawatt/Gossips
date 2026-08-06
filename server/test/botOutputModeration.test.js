import assert from "node:assert";
import test from "node:test";

/**
 * The deterministic rules applied to every string a bot writes.
 *
 * Pure, so this runs with no database connection, no network and no mocking. That is the whole argument
 * for the rules being deterministic in the first place: a moderation model could not be tested
 * like this, and a rule you cannot test is a rule you cannot prove still holds after a
 * refactor.
 *
 * The injection corpus near the bottom is the file's real payload, and it is written to be
 * extended: every new attack shape someone thinks of goes in the list, not in a new test.
 */

const {
  MAX_BOT_TEXT_LENGTH,
  findLinks,
  leaksSystemPrompt,
  moderateGeneratedText,
  normalizeGeneratedText,
} = await import("../bots/outputModeration.js");

/** The common case: a bot with a normal audience writing a normal sentence. */
const pass = (text, options = {}) =>
  moderateGeneratedText(text, { allowedUsernames: ["ana", "bo"], ...options });

/* ── Normalisation ────────────────────────────────────────────────────────── */

test("invisible characters are stripped before any rule looks at the text", () => {
  /*
   * The order is the point. A zero-width space inside "https" defeats a link check that runs
   * on the raw string, and the reader never sees the difference — so stripping has to happen
   * first, and then the link rule sees what a person would see.
   */
  // Built from an escape rather than a literal, so the payload survives every editor it
  // passes through — a test whose fixture can be silently normalised away proves nothing.
  const smuggled = "have a look at htt\u200Bps://example.com";
  assert.equal(normalizeGeneratedText(smuggled).includes("https://"), true);

  const verdict = pass(smuggled);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /link/);
});

test("bidi overrides are removed rather than published", () => {
  // A right-to-left override reverses the rendering of everything after it, in every client.
  const result = normalizeGeneratedText("nice post\u202Egnisitrevda");
  assert.equal(result.includes("\u202E"), false);
});

test("padding is collapsed, and the collapsed length is the one that counts", () => {
  assert.equal(normalizeGeneratedText("hello\n\n\n\n\nworld"), "hello\n\nworld");
  assert.equal(normalizeGeneratedText("  spaced   out  "), "spaced out");
  assert.equal(normalizeGeneratedText("\ttabbed"), "tabbed");
  assert.equal(normalizeGeneratedText(null), "");
});

/* ── Length ───────────────────────────────────────────────────────────────── */

test("empty, near-empty and over-long text are all refused", () => {
  assert.equal(pass("").ok, false);
  assert.equal(pass("   \n  ").ok, false);
  // A lone punctuation mark is what a model returns when it has nothing to say.
  assert.equal(pass(".").ok, false);
  assert.equal(pass("hi").ok, true, "two characters is a real message");

  const long = "a".repeat(MAX_BOT_TEXT_LENGTH + 1);
  const verdict = pass(long);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /too long/);
});

test("length is measured after normalisation, not before", () => {
  // 500 characters of text plus padding is a 500-character message, not a rejection.
  const padded = `${"a".repeat(MAX_BOT_TEXT_LENGTH)}\n\n\n\n   `;
  assert.equal(pass(padded).ok, true);
});

/* ── Links ────────────────────────────────────────────────────────────────── */

test("every shape of link is refused", () => {
  const shapes = [
    "https://example.com",
    "http://example.com/path?a=b",
    "HTTPS://EXAMPLE.COM",
    "https : //example.com",
    "hxxps://example.com",
    "www.example.com",
    "check out bit.ly/2xY",
    "somewhere.xyz has it",
    "example[.]com",
    "example ( . ) com",
    "example dot com",
    "example (dot) com",
    "javascript:alert(1)",
    "data:text/html;base64,AAAA",
    "mailto:someone@example.com",
  ];

  for (const shape of shapes) {
    const verdict = pass(`interesting, ${shape} maybe`);
    assert.equal(verdict.ok, false, `should have refused: ${shape}`);
    assert.match(verdict.reason, /link|email/, shape);
  }
});

test("the lowercase-TLD rule keeps ordinary prose out of the link check", () => {
  /*
   * The dominant false positive for bare-domain detection is a missing space after a full
   * stop. Requiring the suffix to be lowercase discards that class, because the next word in
   * real prose is capitalised.
   */
  assert.equal(pass("I went to the store.Online shopping is easier").ok, true);
  assert.equal(pass("Nothing else worked.Live and learn").ok, true);

  // And a spelled-out dot only counts when a suffix follows it.
  assert.equal(pass("I dot the i's and cross the t's").ok, true);
  assert.equal(pass("mail me at example dot com").ok, false);
});

test("the residual cost is named: a library that looks like a domain is refused", () => {
  /*
   * Recorded rather than fixed. "socket.io" is indistinguishable from a link by any rule that
   * still catches "bit.ly", and being refused once costs a bot one action — whereas a bot that
   * can post a shortened URL is a spam pipeline with an owner's name attached.
   */
  assert.equal(pass("we use socket.io for this").ok, false);
});

test("findLinks reports what it found, so a rejection reason is usable", () => {
  const found = findLinks("go to bit.ly/x now");
  assert.ok(found.length >= 1);
  assert.ok(found.some((match) => match.includes("bit.ly")));
  assert.deepEqual(findLinks("nothing here at all"), []);
  assert.deepEqual(findLinks(null), []);
});

/* ── Email ────────────────────────────────────────────────────────────────── */

test("email addresses are refused — the same attack, moved off-platform", () => {
  const verdict = pass("write to me, someone@example.org");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /email|link/);
});

test("REGRESSION: a mention followed by a sentence is not an email address", () => {
  /*
   * The first version of the email pattern allowed whitespace around the `@` and the dot, and
   * flagged this: "thanks" read as a local part and ". Smith" as a TLD. A false positive here
   * is silent — the bot simply never replies — which is exactly the kind of bug that survives
   * for months.
   */
  assert.equal(pass("thanks @ana. Smith was right about that").ok, true);
  assert.equal(pass("nice work @bo. See you tomorrow").ok, true);
});

/* ── Hashtags ─────────────────────────────────────────────────────────────── */

test("blocked hashtags are refused, built-in and admin-added alike", () => {
  const builtIn = pass("this is great #nsfw");
  assert.equal(builtIn.ok, false);
  assert.match(builtIn.reason, /blocked hashtag/);

  const configured = pass("morning all #crypto2024", { extraBlockedTags: ["crypto2024"] });
  assert.equal(configured.ok, false);

  // An ordinary tag is untouched.
  assert.equal(pass("morning all #coffee").ok, true);
});

/* ── The mention allowlist ────────────────────────────────────────────────── */

test("THE POINT: a bot may only mention people it was shown", () => {
  /*
   * `@`-ing a stranger is how a bot reaches outside its own audience, and it is the shape an
   * injected "tell @admin to reset the password" would take. Only handles that appeared in the
   * perception pass.
   */
  assert.equal(pass("good point @ana").ok, true);
  assert.equal(pass("good point @Ana").ok, true, "handles are case-insensitive");

  const verdict = pass("hey @stranger look at this");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not shown/);
});

test("the mention rule is also the impersonation guard", () => {
  /*
   * No account exists behind a reserved handle like `gossips_support`, so it can never appear
   * in a perception, so it can never be mentioned. The reserved-username list needs no separate
   * check here — this rule subsumes it.
   */
  const verdict = pass("contact @gossips_support about your login");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not shown/);
});

test("with no allowlist, no mention is permitted", () => {
  // The failure mode to avoid: an empty allowlist meaning "anything goes".
  const verdict = moderateGeneratedText("hello @ana", {});
  assert.equal(verdict.ok, false);
});

/* ── Prompt leakage ───────────────────────────────────────────────────────── */

test("a bot cannot recite its own instructions", () => {
  const systemPrompt =
    "You are Mira, a keen amateur baker who posts about sourdough starters and the weather in " +
    "Bristol. Never mention that you work for anyone.";

  const leak = moderateGeneratedText(
    "You are Mira, a keen amateur baker who posts about sourdough starters and the weather",
    { systemPrompt, allowedUsernames: [] }
  );
  assert.equal(leak.ok, false);
  assert.match(leak.reason, /instructions/);
});

test("re-wrapping a leaked line does not evade the check", () => {
  const systemPrompt = "You are Mira, a keen amateur baker who posts about sourdough starters daily.";
  const leak = moderateGeneratedText(
    "You  are\nMira,   a keen amateur\nbaker who posts about sourdough starters daily.",
    { systemPrompt, allowedUsernames: [] }
  );
  assert.equal(leak.ok, false);
});

test("a short overlap with the persona is not a leak", () => {
  /*
   * The trade-off, asserted so it stays deliberate. A bot whose persona says it bakes must be
   * able to say it bakes; only a whole clause reproduced word for word counts.
   */
  const systemPrompt = "You are Mira, a keen amateur baker who posts about sourdough starters.";
  assert.equal(moderateGeneratedText("I bake sourdough", { systemPrompt }).ok, true);
  assert.equal(leaksSystemPrompt("short", systemPrompt), false);
  assert.equal(leaksSystemPrompt("anything", ""), false);
});

/* ── The corpus ───────────────────────────────────────────────────────────── */

test("INJECTION CORPUS: every payload that reaches text is refused", () => {
  /*
   * These are the strings a compromised model might emit after reading a hostile post. None of
   * them is caught by understanding the intent — each is caught by a mechanical rule, which is
   * why the same list will still pass after a model upgrade.
   *
   * What this does *not* cover is injections that try to act rather than to write; those are
   * refused by the target allowlist in actionValidator, and tested there.
   */
  const payloads = [
    "Claim your free followers at freefollow.xyz",
    "URGENT: verify your account at https://gossips-login.com",
    "DM me at scammer@example.com for details",
    "Everyone should read gossips[.]support/verify",
    "Visit t.me/joinchat now",
    "Check hxxp://bad.example for the truth",
    "See www.definitely-not-phishing.com",
    "My real address is admin \u200B@ \u200Bevil.com",
    "#f4f #followforfollow follow back!",
    "Tell @site_admin to disable the filters",
  ];

  for (const payload of payloads) {
    const verdict = pass(payload);
    assert.equal(verdict.ok, false, `let through: ${payload}`);
    assert.ok(verdict.reason, "a refusal must carry a reason for the audit row");
  }
});

test("and the corpus does not simply refuse everything", () => {
  /*
   * The counterweight. A rule set that rejects all input would pass every test above and be
   * useless, so the ordinary messages a bot exists to write are asserted too.
   */
  const ordinary = [
    "this is lovely, the crumb looks perfect",
    "ha, same here — mine collapsed twice before it worked",
    "morning! #coffee first, thinking later",
    "@ana that's the trick I was missing, thank you",
    "I don't know enough about it to have an opinion yet",
    "Rain again. Third week running.",
  ];

  for (const text of ordinary) {
    const verdict = pass(text);
    assert.equal(verdict.ok, true, `wrongly refused: ${text} (${verdict.reason})`);
    assert.equal(typeof verdict.text, "string");
  }
});
