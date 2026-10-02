import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { landingPrerender } from "./landing.vite.js";

const backend = "http://localhost:8787";

export default defineConfig({
  plugins: [preact(), landingPrerender()],
  server: {
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/mcp": { target: backend, changeOrigin: true },
      "/.well-known": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    // es2022 browsers all support modulepreload; skip the polyfill script.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // The app (SPA) and the prerendered landing page the Worker serves at `/` to visitors.
      input: { main: "index.html", landing: "landing.html" },
    },
  },
});
