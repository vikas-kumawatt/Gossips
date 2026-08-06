import assert from "node:assert";
import test, { mock } from "node:test";

/**
 * Endpoint URL validation — the SSRF boundary.
 *
 * The highest-risk module in the feature, so this is the longest table in the suite. The shape checks
 * are pure and need no mocking; DNS is mocked for the resolution half.
 *
 * Every blocked case here is written as an *address an attacker would actually try*, not as a range.
 * `169.254.169.254` is in the list because it returns cloud IAM credentials, not because it is
 * link-local — and a reader who does not know that should be able to learn it from the test.
 */

let lookupResult = [{ address: "93.184.216.34", family: 4 }];
let lookupError = null;

mock.module("node:dns/promises", {
  namedExports: {
    lookup: async () => {
      if (lookupError) throw lookupError;
      return lookupResult;
    },
  },
});

const { ENDPOINT_SOURCE, assertSafeEndpoint, checkEndpointShape, isBlockedAddress } = await import(
  "../bots/selfHosted.js"
);

const { OWNER, OPERATOR } = ENDPOINT_SOURCE;

/* ── Address classification ───────────────────────────────────────────────── */

test("THE POINT: every address an SSRF attempt would reach is blocked", () => {
  const blocked = {
    "169.254.169.254": "cloud instance metadata — IAM credentials for the host",
    "169.254.0.1": "the rest of link-local",
    "127.0.0.1": "loopback",
    "127.0.0.53": "systemd-resolved, still loopback",
    "0.0.0.0": "on Linux this reaches loopback",
    "10.0.0.5": "RFC 1918",
    "172.16.0.1": "RFC 1918, bottom of the range",
    "172.31.255.254": "RFC 1918, top of the range",
    "192.168.1.50": "RFC 1918, the home-network case",
    "100.64.0.1": "carrier NAT",
    "224.0.0.1": "multicast",
    "255.255.255.255": "broadcast",
    "::1": "IPv6 loopback",
    "::": "IPv6 unspecified",
    "fe80::1": "IPv6 link-local",
    "fd00::1": "IPv6 unique local",
    "::ffff:127.0.0.1": "IPv4-mapped loopback — reaches 127.0.0.1 through an IPv6 socket",
    "::ffff:169.254.169.254": "IPv4-mapped metadata, the same trick aimed at the worst target",
  };

  for (const [address, why] of Object.entries(blocked)) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked: ${why}`);
  }
});

test("ordinary public addresses are allowed, or the feature does nothing", () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, `${address} should be reachable`);
  }
});

test("172.32 is public and 172.15 is public — the RFC 1918 block is /12, not /8", () => {
  // The off-by-one that a hand-written range check gets wrong.
  assert.equal(isBlockedAddress("172.15.0.1"), false);
  assert.equal(isBlockedAddress("172.16.0.1"), true);
  assert.equal(isBlockedAddress("172.31.0.1"), true);
  assert.equal(isBlockedAddress("172.32.0.1"), false);
});

test("anything that isn't a parseable address is blocked, not guessed at", () => {
  for (const junk of ["", null, undefined, "not-an-address", "999.999.999.999", "1.2.3"]) {
    assert.equal(isBlockedAddress(junk), true, String(junk));
  }
});

/* ── Encoded addresses ────────────────────────────────────────────────────── */

test("THE POINT: alternative encodings of an address are refused, not normalised", () => {
  /*
   * Every one of these reaches 127.0.0.1 through some legacy `inet_aton` behaviour. Rather than
   * compete with every URL library in the stack over how to normalise them, anything that is neither
   * a well-formed IP literal nor a plausible DNS name is refused — a real endpoint is always one of
   * those two.
   */
  const encoded = [
    "https://2130706433/",           // decimal integer
    "https://0177.0.0.1/",           // octal
    "https://0x7f.0.0.1/",           // hex
    "https://127.1/",                // short form
    "https://127.0.1/",              // three-part form
  ];

  for (const url of encoded) {
    const result = checkEndpointShape(url, OWNER);
    assert.equal(result.ok, false, `${url} must be refused`);
  }
});

/* ── Scheme, credentials, shape ───────────────────────────────────────────── */

test("an owner-supplied endpoint must be https", () => {
  /*
   * Not for confidentiality alone: a valid certificate for the hostname is itself evidence the host is
   * a real public endpoint rather than a private address hiding behind a name.
   */
  assert.equal(checkEndpointShape("http://models.example.com/v1", OWNER).ok, false);
  assert.equal(checkEndpointShape("https://models.example.com/v1", OWNER).ok, true);
});

test("the operator may use http, because it is their own network", () => {
  // And this is the case the whole feature exists for: Ollama beside the app.
  assert.equal(checkEndpointShape("http://127.0.0.1:11434/v1", OPERATOR).ok, true);
  assert.equal(checkEndpointShape("http://192.168.1.50:11434/v1", OPERATOR).ok, true);
});

test("THE DISTINCTION: the same URL is allowed for the operator and refused for an owner", () => {
  /*
   * The design in one assertion. What separates safe from unsafe is not the address — it is who chose
   * it. An operator naming a loopback address owns the process already; an owner naming one is
   * reaching for something that isn't theirs.
   */
  const url = "http://127.0.0.1:11434/v1";
  assert.equal(checkEndpointShape(url, OPERATOR).ok, true);
  assert.equal(checkEndpointShape(url, OWNER).ok, false);
});

test("only http and https, for either source", () => {
  for (const url of [
    "file:///etc/passwd",
    "gopher://evil.example/",
    "ftp://evil.example/",
    "data:text/plain,hello",
    "//evil.example/v1",
  ]) {
    assert.equal(checkEndpointShape(url, OPERATOR).ok, false, url);
    assert.equal(checkEndpointShape(url, OWNER).ok, false, url);
  }
});

test("credentials in the URL are refused", () => {
  /*
   * Two problems in one string. It would make this server send someone else's basic-auth header, and
   * it is the oldest way to disguise a host: a reader sees `models.example.com`, the resolver sees
   * `evil.example`.
   */
  const result = checkEndpointShape("https://models.example.com:pw@evil.example/v1", OWNER);
  assert.equal(result.ok, false);
  assert.match(result.error, /credentials/);

  assert.equal(checkEndpointShape("https://user@evil.example/v1", OWNER).ok, false);
});

test("a query string or fragment is refused", () => {
  // A base URL with a query would put the adapter's path after it and silently produce nonsense.
  assert.equal(checkEndpointShape("https://models.example.com/v1?key=x", OWNER).ok, false);
  assert.equal(checkEndpointShape("https://models.example.com/v1#f", OWNER).ok, false);
});

test("the base URL is normalised, keeping the path and dropping trailing slashes", () => {
  // The path matters: Ollama serves its OpenAI-compatible API under /v1.
  assert.equal(checkEndpointShape("https://models.example.com/v1/", OWNER).url, "https://models.example.com/v1");
  assert.equal(checkEndpointShape("https://models.example.com/v1///", OWNER).url, "https://models.example.com/v1");
  assert.equal(checkEndpointShape("https://models.example.com", OWNER).url, "https://models.example.com");
  assert.equal(
    checkEndpointShape("http://127.0.0.1:11434/v1", OPERATOR).url,
    "http://127.0.0.1:11434/v1"
  );
});

test("junk and over-long input is refused without throwing", () => {
  for (const raw of ["", "   ", null, undefined, 42, {}, `https://a.example/${"x".repeat(400)}`]) {
    const result = checkEndpointShape(raw, OWNER);
    assert.equal(result.ok, false, String(raw).slice(0, 40));
    assert.ok(result.error);
  }
});

