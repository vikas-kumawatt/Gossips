import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * This file's own directory, rather than `process.cwd()`.
 *
 * The project root is where this config lives, not wherever npm happened to be
 * invoked from — `npm --prefix frontend run dev` and `cd frontend && vite` agree
 * today, but a build run from the repository root would not. It also keeps the
 * config free of `process`, which the browser-globals ESLint config flags.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Files in `public/` that carry `__PLACEHOLDER__` tokens, with the MIME type to
 * serve them as in dev. `_headers` is read by Netlify at deploy time and never
 * requested by a browser, so its dev entry only matters for inspection.
 */
const TEMPLATED_PUBLIC_FILES = {
  "firebase-messaging-sw.js": "application/javascript",
  _headers: "text/plain",
};

/**
 * Substitute environment values into static files under `public/`.
 *
 * Vite copies `public/` verbatim and never applies `import.meta.env` to it,
 * which is why two things ended up hardcoded that should not have been: the
 * push service worker's Firebase project (it cannot read `import.meta.env` at
 * all — a service worker is not a module, and moving it out of `public/` would
 * put it under hashed `/assets/` where it could no longer control the app), and
 * the API origin inside the Content-Security-Policy.
 *
 * Both keep `__TOKEN__` placeholders and are filled in here. Two paths, because
 * `public/` is served from disk in dev and copied to `dist/` on build:
 *
 *   dev    — a middleware answers the request with the substituted text
 *   build  — `closeBundle` rewrites the emitted copy
 *
 * `loadEnv(mode, root, "")` rather than `process.env`, so `.env`, `.env.<mode>`
 * and the rest are read exactly as they are for the client bundle — these files
 * cannot end up configured differently from the app they belong to.
 *
 * An unset variable leaves its placeholder untouched rather than emitting an
 * empty string, so the result is visibly unconfigured rather than subtly wrong.
 * The service worker checks for that and stays inert.
 */
