import { buildProfileQrSvg } from "./profileQr";

/**
 * Save a QR code as a PNG.
 *
 * Lifted out of ShareProfileSheet so the group invite sheet saves its code the same
 * way — including the Safari fallback, which is the part nobody would have remembered
 * to copy.
 *
 * `caption` is the line rendered under the code inside the image; `filename` is the
 * download name without an extension. They were one `username` argument before, which
 * is fine for a profile and wrong for anything else.
 */

/** Target size of the saved PNG's longest edge. */
const DOWNLOAD_WIDTH = 1080;

/**
 * Rasterise the QR to a PNG.
 *
 * The SVG is pure inline geometry — no <image>, no web font — so drawing it to a
 * canvas leaves the canvas untainted and `toBlob` works. A remote logo would
 * make this throw a security error instead.
 */
export const downloadQrPng = async ({ value, caption, filename }) => {
  const svg = buildProfileQrSvg({ value, username: caption });
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));

  // `downloadName`, not `filename` — the outer parameter is called that and shadowing
  // it here makes the two call sites below look like they're using this one.
  const save = (href, downloadName) => {
    const link = document.createElement("a");
    link.href = href;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("svg failed to load"));
      image.src = svgUrl;
    });

    const scale = DOWNLOAD_WIDTH / (image.width || DOWNLOAD_WIDTH);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((image.width || DOWNLOAD_WIDTH) * scale);
    canvas.height = Math.round((image.height || DOWNLOAD_WIDTH) * scale);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("toBlob returned nothing");

    const pngUrl = URL.createObjectURL(blob);
    save(pngUrl, `${filename}.png`);
    // Revoked on the next tick: revoking synchronously can cancel the download
    // in Safari before it starts.
    setTimeout(() => URL.revokeObjectURL(pngUrl), 10_000);
  } catch {
    /*
     * Some older Safari builds won't rasterise an SVG through an <img> reliably.
     * The vector file is the same code and scans just as well, so save that
     * rather than failing outright.
     */
    save(svgUrl, `${filename}.svg`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(svgUrl), 10_000);
  }
};
