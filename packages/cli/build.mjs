/**
 * Bundles the CLI into one dependency-free ESM file: dist/cli.mjs (`npx gittifacts`).
 *
 * 1. Evaluate src/tools/definitions.ts (which reads @app/mcp's tool definitions) in a throwaway
 *    bundle and capture the tool list as JSON.
 * 2. Bundle src/cli.ts with that module replaced by the JSON, so the published file carries the
 *    command table but none of the server code.
 *
 * Usage: node build.mjs [--outfile <path>]
 *   GITTIFACTS_DEFAULT_HOST=https://… bakes in a default host (else the user must configure one).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const definitionsModule = resolve(root, "src/tools/definitions.ts");
const outArg = process.argv.indexOf("--outfile");
const outfile = resolve(outArg > 0 ? process.argv[outArg + 1] : join(root, "dist/cli.mjs"));

// Some bundled CommonJS dependencies call require() for Node builtins.
const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __gittifactsCreateRequire } from "node:module";',
  "const require = __gittifactsCreateRequire(import.meta.url);",
].join("\n");

async function readToolDefinitions() {
  const dir = await mkdtemp(join(tmpdir(), "gittifacts-cli-build-"));
  try {
    const file = join(dir, "definitions.mjs");
    await build({
      entryPoints: [definitionsModule],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: file,
      banner: { js: banner.split("\n").slice(1).join("\n") },
      logLevel: "warning",
    });
    const mod = await import(pathToFileURL(file).href);
    const defs = mod.TOOL_DEFINITIONS;
    if (!Array.isArray(defs) || defs.length === 0) throw new Error("no tool definitions found");
    return JSON.parse(JSON.stringify(defs));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const definitions = await readToolDefinitions();

/** Replaces definitions.ts with its evaluated value. */
const inlineDefinitions = {
  name: "inline-tool-definitions",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]tools[\\/]definitions\.ts$/ }, () => ({
      contents: `export const TOOL_DEFINITIONS = ${JSON.stringify(definitions)};\n`,
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [resolve(root, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  banner: { js: banner },
  define: {
    "process.env.GITTIFACTS_BUILD_DEFAULT_HOST": JSON.stringify(process.env.GITTIFACTS_DEFAULT_HOST ?? ""),
  },
  plugins: [inlineDefinitions],
  metafile: true,
  logLevel: "warning",
});

const inputs = Object.keys(result.metafile.inputs);
const leaked = inputs.filter((p) => /packages[\\/](mcp|domain|evidence)[\\/]src/.test(p));
if (leaked.length > 0) {
  throw new Error(`server code leaked into the CLI bundle:\n${leaked.join("\n")}`);
}
const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(
  `built ${outfile} (${(bytes / 1024).toFixed(0)} KiB, ${definitions.length} tools: ${definitions.map((d) => d.name).join(", ")})`,
);
