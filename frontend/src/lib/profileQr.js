import qrcode from "qrcode-generator";
import { LOGO_PATHS, LOGO_VIEWBOX } from "./brand";

/**
 * Geometry for a profile QR code, in the app's existing dot style.
 *
 * Pure — no JSX, no DOM. The on-screen SVG and the downloaded PNG are both built
 * from this one description, so what someone saves is what they were looking at.
 *
 * The style (round dots, rounded finder rings) matches DotQRCode, the decorative
 * code on the auth screen. That one is a hardcoded 25×25 matrix for the homepage;
 * this is generated, so every measurement here derives from the module count
 * instead — a longer username produces a denser code and it still lines up.
 */

const VBOX = 1024;
// The spec's quiet zone. Scanners use it to find the code's edge, and the
// decorative sibling's ~1.7 modules is below what a real scan wants.
const QUIET_MODULES = 4;

/*
 * Modules are rounded squares, not circles, and both numbers below are measured
 * rather than chosen — decoding every profile URL at a range of render scales
 * with jsQR, which is also the scanner's own fallback decoder.
 *
 * Corner radius: fine up to 0.30 of a module, degrading above it, down to 26/35
 * at 0.50 — a true circle. Fully separate circles leave each module isolated,
 * and the run-length continuity a decoder needs to estimate the grid goes with
 * them.
 *
 * Fill: how much of its cell a module occupies. Anything under 1.0 leaves air
 * between neighbours so the code doesn't read as one solid mass, but the budget
 * is small — 0.95 decodes 40/40, 0.90 drops to 35/40 and 0.80 to 15/40. So this
 * is the lightest the modules can be drawn while still scanning every time.
 */
const MODULE_RADIUS_RATIO = 0.25;
const MODULE_FILL = 0.95;

/*
 * Error correction level, which is also the density dial: it decides how many
 * modules the same URL needs. H (~30% recovery) puts a profile URL at 37×37,
 * Q (~25%) at 33×33 — a code with visibly larger, less crowded modules.
 *
 * The logo hole clears roughly 5.8% of the modules, so Q still leaves ~19% of
 * recovery spare for glare, camera angle and a partly covered code. L is the one
 * level that can't take the hole at all: measured, it decodes 0/6 with it and
 * 6/6 without.
 */
const ERROR_CORRECTION = "Q";

/** Share of the code's width taken by the logo hole. */
const LOGO_WIDTH_RATIO = 0.24;

const isFinderModule = (row, col, count) => {
  if (row <= 6 && col <= 6) return true;
  if (row <= 6 && col >= count - 7) return true;
  if (row >= count - 7 && col <= 6) return true;
  return false;
};

/** Rounded-square ring, drawn as one evenodd path so the middle stays open. */
const finderRingPath = (ox, oy, cell) => {
  const outer = 7 * cell;
  const outerRadius = outer * 0.357;
  const inset = cell;
  const inner = 5 * cell;
  const innerRadius = inner * 0.3;

  const square = (x, y, size, r) =>
    `M ${x} ${y + r} v ${size - 2 * r} a ${r} ${r} 0 0 0 ${r} ${r} h ${size - 2 * r} ` +
    `a ${r} ${r} 0 0 0 ${r} ${-r} v ${-(size - 2 * r)} a ${r} ${r} 0 0 0 ${-r} ${-r} ` +
    `h ${-(size - 2 * r)} a ${r} ${r} 0 0 0 ${-r} ${r} Z`;

  return `${square(ox, oy, outer, outerRadius)} ${square(
    ox + inset,
    oy + inset,
    inner,
    innerRadius
  )}`;
};

/** The 3×3 centre of a finder pattern. */
const finderDotPath = (ox, oy, cell) => {
  const size = 3 * cell;
  const x = ox + 2 * cell;
  const y = oy + 2 * cell;
  const r = size * 0.296;

  return (
    `M ${x} ${y + r} v ${size - 2 * r} a ${r} ${r} 0 0 0 ${r} ${r} h ${size - 2 * r} ` +
    `a ${r} ${r} 0 0 0 ${r} ${-r} v ${-(size - 2 * r)} a ${r} ${r} 0 0 0 ${-r} ${-r} ` +
    `h ${-(size - 2 * r)} a ${r} ${r} 0 0 0 ${-r} ${r} Z`
  );
};

