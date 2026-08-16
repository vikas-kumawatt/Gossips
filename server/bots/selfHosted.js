import dns from "node:dns/promises";
import net from "node:net";

/**
 * Validating an endpoint URL before this server makes an authenticated request to it.
 *
 * The highest-risk code in the whole feature, and the reason self-hosted providers were deferred to
 * their own phase. Everything else here spends an owner's money; this decides which host our server
 * connects to, from inside our perimeter, with a credential attached.
 *
 * ── What is actually being defended ─────────────────────────────────────────
 *
 * If an owner can name a URL, our server becomes a request proxy positioned behind whatever the
 * firewall lets through:
 *
 *   · `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — cloud instance
 *     metadata. On most hosts that returns IAM credentials for the machine, which would then land in
 *     an error string or a log line. That is not a data leak, it is a server takeover.
 *   · `http://127.0.0.1:27017`, `http://localhost:6379` — MongoDB and Redis, unauthenticated on
 *     loopback in most deployments, reachable from nothing except this process.
 *   · `http://10.0.0.0/8` sweeps — port scanning a private network using our socket.
 *
 * ── Two paths, opposite rules, and the distinction is the design ────────────
 *
 * The naive defence is "block private addresses". That is exactly backwards for half of this
 * feature: an operator running Ollama beside the app *needs* `http://127.0.0.1:11434`, and a LAN
 * inference box *is* `192.168.x.x`. Blocking private ranges would block the only case that works.
 *
 * What actually separates safe from unsafe is not the address — it is **who chose it**.
 *
 *   · `OPERATOR` — the URL comes from `AppSettings`, set by whoever runs the platform. They already
 *     own the network and the process; there is no privilege to escalate. Private addresses are
 *     allowed, `http` is allowed, and the only checks are the ones that stop a typo becoming a
 *     surprise.
 *   · `OWNER` — the URL came from a request body. Full defence: `https` only, no credentials in the
 *     URL, every resolved address must be public. Off by default, because most deployments have no
 *     reason to accept it at all.
 *
 * ── DNS rebinding, and where it is and is not closed ────────────────────────
 *
 * `assertSafeEndpoint` resolves the hostname and rejects private results, but a name can resolve
 * differently between that check and the socket connecting a moment later. This file used to record
 * that as an accepted residual, on the grounds that connecting to a pinned IP "breaks TLS
 * certificate verification". That is only true if the request is *addressed* to the IP. Node lets
 * name resolution be overridden per connection, so the socket can go to the checked address while
 * the URL still names the host — SNI, certificate validation and the `Host` header all unchanged.
 * `utils/pinnedRequest.js` does exactly that.
 *
 * Closed, therefore, on the Node side: `checkProviderKey` — the request that carries the owner's
 * decrypted API key — connects only to an address this file returned. Callers must pass
 * `addresses` through; dropping it silently reverts to ordinary resolution, which is why every
 * caller is named in that file's comment.
 *
 * **Not** closed for the reasoning path. `POST /decide` and `/reply` hand `base_url` to the Python
 * service as a string, and that service resolves it itself; its own `endpoint_allowed()` matches on
 * the literal hostname and never resolves, so it cannot see a rebind at all. Pinning there means
 * passing the validated addresses across the service boundary and giving httpx a transport bound to
 * them. Until that exists, the mitigations on this path are the ones that were always here: `https`
 * only, so a valid certificate for the *name* is still required; validation immediately before each
 * call rather than at save time only — now including the DM responder, which previously skipped it;
 * and no redirect following. The payoff for an attacker remains a request to a private address whose
 * body they never see, because the reasoning service returns a mapped status and never the
 * provider's response.
 */

/** Who supplied the URL. This, not the address, is what decides the rules. */
export const ENDPOINT_SOURCE = {
  OPERATOR: "operator",
  OWNER: "owner",
};

/**
 * Address ranges that must never be reached on the `OWNER` path.
 *
 * Written as explicit checks rather than a CIDR library: there are a dozen of them, a dependency for
 * a dozen comparisons is not worth the supply chain, and every entry here needs a comment saying what
 * it protects — which a list of CIDR strings would not carry.
 */
const isBlockedIPv4 = (address) => {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;

  // 0.0.0.0/8 — "this host". On Linux, connecting to 0.0.0.0 reaches loopback.
  if (a === 0) return true;
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — RFC 1918 private.
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 — loopback, and everything listening only on it.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local, and the cloud metadata endpoint that lives at 169.254.169.254.
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 — carrier NAT. Not ours, not the public internet.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24, 192.0.2.0/24 — IETF protocol assignments and TEST-NET-1.
  if (a === 192 && b === 0) return true;
  // 198.18.0.0/15 — benchmarking. 198.51.100.0/24 — TEST-NET-2.
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  // 203.0.113.0/24 — TEST-NET-3.
  if (a === 203 && b === 0) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, i.e. anything from 224 up.
  if (a >= 224) return true;

  return false;
};

