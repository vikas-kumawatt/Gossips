import crypto from "crypto";

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
 * produced this (url, type, size) triple", nothing about who may send it.
 */

const SECRET = () => process.env.JWT_SECRET || "";

const payload = ({ url, type, fileSize }) =>
  `${url}\n${type || ""}\n${fileSize ?? ""}`;

export const signMedia = (descriptor) =>
  crypto.createHmac("sha256", SECRET()).update(payload(descriptor)).digest("base64url");

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
