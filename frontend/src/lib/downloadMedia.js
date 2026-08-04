/**
 * Save a chat attachment to the device without leaving the conversation.
 *
 * The `download` attribute on an anchor is ignored for cross-origin URLs — every
 * browser treats it as a same-origin-only hint. Chat media is served from
 * Cloudinary, so the document bubble's `<a href={url} download={filename}>` has
 * never actually downloaded anything: it navigates to the file instead, which on
 * mobile drops the user out of the thread onto a bare media URL.
 *
 * Fetching to a blob first makes the URL same-origin (an object URL), which is
 * what makes `download` bind. The cost is holding the file in memory for the
 * length of the save, which is bounded by the composer's 50MB cap.
 */

/** Anchor-click save. Extracted because both the blob and the fallback path need it. */
const save = (href, filename) => {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
};

/**
 * Cloudinary's own force-download flag, used when the blob fetch is refused.
 *
 * `fl_attachment` makes the CDN answer with `Content-Disposition: attachment`, so
 * the navigation downloads and the page we're on is left alone. Only correct for
 * Cloudinary delivery URLs, hence the shape check rather than a blind rewrite.
 */
const withCloudinaryAttachment = (url) => {
  if (!/\/(image|video|raw)\/upload\//.test(url)) return null;
  if (url.includes("fl_attachment")) return url;
  return url.replace(/\/upload\//, "/upload/fl_attachment/");
};

/** Best guess at a filename when the media descriptor carries none. */
const filenameFromUrl = (url, fallbackExt = "") => {
  try {
    const { pathname } = new URL(url, window.location.origin);
    const base = pathname.split("/").filter(Boolean).pop();
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return decodeURIComponent(base);
    if (base) return `${decodeURIComponent(base)}${fallbackExt}`;
  } catch {
    // Malformed URL — fall through to the generic name.
  }
  return `download${fallbackExt}`;
};

const EXT_BY_TYPE = {
  image: ".jpg",
  gif: ".gif",
  video: ".mp4",
  audio: ".webm",
  voice: ".webm",
  sticker: ".webp",
};

/**
 * @param {{url: string, type?: string, filename?: string}} item A message media descriptor.
 * @returns {Promise<void>} Resolves once the save has been handed to the browser.
 *   Rejects only when neither the blob nor the Cloudinary path is available, so
 *   callers can surface a toast.
 */
export const downloadMedia = async (item) => {
  if (!item?.url) throw new Error("Nothing to download");

  const filename = item.filename || filenameFromUrl(item.url, EXT_BY_TYPE[item.type] || "");

  try {
    const response = await fetch(item.url, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`Download ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    save(objectUrl, filename);
    /*
     * Deferred revoke. Revoking synchronously after `click()` cancels the save in
     * Safari, which reads the blob asynchronously — the same reason
     * ShareProfileSheet's QR download waits before releasing its URL.
     */
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    return;
  } catch {
    // CORS refusal, an offline tab, or a file large enough to fail allocation.
    // The CDN can still do the work server-side.
  }

  const attachmentUrl = withCloudinaryAttachment(item.url);
  if (!attachmentUrl) throw new Error("Download failed");
  save(attachmentUrl, filename);
};

export default downloadMedia;
