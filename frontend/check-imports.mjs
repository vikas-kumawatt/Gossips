/*
 * Static checks the build would catch and ESLint doesn't.
 *
 * `npx vite build` can't run in this environment (the installed rollup binary is the
 * win32 one), so this stands in for the four ways this codebase has actually broken a
 * build: a relative import that doesn't resolve, a named import that isn't exported, JSX
 * in a `.js` file (Vite picks its loader by extension), and a capitalised JSX element
 * with nothing bound to that name — which the ESLint config can't see, because
 * `varsIgnorePattern: '^[A-Z_]'` hides unused component imports and there is no react
 * plugin for `jsx-no-undef`.
 *
 * Run from the frontend directory: node check-imports.mjs
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");
const EXTS = [".js", ".jsx", ".json", "/index.js", "/index.jsx"];

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(js|jsx)$/.test(entry.name) ? [full] : [];
  });

const files = walk(SRC);
const problems = [];

const resolve = (fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

const exportsOf = (file) => {
  const src = fs.readFileSync(file, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:const|let|var|function|async function|class)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  // `export { a, b as c }`
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(src)) names.add("default");
  if (/export\s*\*\s*from/.test(src)) names.add("*");
  return names;
};

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(SRC, file);

  // ── JSX must not live in a .js file ──────────────────────────────────────
  if (file.endsWith(".js") && /<[A-Za-z][^>]*>/.test(src.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    if (/return\s*\(?\s*</.test(src) || /=>\s*\(?\s*</.test(src)) {
      problems.push(`${rel}: looks like JSX in a .js file — Vite will not transform it`);
    }
  }

  const bound = new Set();

  /*
   * One import statement at a time.
   *
   * A single greedy regex over the whole file pairs each import clause with a *later*
   * module specifier, which produced 383 false positives the first time this ran.
   */
  for (const stmt of src.matchAll(/import\s+([^;]*?)\s*from\s*["']([^"']+)["']/g)) {
    const [, clause, spec] = stmt;

    for (const m of clause.matchAll(/(?:^|,)\s*(\w+)\s*(?:,|$)/g)) bound.add(m[1]);
    for (const m of clause.matchAll(/\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) bound.add(name);
      }
    }
    for (const m of clause.matchAll(/\*\s+as\s+(\w+)/g)) bound.add(m[1]);

    if (!spec.startsWith(".")) continue;

    const target = resolve(file, spec);
    if (!target) {
      problems.push(`${rel}: cannot resolve "${spec}"`);
      continue;
    }
    if (target.endsWith(".json")) continue;

    const available = exportsOf(target);
    if (available.has("*")) continue;
    for (const m of clause.matchAll(/\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name && !available.has(name)) {
          problems.push(
            `${rel}: "${name}" is not exported by ${path.relative(SRC, target)}`
          );
        }
      }
    }
  }

  // Locally declared names count as bound too.
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Z]\w*)/g)) bound.add(m[1]);
  for (const m of src.matchAll(/(\w+)\s*:\s*(?:function|\()/g)) bound.add(m[1]);

  // ── every capitalised JSX element must be bound ──────────────────────────
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of stripped.matchAll(/<([A-Z]\w*)(?:\.\w+)*[\s/>]/g)) {
    const name = m[1];
    if (!bound.has(name) && !["React", "Fragment"].includes(name)) {
      problems.push(`${rel}: <${name}> is used but nothing binds that name`);
    }
  }
}

if (problems.length) {
  console.error([...new Set(problems)].join("\n"));
  console.error(`\n${new Set(problems).size} problem(s) across ${files.length} file(s)`);
  process.exit(1);
}
console.log(
  `OK: ${files.length} file(s) — imports resolve, named exports exist, no JSX in .js, JSX bound`
);