/* ── DNS ──────────────────────────────────────────────────────────────────── */

const resolvesTo = (...addresses) => {
  lookupError = null;
  lookupResult = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

test("a hostname resolving to a public address is allowed", async () => {
  resolvesTo("93.184.216.34");
  const result = await assertSafeEndpoint("https://models.example.com/v1", OWNER);

  assert.equal(result.ok, true);
  assert.equal(result.url, "https://models.example.com/v1");
  assert.deepEqual(result.addresses, ["93.184.216.34"]);
});

test("THE POINT: a hostname resolving to a private address is refused", async () => {
  // The attack that beats a shape-only check: `internal.attacker.com A 127.0.0.1`.
  resolvesTo("127.0.0.1");
  const result = await assertSafeEndpoint("https://looks-fine.example.com/v1", OWNER);

  assert.equal(result.ok, false);
  assert.match(result.error, /publicly reachable/);
});

test("EVERY resolved address is checked, not the first", async () => {
  /*
   * A name with both a public and a private record would otherwise pass on the public one and then
   * connect to whichever the resolver happened to return at request time.
   */
  resolvesTo("93.184.216.34", "169.254.169.254");
  const result = await assertSafeEndpoint("https://split-horizon.example.com/v1", OWNER);

  assert.equal(result.ok, false);
});

test("an unresolvable host is refused rather than assumed harmless", async () => {
  /*
   * "It didn't resolve, so it's probably fine" is how this check gets bypassed by a name that
   * resolves only from inside the network.
   */
  lookupError = new Error("ENOTFOUND");
  const result = await assertSafeEndpoint("https://nowhere.example.com/v1", OWNER);

  assert.equal(result.ok, false);
  assert.match(result.error, /could not be resolved/);
});

test("the operator path does no DNS at all", async () => {
  /*
   * Nothing to check: they named an address on a network they own. Making them wait on a resolver —
   * and fail when it is unavailable — would be ceremony rather than security.
   */
  lookupError = new Error("resolver should not have been called");
  const result = await assertSafeEndpoint("http://127.0.0.1:11434/v1", OPERATOR);

  assert.equal(result.ok, true);
  assert.deepEqual(result.addresses, []);
});

test("an owner-supplied IP literal skips DNS but not the address check", async () => {
  lookupError = new Error("resolver should not have been called");

  const publicIp = await assertSafeEndpoint("https://93.184.216.34/v1", OWNER);
  assert.equal(publicIp.ok, true);

  const privateIp = await assertSafeEndpoint("https://10.0.0.5/v1", OWNER);
  assert.equal(privateIp.ok, false);
});

test("re-validation is possible, which is the point of splitting the DNS half out", async () => {
  /*
   * The same URL passes and then fails as its DNS answer changes. That is why `assertSafeEndpoint`
   * runs again immediately before each call rather than only at save time — a check that happened
   * once was permanently satisfied by whatever the answer was that day.
   */
  const url = "https://moves-around.example.com/v1";

  resolvesTo("93.184.216.34");
  assert.equal((await assertSafeEndpoint(url, OWNER)).ok, true);

  resolvesTo("127.0.0.1");
  assert.equal((await assertSafeEndpoint(url, OWNER)).ok, false);
});
