import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { landingFontPreload, landingPrerender } from "./landing.vite.js";

// The platform the dev server proxies to. GF_BACKEND points it elsewhere, e.g. a deployed
// platform when checking the UI against real data (sign in there, then reuse the session cookie).
const backend = process.env.GF_BACKEND ?? "http://localhost:8787";

export default defineConfig({
  plugins: [preact(), landingPrerender(), landingFontPreload()],
  server: {
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/mcp": { target: backend, changeOrigin: true },
      "/.well-known": { target: backend, changeOrigin: true },
      // The onboarding dashboard's data; /internal/onboarding itself is an app route.
      "/internal/ttfg": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    // es2022 browsers all support modulepreload; skip the polyfill script.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // The app (SPA, signed-in home /dashboard) and the prerendered landing page the Worker serves at `/`.
      input: { main: "index.html", landing: "landing.html" },
    },
  },
});
