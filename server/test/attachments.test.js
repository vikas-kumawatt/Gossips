import assert from "node:assert/strict";
import test, { mock } from "node:test";
/*
 * `bcrypt` is a native module and nothing here reaches the code that uses it —
 * it arrives through models/User.js, which hashes passwords on save. Loading it
 * means dlopen'ing a binary built for whichever platform last ran `npm install`,
 * so a checkout made on Windows cannot run this suite on Linux or in CI.
 *
 * Stubbing keeps the suite hermetic: no compiler, no platform binary, nothing to
 * rebuild after switching machines.
 */
mock.module("bcrypt", {
  defaultExport: {
    hash: async () => "stub-hash",
    compare: async () => true,
    genSalt: async () => "stub-salt",
  },
});

/*
 * Imported dynamically, not statically: an `import` statement is hoisted above
 * everything else in the module, so a static import would load utils/attachments.js
 * — and through it bcrypt — before the stub above could register.
 */
const {
  parseAttachments,
  parseGif,
  parseLocation,
  parsePoll,
  projectPoll,
} = await import("../utils/attachments.js");
const { normalizeMedia } = await import("../utils/mediaTypes.js");

test("rejects a GIF URL that only looks like a picker result", () => {
  const result = parseGif({ url: "https://media.giphy.com.attacker.example/giphy.gif" });
  assert.equal(result.error, "GIFs have to come from the picker");
});

test("rejects a half-coordinate instead of silently dropping it", () => {
  const result = parseLocation({ name: "Somewhere", lat: 12.34 });
  assert.equal(result.error, "That location's coordinates aren't valid");
});

test("does not permit a client to combine a poll and uploaded audio", async () => {
  const result = await parseAttachments({
    body: {
      poll: JSON.stringify({
        question: "Which one?",
        options: ["A", "B"],
        durationMinutes: 5,
      }),
    },
    files: [{ mimetype: "audio/webm" }],
    /*
     * `duration` matters, and its absence is what made this test fail for as long as it existed.
     *
     * `parseAttachments` checks the clip's length before it checks the combination, and a clip with
     * no probed duration is refused outright — see the test below, which is the rule this fixture
     * kept tripping over. So an upload without a duration never reached the mutual-exclusion check,
     * and the assertion below was reading the wrong error the whole time.
     */
    uploader: async () => [
      { url: "https://cdn.example/audio.webm", type: "audio", duration: 12 },
    ],
  });
  assert.match(result.error, /not more than one/);
});

test("an audio clip with no probed duration is refused, not waved through", async () => {
  /*
   * The deliberate rule the fixture above collided with, and it had no test of its own. A clip
   * Cloudinary couldn't probe is exactly the kind most likely to be oversized, so an unknown
   * duration fails closed rather than open.
   */
  const result = await parseAttachments({
    body: {},
    files: [{ mimetype: "audio/webm" }],
    uploader: async () => [{ url: "https://cdn.example/audio.webm", type: "audio" }],
  });
  assert.match(result.error, /up to 5 minutes/);
});

test("withholds a live poll tally until the viewer votes", () => {
  const poll = {
    question: "Tea or coffee?",
    options: [
      { id: "tea", text: "Tea", votes: 7 },
      { id: "coffee", text: "Coffee", votes: 4 },
    ],
    totalVotes: 11,
    closesAt: new Date(Date.now() + 60_000),
  };

  const beforeVote = projectPoll(poll, null);
  assert.equal(beforeVote.totalVotes, null);
  assert.deepEqual(beforeVote.options.map((option) => option.votes), [null, null]);

  const afterVote = projectPoll(poll, { optionId: "tea" });
  assert.equal(afterVote.totalVotes, 11);
  assert.equal(afterVote.myOptionId, "tea");
});

test("normalizes legacy media while discarding blank legacy values", () => {
  assert.deepEqual(normalizeMedia(["https://cdn.example/voice.mp3", ""]), [
    {
      url: "https://cdn.example/voice.mp3",
      type: "audio",
    },
  ]);
});

test("accepts a well-formed poll at the supported lower boundary", () => {
  const result = parsePoll({
    question: "Pick one",
    options: ["First", "Second"],
    durationMinutes: 5,
  });
  assert.equal(result.poll.options.length, 2);
  assert.equal(result.poll.durationMinutes, 5);
});