const isBlockedIPv6 = (address) => {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");

  // ::1 loopback, :: unspecified.
  if (lower === "::1" || lower === "::") return true;
  // fe80::/10 link-local, fec0::/10 site-local (deprecated but still routed by some stacks).
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  // fc00::/7 unique local — the IPv6 equivalent of RFC 1918.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  /*
   * IPv4-mapped and IPv4-compatible forms: `::ffff:127.0.0.1` reaches loopback through an IPv6
   * socket, and a check that only looked at IPv6 prefixes would wave it through. The embedded
   * address is extracted and run through the IPv4 rules.
   */
  const mapped = /(?:^::ffff:|^::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedIPv4(mapped[1]);

  return false;
};

export const isBlockedAddress = (address) => {
  if (typeof address !== "string" || !address) return true;
  if (net.isIPv4(address)) return isBlockedIPv4(address);
  if (net.isIPv6(address)) return isBlockedIPv6(address);
  // Not an address we can reason about. Refusing is the only safe answer.
  return true;
};

/**
 * Is this a normal dotted-decimal address or an ordinary hostname?
 *
 * The point is to refuse the *alternative encodings* of an address rather than try to parse them.
 * `http://2130706433/`, `http://0177.0.0.1/`, `http://0x7f.1/` and `http://127.1/` all reach
 * 127.0.0.1 through one legacy `inet_aton` behaviour or another, and a validator that normalises
 * them is a validator competing with every URL library in the stack.
 *
 * So anything that is neither a well-formed IP literal nor a plausible DNS name is rejected. A real
 * self-hosted endpoint is always one of those two.
 */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const looksLikeOrdinaryHost = (hostname) => {
  if (net.isIP(hostname)) return true;
  const lower = hostname.toLowerCase();
  // A bare integer or a hex/octal-looking label is an encoded address, not a hostname.
  if (/^[0-9]+$/.test(lower) || /^0x/i.test(lower)) return false;
  // Reject numeric-looking dotted forms that aren't valid IPs — `127.1`, `0177.0.0.1`.
  if (/^[0-9.]+$/.test(lower)) return false;
  return HOSTNAME_RE.test(lower);
};

/**
 * Parse and check an endpoint URL. No network I/O — see `assertSafeEndpoint` for the DNS half.
 *
 * @returns `{ ok: true, url }` with a normalised base URL, or `{ ok: false, error }`
 */
export const checkEndpointShape = (raw, source = ENDPOINT_SOURCE.OWNER) => {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "An endpoint URL is required" };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 300) return { ok: false, error: "That endpoint URL is too long" };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "That isn't a valid URL" };
  }

  const ownerSupplied = source === ENDPOINT_SOURCE.OWNER;

  /*
   * Scheme. `https` only for an owner-supplied URL — not for confidentiality alone, but because a
   * valid certificate for the hostname is itself evidence the host is a real public endpoint rather
   * than a private address behind a name.
   */
  if (ownerSupplied) {
    if (url.protocol !== "https:") {
      return { ok: false, error: "A custom endpoint must use https" };
    }
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "An endpoint must use http or https" };
  }

  /*
   * Credentials in the URL. `https://user:pass@host/` would have this server send someone else's
   * basic-auth header, and it is also the oldest way to disguise a hostname — everything before the
   * `@` is ignored by the resolver and read as the host by a person.
   */
  if (url.username || url.password) {
    return { ok: false, error: "The endpoint URL must not contain credentials" };
  }

  if (url.search || url.hash) {
    return { ok: false, error: "The endpoint URL must not have a query string or fragment" };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!looksLikeOrdinaryHost(hostname)) {
    return { ok: false, error: "That endpoint host isn't a valid name or address" };
  }

  /*
   * An IP literal on the owner path is checked here, without DNS — there is nothing to resolve, and
   * this is where `169.254.169.254` is stopped.
   */
  if (ownerSupplied && net.isIP(hostname) && isBlockedAddress(hostname)) {
    return { ok: false, error: "That endpoint address isn't reachable from a public network" };
  }

  /*
   * The normalised base. The path is kept — `/v1` matters, since Ollama serves its
   * OpenAI-compatible API under it — but a trailing slash is dropped so the adapter's `${base}/...`
   * never produces a double slash.
   */
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return { ok: true, url: base };
};

/**
 * The shape check plus DNS, for the moment before a request is made.
 *
 * Split from `checkEndpointShape` because they run at different times and one of them touches the
 * network: the shape check runs on save, and this runs again immediately before the call. Re-checking
 * is the point — a name that resolved publicly last week can resolve to `127.0.0.1` today, and a
 * validation that only happened at save time would have been permanently satisfied by whatever the
 * answer was then.
 *
 * @returns `{ ok: true, url, addresses }` or `{ ok: false, error }`
 */
export const assertSafeEndpoint = async (raw, source = ENDPOINT_SOURCE.OWNER) => {
  const shape = checkEndpointShape(raw, source);
  if (!shape.ok) return shape;

  // The operator's own network. They chose the address; there is no boundary to cross.
  if (source === ENDPOINT_SOURCE.OPERATOR) return { ...shape, addresses: [] };

  const hostname = new URL(shape.url).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) return { ...shape, addresses: [hostname] };

  let resolved;
  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    /*
     * Unresolvable is refused rather than allowed. A name we cannot check is a name we cannot
     * clear, and "it didn't resolve so it is probably fine" is how this kind of check gets bypassed
     * by a name that resolves only from inside the network.
     */
    return { ok: false, error: "That endpoint host could not be resolved" };
  }

  const addresses = resolved.map((entry) => entry.address);
  if (!addresses.length) {
    return { ok: false, error: "That endpoint host could not be resolved" };
  }

  /*
   * *Every* address, not the first. A name with both a public and a private record would otherwise
   * pass on the public one and connect to whichever the resolver returned at request time.
   */
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked) {
    return { ok: false, error: "That endpoint resolves to an address that isn't publicly reachable" };
  }

  return { ...shape, addresses };
};
