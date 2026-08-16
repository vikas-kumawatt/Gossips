import crypto from "crypto";
import { signFor } from "./signingSecret.js";

/**
 * A short signature over an uploaded attachment's identity.
 *
 * The upload endpoint derives an attachment's `type` from the file it actually
 * received. The send path then took that type back from the client and trusted
 * it — so relabelling a PDF as an image was enough to walk past a group's
 * `mediaSharing: false` rule, and any URL at all could be passed off as an
 * upload. The server has no way to re-derive the type from a URL without going
 * back to Cloudinary, so instead it signs what it decided and checks the
 * signature on the way back in.
 *
 * This is an integrity check, not a capability: the token says "this server
 * produced this descriptor", nothing about who may send it.
 */

/*
 * Versioned, and part of the signed input — see utils/signingSecret.js for why
 * the domain is there at all. Bumping the version invalidates every outstanding
 * token, which for this one is a window of seconds: a token is minted by the
 * upload response and spent by the send that immediately follows it.
 *
 * v1 covered only (url, type, fileSize). v2 widened the field list but joined
 * them with a delimiter that one of those fields could contain — see `payload`.
 */
const DOMAIN = "media:v3";

/**
 * Every field the upload endpoints derive, and nothing else.
 *
 * v1 signed three of them. The rest — `thumbnail`, `filename`, `duration`,
 * `dimensions`, `waveform` — were returned by the server, echoed by the client
 * and then stored unverified, so a caller could keep a valid token and rewrite
 * them: point `thumbnail` at any URL it liked (it is rendered as an image, and
 * for a video message it is the only thing rendered before playback), claim any
 * `duration`, or supply a `filename` of its choosing. None of that is caught by
 * `messageContent.js`, which validates `url` and `type` and passes the rest
 * through.
 *
 * This covers uploads only. A `gif` item short-circuits `verifyMedia` entirely
 * in `messageContent.js` — there is no upload behind it to have signed — so its
 * `thumbnail` remains client-chosen, bounded by the Giphy host allow-list below
 * rather than by a signature.
 *
 * An explicit list rather than "every key on the object", because the message
 * schema also carries fields the *client* legitimately sets — `caption`,
 * `isSpoiler` — and signing those would make the token depend on values the
 * server never chose. Server-derived fields are signed; client-chosen fields
 * are validated elsewhere or not trusted at all.
 */
const SIGNED_FIELDS = [
  "url",
  "type",
  "fileSize",
  "thumbnail",
  "filename",
  "duration",
  "dimensions",
  "waveform",
];

/**
 * Normalise one field to a JSON-stable shape.
 *
 * Absent and null collapse to the same thing, so a client dropping a null field
 * on the round trip doesn't invalidate an otherwise honest descriptor. Objects
 * are flattened positionally rather than serialised by key, because key order in
 * a JSON round trip is not something to depend on. Numbers become strings
 * because `String(n)` and JSON both emit the shortest round-tripping form, so
 * `12` and `12` agree across the wire while `12` and `"12"` are not worth
 * distinguishing.
 */
const normalise = (value) => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    // The only object shape here is `dimensions`. Named explicitly so a new one
    // has to be considered rather than silently serialising in key order.
    return [normalise(value.width), normalise(value.height)];
  }
  return String(value);
};

/**
 * The signed string.
 *
 * `JSON.stringify` over the normalised tuple, not a delimiter join — and that is
 * the whole point rather than a stylistic preference.
 *
 * Joining fields with `\n` and array elements with `,` is not injective as soon
 * as any signed field can contain those characters, and one of them can:
 * `filename` is `req.file.originalname`, a multipart parameter the uploader
 * writes. A file named `x\n9` produced the same joined payload as an honest
 * `filename: "x"` with `duration: 9` — so a client holding a real token could
 * shift values across field boundaries and have the signature still check out,
 * which defeats exactly the fields this version was widened to cover.
 *
 * JSON quotes and escapes each element, so a newline inside a value can never be
 * read as the separator between two values. Nesting is bracketed for the same
 * reason: `["0.1","0.2"]` and `["0.1,0.2"]` are now distinct, where the joined
 * form collapsed them.
 */
const payload = (descriptor) =>
  JSON.stringify(SIGNED_FIELDS.map((field) => normalise(descriptor?.[field])));

export const signMedia = (descriptor) => signFor(DOMAIN, payload(descriptor));

/**
 * Timing-safe compare. Returns false for anything unsigned or altered.
 */
export const verifyMedia = (descriptor) => {
  const provided = descriptor?.token;
  if (typeof provided !== "string" || !provided) return false;

  const expected = signMedia(descriptor);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/** The token is server bookkeeping; it doesn't belong on the stored message. */
export const stripMediaToken = ({ token, ...rest }) => rest;

/**
 * GIFs are the one attachment that never passes through an upload, so there is
 * nothing to have signed. They're hotlinked straight from the picker, and the
 * same allow-list the post composer uses (utils/attachments.js) is what makes
 * that safe: only a Giphy host over https, never an arbitrary URL.
 */
const GIF_HOSTS = new Set([
  "media.giphy.com",
  "i.giphy.com",
  "media0.giphy.com",
  "media1.giphy.com",
  "media2.giphy.com",
  "media3.giphy.com",
  "media4.giphy.com",
]);

export const isAllowedGif = (item) => {
  if (item?.type !== "gif" || typeof item.url !== "string") return false;
  try {
    const url = new URL(item.url);
    return url.protocol === "https:" && GIF_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};
