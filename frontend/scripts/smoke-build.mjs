/**
 * Load the production bundle and see whether it survives being evaluated.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `vite build` exiting 0 says the bundle was *written*, not that it *runs*. A vendor-chunk
 * split once passed the build, deployed, and white-screened every visitor with
 *
 *   Uncaught TypeError: Cannot read properties of undefined (reading 'memo')
 *
 * because a CommonJS package's top-level code ran before the chunk holding React had been
 * evaluated. Nothing about that is visible in the build output: no warning, no cycle in the
 * import graph, exit code 0.
 *
 * The one thing that catches it is executing the entry module. Every error of that family —
 * "Cannot read properties of undefined", "Cannot access before initialization" — happens while
 * modules initialise, which is before any of this needs a real browser.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 *
 * Not a test of the app. jsdom is not a browser: there is no layout, no network, no service
 * worker, and plenty of the app will bail once it starts touching those. That is fine and
 * expected — the question being asked is only "do the modules load and does React mount", and
 * anything after the first paint is out of scope. Failures that occur *inside* React rendering
 * are reported separately from module-load failures for exactly that reason.
 *
 * Usage: node scripts/smoke-build.mjs   (after a build; exits non-zero on a load failure)
 */
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const DIST = resolve("dist");

const entryFromHtml = () => {
  const html = readFileSync(resolve(DIST, "index.html"), "utf8");
  const match = /<script[^>]+src="\/(assets\/[^"]+\.js)"/.exec(html);
  if (!match) throw new Error("no module script found in dist/index.html");
  return match[1];
};

const dom = new JSDOM(
  `<!doctype html><html><body><div id="root"></div></body></html>`,
  { url: "https://gossips.test/", pretendToBeVisual: true }
);

/*
 * Only what a module needs to *initialise*. Deliberately not a browser shim library: the more
 * this fakes, the further past the point of interest it runs, and the more likely a failure
 * here is a jsdom gap rather than a real one.
 */
const { window } = dom;

/*
 * `defineProperty` rather than assignment. Node 22 defines `navigator` and `location` on
 * `globalThis` as getter-only accessors, so a plain `globalThis.navigator = …` throws before
 * the bundle is ever reached.
 */
const expose = (name, value) => {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};

for (const name of [
  "document",
  "navigator",
  "location",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  if (window[name] !== undefined) expose(name, window[name]);
}
expose("window", window);
expose("self", window);

for (const name of ["IntersectionObserver", "ResizeObserver", "MutationObserver"]) {
  if (!window[name]) {
    window[name] = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
  expose(name, window[name]);
}
window.matchMedia ??= () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
expose("matchMedia", window.matchMedia);
window.scrollTo ??= () => {};

// jsdom has these on `window` but Node does not put them on `globalThis`, and bundled code
// reads them bare. Without them the app throws before it can mount, which would hide whatever
// this script is actually looking for.
for (const name of ["localStorage", "sessionStorage"]) {
  if (window[name]) expose(name, window[name]);
}
if (!globalThis.fetch) {
  expose("fetch", async () => {
    throw new Error("network disabled in smoke test");
  });
}

/*
 * Errors thrown inside React's render are reported to `window.onerror` rather than propagating
 * out of the import, so they have to be collected rather than caught.
 */
const runtimeErrors = [];
window.addEventListener("error", (event) => runtimeErrors.push(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => runtimeErrors.push(event.reason));

const entry = entryFromHtml();
const chunks = readdirSync(resolve(DIST, "assets")).filter((f) => f.endsWith(".js"));

console.log(`entry:  ${entry}`);
console.log(`chunks: ${chunks.length}`);

try {
  await import(pathToFileURL(resolve(DIST, entry)).href);
} catch (error) {
  console.error("\n✖ the bundle threw while loading — this is the failure mode being tested\n");
  console.error(error);
  process.exit(1);
}

// One turn of the loop, so anything React scheduled has a chance to run and fail.
await new Promise((r) => setTimeout(r, 300));

const mounted = window.document.getElementById("root")?.childElementCount > 0;

/*
 * Two signatures, and deliberately only two.
 *
 * This script gates a deploy, so a false positive is a site that cannot ship. Anything vaguer
 * — "x is not a function", a refused fetch, a missing browser API — is far more likely to be
 * jsdom lacking something than a real fault, so it is printed and ignored. These two are what
 * a bad chunk split actually produces, and almost nothing else does.
 *
 * The decisive case isn't even here: a module-scope failure throws out of the `import` above
 * and is caught there. This only covers the same error surfacing later, from inside a render.
 */
const initFailures = runtimeErrors.filter((error) =>
  /Cannot read properties of undefined|Cannot access '[^']*' before initialization/.test(
    String(error?.message ?? error)
  )
);

console.log(`mounted: ${mounted ? "yes" : "no"}`);
if (runtimeErrors.length) {
  console.log(`\nruntime noise after load (${runtimeErrors.length}):`);
  for (const error of runtimeErrors.slice(0, 5)) {
    console.log("  -", String(error?.message ?? error).slice(0, 160));
  }
}

if (initFailures.length) {
  console.error("\n✖ initialisation errors of the kind a bad chunk split produces:");
  for (const error of initFailures) console.error("  -", String(error?.message ?? error));
  process.exit(1);
}

console.log("\n✓ the bundle loads and initialises");
