import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

/**
 * Module hooks that let `node --test` load this project's source directly.
 *
 * Node cannot parse JSX, and the alternative — a separate bundling step writing
 * to a temp directory before every run — means the thing under test is not the
 * file on disk. These hooks transform on import instead, with the same esbuild
 * that Vite already uses, so there is no new dependency and no second toolchain
 * whose configuration can drift from the real one.
 *
 * `import.meta.env` is replaced here rather than shimmed, because that is what
 * Vite does at build time: it is a compile-time substitution, not an object that
 * exists at runtime. `DEV: false` deliberately matches a production build, so a
 * test can assert that development-only branches really are gone.
 */

const DEFINE = {
  "import.meta.env.DEV": "false",
  "import.meta.env.PROD": "true",
  "import.meta.env.MODE": '"production"',
  "import.meta.env.VITE_SERVER": '"http://localhost:5000"',
};

const isSource = (url) => url.startsWith("file:") && /\.(jsx|mjs|js)$/.test(url);

// Test files are plain `.mjs` so Node's runner discovers them, but they contain
// JSX. The jsx loader is a superset of the js one, so applying it to everything
// under test/ and test-support/ is safe and saves a second extension convention.
const needsJsx = (url) => url.endsWith(".jsx") || /\/test(-support)?\//.test(url);

export async function load(url, context, nextLoad) {
  if (!isSource(url) || url.includes("/node_modules/")) {
    return nextLoad(url, context);
  }

  const source = await readFile(fileURLToPath(url), "utf8");
  const { code } = await transform(source, {
    loader: needsJsx(url) ? "jsx" : "js",
    jsx: "automatic",
    format: "esm",
    target: "node22",
    sourcefile: url,
    define: DEFINE,
  });

  return { format: "module", shortCircuit: true, source: code };
}

/**
 * Extensionless and CSS imports.
 *
 * A component importing "../lib/utils" resolves under Vite but not under Node,
 * and one importing a stylesheet would make Node try to parse CSS as a module.
 * Neither is worth making every test care about.
 */
export async function resolve(specifier, context, nextResolve) {
  if (/\.(css|scss|png|jpe?g|svg|webp|woff2?)$/.test(specifier)) {
    return { url: new URL("./empty-module.mjs", import.meta.url).href, shortCircuit: true };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".")) throw error;
    for (const extension of [".jsx", ".js", "/index.jsx", "/index.js"]) {
      try {
        return await nextResolve(specifier + extension, context);
      } catch {
        // Try the next candidate; rethrow the original if none resolve.
      }
    }
    throw error;
  }
}
