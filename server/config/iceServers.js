/**
 * ICE servers for WebRTC, built from the environment.
 *
 * A peer connection needs two things to reach someone behind a router:
 *
 *   STUN — tells a peer its own public address so the two can try to connect
 *          directly. Cheap, stateless, and enough on most home and office
 *          networks. Public servers are fine.
 *   TURN — relays the media when a direct path can't be established, which is
 *          the case for symmetric NAT: most mobile carriers, and strict
 *          corporate firewalls. Roughly one call in five needs it. It carries the
 *          actual audio and video, so it costs bandwidth and cannot be public.
 *
 * Shipping with STUN only is a deliberate, documented trade: calls work for most
 * people immediately and fail for some, and adding TURN later is configuration
 * rather than code. Set these and it starts being used on the next call, with no
 * deploy:
 *
 *   TURN_URLS       comma-separated, e.g.
 *                   turn:turn.example.com:3478,turns:turn.example.com:5349
 *   TURN_USERNAME   long-term credential username
 *   TURN_PASSWORD   long-term credential password
 *   STUN_URLS       optional override for the STUN list
 *
 * Credentials are only ever handed to an authenticated caller over the API — never
 * bundled into the client — because a TURN credential is a bandwidth bill.
 */

/*
 * Google's public STUN servers. Two, not one: STUN is a single UDP round trip and
 * a peer that can't reach the first should not have to wait out its timeout.
 */
const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

const splitList = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * @returns {{iceServers: Array, iceTransportPolicy: "all"|"relay"}}
 *   Shaped for `new RTCPeerConnection(config)`, so the client can pass it through
 *   unchanged rather than knowing how to assemble one.
 */
export const buildIceConfig = (env = process.env) => {
  const stunUrls = splitList(env.STUN_URLS);
  const iceServers = [{ urls: stunUrls.length ? stunUrls : DEFAULT_STUN_URLS }];

  const turnUrls = splitList(env.TURN_URLS);
  const username = env.TURN_USERNAME;
  const credential = env.TURN_PASSWORD;

  /*
   * All three or none. A TURN entry without credentials is not a degraded relay,
   * it is an entry every negotiation wastes time failing against — so an
   * incomplete configuration is treated as no configuration.
   */
  if (turnUrls.length && username && credential) {
    iceServers.push({ urls: turnUrls, username, credential });
  }

  return {
    iceServers,
    /*
     * `relay` forces every call through TURN, which is only for proving the relay
     * works — it costs bandwidth on calls that didn't need it. Off unless asked
     * for, and ignored entirely when there is no TURN to force traffic through.
     */
    iceTransportPolicy:
      env.ICE_FORCE_RELAY === "true" && turnUrls.length ? "relay" : "all",
  };
};

/** Whether a relay is configured, for diagnostics — never the credentials. */
export const hasTurn = (env = process.env) =>
  Boolean(splitList(env.TURN_URLS).length && env.TURN_USERNAME && env.TURN_PASSWORD);

export default buildIceConfig;
