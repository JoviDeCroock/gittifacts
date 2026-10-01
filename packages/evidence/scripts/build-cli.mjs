// Bundle the CLIs into single-file ESM scripts that run with plain `node` (no deps).
//   node scripts/build-cli.mjs  →  dist/verify-attestation.mjs, dist/keygen.mjs
//
// esbuild is not a declared dependency of this package (dependencies are frozen in
// this repo); it is resolved through tsx, which depends on it. Prefer adding
// `esbuild` to devDependencies and importing it directly.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    const require = createRequire(join(pkgRoot, "package.json"));
    const tsxPkg = require.resolve("tsx/package.json");
    const esbuildPath = createRequire(tsxPkg).resolve("esbuild");
    return import(esbuildPath);
  }
}

const esbuild = await loadEsbuild();
const outdir = process.argv[2] ?? join(pkgRoot, "dist");
const entries = [
  ["src/cli/verify.ts", "verify-attestation.mjs"],
  ["src/cli/keygen.ts", "keygen.mjs"],
];
for (const [entry, out] of entries) {
  await esbuild.build({
    entryPoints: [join(pkgRoot, entry)],
    outfile: join(outdir, out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`built ${join(outdir, out)}`);
}
