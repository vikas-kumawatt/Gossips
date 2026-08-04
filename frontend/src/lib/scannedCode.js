import { parseProfileUrl } from "./profileLink";
import { parseGroupInviteToken } from "./groupLink";

/**
 * What a scanned QR code turns out to be.
 *
 * The scanner only understood profile URLs, so pointing it at a group's invite code —
 * which the app itself generates and offers to save and share — reported "That code
 * isn't a Gossips profile" and carried on scanning. Two kinds of code, one camera.
 *
 * A scanned code is untrusted text. Both parsers reject anything that isn't on this
 * origin, so nothing here can produce a destination on another site; the caller
 * navigates using the returned `username` or `token`, never the raw string.
 *
 * @returns `{ kind: "profile", username }`, `{ kind: "groupInvite", token }`, or null.
 */
export const parseScannedCode = (text) => {
  const username = parseProfileUrl(text);
  if (username) return { kind: "profile", username };

  /*
   * A URL, not a bare token.
   *
   * `parseGroupInviteToken` also accepts a bare token, because a person pasting a link
   * into a field may well paste just the token — but a camera has no such excuse, and a
   * bare base64url string is indistinguishable from a username. Without this, a printed
   * code reading "ana_1994" would be treated as an invite token and the join would 404
   * against something that never existed.
   */
  if (!/^https?:\/\//i.test(String(text || "").trim())) return null;

  const token = parseGroupInviteToken(text);
  if (token) return { kind: "groupInvite", token };

  return null;
};

/** Where a scanned code should take you. Null for anything unrecognised. */
export const scannedCodeRoute = (result) => {
  if (result?.kind === "profile") return `/${result.username}`;
  if (result?.kind === "groupInvite") return `/join/g/${result.token}`;
  return null;
};
