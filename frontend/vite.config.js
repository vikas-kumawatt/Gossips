import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
});
