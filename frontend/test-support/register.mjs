import { register } from "node:module";
import { JSDOM } from "jsdom";

/**
 * Test bootstrap: a DOM, then the JSX module hooks.
 *
 * Loaded with `--import` so both are in place before any test module is
 * evaluated. Order matters — React reads `document` while it initialises, so the
 * DOM has to exist before the first import, not before the first test.
 *
 * jsdom is already a devDependency (the build smoke test uses it) and esbuild
 * arrives with Vite, so this adds no packages. That is deliberate: a test setup
 * is not worth a second toolchain to keep in step with the first.
 */

register("./jsx-hooks.mjs", import.meta.url);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://gossips.test/",
  pretendToBeVisual: true,
});

/*
 * The globals a browser has and Node does not.
 *
 * Named explicitly rather than copied wholesale from `dom.window`: assigning
 * every jsdom property over the Node globals replaces things Node owns —
 * `performance` in particular, which jsdom implements in terms of itself and
 * which recurses until the stack runs out when reassigned.
 */
const BROWSER_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "SVGElement",
  "SVGSVGElement",
  "Element",
  "Node",
  "DocumentFragment",
  "DOMRect",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "localStorage",
  "sessionStorage",
];

for (const name of BROWSER_GLOBALS) {
  const value = dom.window[name];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

Object.defineProperty(globalThis, "self", {
  value: dom.window,
  writable: true,
  configurable: true,
});

// Not implemented by jsdom; framer-motion and several components call them.
const noopObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
for (const name of ["ResizeObserver", "IntersectionObserver"]) {
  if (!globalThis[name]) globalThis[name] = noopObserver;
  if (!dom.window[name]) dom.window[name] = noopObserver;
}

const matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
globalThis.matchMedia = matchMedia;
dom.window.matchMedia = matchMedia;

/*
 * React refuses to run `act` without this, and warns loudly on every state
 * update outside one if it is unset.
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