const publicFileEnv = (mode) => {
  const env = loadEnv(mode, ROOT, "");

  /*
   * Derived, because a CSP needs an origin and `VITE_SERVER` may carry a path,
   * and because Socket.IO's `wss://` form is a separate connect-src entry that
   * the `https://` one does not cover.
   */
  const derived = {};
  try {
    const api = new URL(env.VITE_SERVER);
    derived.__API_ORIGIN__ = api.origin;
    derived.__API_WS_ORIGIN__ = `${api.protocol === "http:" ? "ws:" : "wss:"}//${api.host}`;
  } catch {
    // VITE_SERVER unset or malformed. Leave both placeholders in place; the app
    // has no API to talk to either way, and a silently permissive CSP is worse
    // than an obviously broken one.
  }

  /*
   * `||`, not `??`. `loadEnv` returns "" for a variable that is present but
   * empty, and `??` would substitute that empty string — which looks configured
   * to every downstream check while being nothing at all. An empty value is
   * treated as unset, so the placeholder survives and the consumer can see it.
   */
  const substitute = (source) =>
    source.replace(/__[A-Z0-9_]+__/g, (token) => derived[token] || env[token.slice(2, -2)] || token);

  const read = (dir, file) => {
    const full = path.resolve(ROOT, dir, file);
    return fs.existsSync(full) ? { full, text: fs.readFileSync(full, "utf8") } : null;
  };

  return {
    name: "public-file-env",

    /*
     * No `enforce`, and that matters. vite-plugin-pwa declares `enforce: "post"`
     * and builds its precache manifest in `closeBundle`; Vite runs normal-phase
     * plugins before post-phase ones, so the substitution below lands before the
     * manifest is computed and the recorded revision hash matches the bytes
     * actually shipped. Giving this plugin `enforce: "post"` and listing it
     * after VitePWA would silently invert that and precache a stale hash.
     */
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0]?.replace(/^\//, "");
        if (!name || !(name in TEMPLATED_PUBLIC_FILES)) return next();
        const found = read("public", name);
        if (!found) return next();
        res.setHeader("Content-Type", TEMPLATED_PUBLIC_FILES[name]);
        // A service worker update is decided by byte comparison against the
        // cached copy; caching it would hide a config change indefinitely.
        res.setHeader("Cache-Control", "no-cache");
        res.end(substitute(found.text));
      });
    },

    closeBundle() {
      for (const name of Object.keys(TEMPLATED_PUBLIC_FILES)) {
        const found = read("dist", name);
        if (found) fs.writeFileSync(found.full, substitute(found.text));
      }
    },
  };
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    publicFileEnv(mode),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Gossips",
        short_name: "Gossips",
        description: "Chat and connect with your friends on Gossips.",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        /*
         * Runtime caching, for cross-origin assets only.
         *
         * The precache covers the app shell. These cover the things the shell
         * then requests from somewhere else, which is where the repeat-visit
         * cost actually is — the same avatar and the same post image are fetched
         * on every visit otherwise.
         *
         * ── What is deliberately absent ────────────────────────────────────
         *
         * Every API response. `/posts/feed`, `/chats`, `/user/:username` and the
         * rest are per-account and auth-scoped, and a service worker cache is
         * keyed by URL and shared across everyone who uses this browser profile.
         * Caching them would mean one account's feed being served to the next
         * account signed in on the same device — and `GET /chats` is explicitly
         * marked `no-store` by the server for exactly that reason. The IndexedDB
         * layers in src/utils already give warm-start rendering, scoped per user
         * id and always revalidated, which is the correct place for that.
         */
        runtimeCaching: [
          {
            /*
             * Uploaded media. CacheFirst because a Cloudinary URL is
             * content-addressed in practice — the public id changes when the
             * asset does — so a cached response cannot go stale, only unused.
             */
            urlPattern: ({ url }) => url.hostname === "res.cloudinary.com",
            handler: "CacheFirst",
            options: {
              cacheName: "gossips-media",
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              // Opaque cross-origin responses are cached as errors otherwise.
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // GIFs are hotlinked from Giphy and never uploaded, so they miss the
            // rule above. Shorter and smaller: a picker session can pull dozens.
            urlPattern: ({ url }) => url.hostname.endsWith(".giphy.com"),
            handler: "CacheFirst",
            options: {
              cacheName: "gossips-gifs",
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Google account avatars, copied onto the user record at sign-in.
            urlPattern: ({ url }) => url.hostname === "lh3.googleusercontent.com",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "gossips-avatars",
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],

  build: {
    rollupOptions: {
      output: {
        /*
         * Split the vendor bundle, because one file had grown past a hard limit.
         *
         * ── What actually broke ─────────────────────────────────────────────
         *
         * Everything landed in a single `index-*.js` of 2,122,913 bytes. Workbox refuses to
         * precache a file over 2 MiB (2,097,152), and `vite-plugin-pwa` treats that refusal as
         * a build error — so the deploy failed by 26 KB. Raising
         * `maximumFileSizeToCacheInBytes` would have made it pass and would have failed again
         * on the next feature, a little further along.
         *
         * ── What this does and does not fix ─────────────────────────────────
         *
         * Splitting by package fixes the *per-file* limit with a wide margin, which is the
         * deploy blocker. It does **not** reduce what a first visit downloads: these are
         * static imports, so the browser fetches every one of them at startup regardless of
         * which file they live in. Cutting the initial payload needs `React.lazy` on the
         * routes nobody visits — the admin panel especially — and that is a change to the app
         * rather than to its build.
         *
         * What it does buy, beyond the limit: these chunks change far less often than app
         * code, so a returning visitor re-downloads only the small entry chunk after a deploy
         * instead of two megabytes.
         *
         * ── One vendor chunk, and why not a per-package split ───────────────
         *
         * The first attempt at this named each heavy package — `react`, `firebase`, `emoji`,
         * `motion`, `qr` and so on — to keep every chunk small. It built cleanly, deployed,
         * and white-screened on load:
         *
         *   Uncaught TypeError: Cannot read properties of undefined (reading 'memo')
         *
         * A package in `vendor` was calling `React.memo(...)` while evaluating, with `React`
         * still undefined. The emitted chunk graph showed why: it contained `react -> qr`,
         * which is nonsense as a dependency and is the fingerprint of rollup's CommonJS
         * interop helpers being scattered. Several of these packages are CJS, so `React` does
         * not arrive by a plain ESM import — it comes through a generated proxy module, and
         * once those proxies and the real module land in different chunks, whether `React` is
         * initialised by the time a consumer's top-level code runs is down to the order the
         * browser happens to evaluate the chunks in. There was no import cycle to find; the
         * split itself was the fault.
         *
         * So: every dependency in one chunk. Rollup then orders them within it, which it has
         * always been able to do correctly, and no consumer can be evaluated before React.
         * This is the same rule Vite's own retired `splitVendorChunkPlugin` followed.
         *
         * It is less tidy than eight named chunks and it is the one that works. If a single
         * vendor chunk ever approaches the limit again, the answer is `React.lazy` on the
         * routes that pull the weight — not another attempt to slice the dependency graph by
         * hand.
         */
        manualChunks(id) {
          return id.includes("node_modules") ? "vendor" : undefined;
        },
      },
    },
  },
}));
