// Builds the client bundle and the Worker with esbuild, and copies public/ next to the bundle.
//   dist/client/  static assets served by Workers (index.html, styles.css, app.js)
//   dist/worker.js  the Worker (handles /api/*)
import { cp, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await cp("public", "dist/client", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["src/client/main.tsx"],
    outfile: "dist/client/app.js",
    bundle: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    minify: true,
    sourcemap: true,
    logLevel: "warning",
  }),
  build({
    entryPoints: ["src/worker.ts"],
    outfile: "dist/worker.js",
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    logLevel: "warning",
  }),
]);
