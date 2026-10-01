import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const backend = "http://localhost:8787";

export default defineConfig({
  plugins: [preact()],
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
  },
});
