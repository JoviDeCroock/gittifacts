// Bundle the runner CLI into one ESM file that runs with plain `node`:
//   node build.mjs [outdir]   →   <outdir>/gittifacts-runner.mjs  (default outdir: dist)
//
// Workspace packages (@app/*) and zod are bundled in. Tools that must stay real packages are
// external and installed next to the bundle (see Dockerfile / runtime-package.json):
// TypeScript (compiler API), esbuild (native binary), Stryker and @vitest/coverage-v8 (loaded by
// path at runtime, so they are never imported here at all).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = process.argv[2] ?? join(here, "dist");
const outfile = join(outdir, "gittifacts-runner.mjs");
mkdirSync(outdir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

await esbuild.build({
  entryPoints: [join(here, "src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
  external: ["typescript", "esbuild", "@stryker-mutator/*", "@vitest/*", "vitest", "vitest/*"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Bundled CommonJS dependencies may call require().
      'import { createRequire as __gittifactsCreateRequire } from "node:module";',
      "const require = __gittifactsCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
chmodSync(outfile, 0o755);

// The runtime dependencies installed next to the bundle (the Dockerfile `npm install`s this).
const deps = pkg.dependencies ?? {};
const devDeps = pkg.devDependencies ?? {};
const runtime = {
  name: "gittifacts-runner-runtime",
  version: "0.0.0",
  private: true,
  type: "module",
  dependencies: {
    typescript: deps.typescript,
    esbuild: devDeps.esbuild ?? deps.esbuild,
    "@stryker-mutator/core": deps["@stryker-mutator/core"],
    "@stryker-mutator/vitest-runner": deps["@stryker-mutator/vitest-runner"],
    "@vitest/coverage-v8": deps["@vitest/coverage-v8"],
    // Peer of coverage-v8 and the Stryker vitest runner (repos use their own vitest when installed).
    vitest: deps["@vitest/coverage-v8"],
  },
};
writeFileSync(join(outdir, "package.json"), `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`built ${outfile}`);
