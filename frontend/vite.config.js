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
         * ── Why a curated list rather than one `vendor` chunk ───────────────
         *
         * `if (id.includes("node_modules")) return "vendor"` is the usual one-liner and it
         * would produce a single ~1.5 MB chunk — under the limit today, and back here in a few
         * months. Naming the heavy packages keeps each one bounded on its own.
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          /*
           * The last segment, because a nested dependency's path contains `node_modules`
           * more than once and the first match would attribute it to its parent.
           */
          const path = id.split("node_modules/").pop();
          const scoped = path.startsWith("@");
          const pkg = path.split("/").slice(0, scoped ? 2 : 1).join("/");

          /*
           * React and everything that reaches into its internals stay in one chunk.
           *
           * Not a size decision. Splitting `react` from `react-dom` from the router puts
           * their module initialisation in separate chunks whose evaluation order rollup
           * decides, and the failure mode is a blank page with "Cannot access before
           * initialization" — at runtime, in production, not at build time.
           */
          if (
            pkg === "react" ||
            pkg === "react-dom" ||
            pkg === "scheduler" ||
            pkg === "react-router" ||
            pkg === "react-router-dom"
          ) {
            return "react";
          }

          // Firebase is the single largest dependency, and it is used for two things:
          // push notifications and Google sign-in.
          if (pkg === "firebase" || pkg.startsWith("@firebase")) return "firebase";

          // Each of these is heavy and reached from one screen. Named individually so a
          // future `React.lazy` on that screen drops the chunk from the initial load without
          // any further config.
          if (pkg === "emoji-picker-react") return "emoji";
          if (pkg === "swiper") return "swiper";
          if (pkg === "jsqr" || pkg === "qrcode.react" || pkg === "qrcode-generator") return "qr";
          if (pkg === "framer-motion" || pkg === "motion-dom" || pkg === "motion-utils") {
            return "motion";
          }
          if (pkg === "socket.io-client" || pkg === "engine.io-client" || pkg === "socket.io-parser") {
            return "socket";
          }

          return "vendor";
        },
      },
    },
  },
});