/**
 * @param {string} value  What the code encodes — a profile URL.
 * @returns {{ size, modules, finders, logo, moduleCount }}
 */
export const buildProfileQr = (value) => {
  // Type 0 asks the encoder to pick the smallest version that fits.
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const cell = VBOX / (moduleCount + QUIET_MODULES * 2);
  const margin = QUIET_MODULES * cell;
  // Drawn slightly inside its cell and centred, which is what puts the gap
  // between neighbouring modules.
  const drawn = cell * MODULE_FILL;
  const inset = (cell - drawn) / 2;
  const radius = drawn * MODULE_RADIUS_RATIO;

  /*
   * The hole is measured in whole modules and centred, so it clears complete
   * modules rather than clipping a ring of half ones. An odd span keeps it
   * symmetric about the middle module.
   */
  let holeModules = Math.round(moduleCount * LOGO_WIDTH_RATIO);
  if (holeModules % 2 !== moduleCount % 2) holeModules += 1;
  const holeStart = Math.floor((moduleCount - holeModules) / 2);
  const holeEnd = holeStart + holeModules - 1;

  const isInLogoHole = (row, col) =>
    row >= holeStart && row <= holeEnd && col >= holeStart && col <= holeEnd;

  const modules = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (!qr.isDark(row, col)) continue;
      if (isFinderModule(row, col, moduleCount)) continue;
      if (isInLogoHole(row, col)) continue;
      modules.push({
        x: margin + col * cell + inset,
        y: margin + row * cell + inset,
        size: drawn,
        r: radius,
      });
    }
  }

  const finders = [
    [margin, margin],
    [margin + (moduleCount - 7) * cell, margin],
    [margin, margin + (moduleCount - 7) * cell],
  ].map(([x, y]) => ({
    ring: finderRingPath(x, y, cell),
    dot: finderDotPath(x, y, cell),
  }));

  // Inset by a module so the mark doesn't touch the dots around the hole.
  const holeSize = holeModules * cell;
  const logoSize = holeSize - cell * 1.2;
  const logoOrigin = margin + holeStart * cell + (holeSize - logoSize) / 2;
  const logo = {
    paths: LOGO_PATHS,
    transform: `translate(${logoOrigin} ${logoOrigin}) scale(${logoSize / LOGO_VIEWBOX})`,
  };

  return { size: VBOX, moduleCount, modules, finders, logo };
};

/**
 * The same code as a standalone SVG document, for rasterising into a PNG.
 *
 * Everything is inline geometry — no external image, no web font — which is what
 * keeps the canvas untainted when the PNG is drawn. Pulling the logo in as an
 * <img> from a URL would make toDataURL throw a security error instead.
 */
export const buildProfileQrSvg = ({
  value,
  username,
  background = "#0a0a0a",
  foreground = "#ffffff",
}) => {
  const qr = buildProfileQr(value);
  const pad = qr.size * 0.09;
  const labelBand = qr.size * 0.2;
  const width = qr.size + pad * 2;
  const height = qr.size + pad * 2 + labelBand;

  const modules = qr.modules
    .map(
      (m) =>
        `<rect x="${m.x.toFixed(2)}" y="${m.y.toFixed(2)}" width="${m.size.toFixed(2)}" ` +
        `height="${m.size.toFixed(2)}" rx="${m.r.toFixed(2)}"/>`
    )
    .join("");
  const finders = qr.finders
    .map(
      (f) =>
        `<path d="${f.ring}" fill-rule="evenodd"/><path d="${f.dot}"/>`
    )
    .join("");
  const logo = qr.logo.paths
    .map((d) => `<path d="${d}"/>`)
    .join("");

  const safeUsername = String(username || "").replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" rx="${qr.size * 0.06}" fill="${background}"/>
<g transform="translate(${pad} ${pad})" fill="${foreground}">${modules}${finders}<g transform="${qr.logo.transform}">${logo}</g></g>
<text x="${width / 2}" y="${qr.size + pad + labelBand * 0.55}" fill="${foreground}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="${qr.size * 0.062}" font-weight="600" text-anchor="middle">@${safeUsername}</text>
</svg>`;
};
