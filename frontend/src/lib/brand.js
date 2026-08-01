/**
 * The brand mark, as geometry rather than a component.
 *
 * Lives here because two very different renderers need it: the `Icons.logo`
 * component, and the profile QR code, which draws it into a cleared hole in the
 * middle of the matrix with its own transform. Keeping one copy means a future
 * logo change cannot leave the QR showing the old mark.
 */

/** The viewBox the paths below are authored against, as a square. */
export const LOGO_VIEWBOX = 48;

export const LOGO_PATHS = [
  "m41.51 34.81c8.24-10.4-.74-25.75-13.86-23.58-13.7-11.35-31.8 5.91-21.16 20.16l-1.4 4.28c-.28.76.54 1.55 1.28 1.25l4.73-1.66c2.81 1.5 6.13 2.01 9.26 1.52 4.26 3.89 11.35 4.79 16.53 1.9l4.73 1.66c.75.29 1.56-.5 1.28-1.25l-1.4-4.28zm-29.82-1.51c-.25-.15-.56-.17-.83-.08l-3.25 1.14.94-2.87c.11-.33.04-.7-.19-.96-9.36-11.44 4.51-26.83 16.83-18.68-9.44 3.11-13.08 15.38-6.61 23.1-2.39.09-4.82-.46-6.89-1.65zm25.44 3.34c-.27-.1-.58-.07-.83.08-1.91 1.1-4.1 1.68-6.32 1.68-6.99 0-12.68-5.69-12.68-12.68.7-16.82 24.67-16.82 25.37 0 0 3.02-1.08 5.94-3.04 8.24-.23.26-.3.63-.19.96l.94 2.87-3.25-1.14z",
  "m32.47 25.99c3.29-2.31 1.59-7.7-2.48-7.66-4.16 0-5.79 5.46-2.38 7.74-2.42.78-4.43 2.63-5.34 5.08l1.87.7c2.05-5.55 10.09-5.54 12.14 0l1.87-.7c-.96-2.56-3.11-4.45-5.68-5.17zm-2.48-5.66c2.95.08 2.95 4.4 0 4.48-2.95-.08-2.95-4.4 0-4.48z",
];
