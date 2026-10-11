/**
 * Packs the CLI as an npm tarball into the platform's static assets, so it runs without an npm
 * publish: `npx -y https://<host>/cli/v2/gittifacts.tgz --host https://<host> …`.
 *
 *   node scripts/pack-assets.mjs [--out <dir>]      (default: ../web/dist/cli)
 *
 * 1. `node build.mjs` → dist/cli.mjs (one dependency-free file).
 * 2. Stage a publishable package (package.json without the workspace devDependencies, dist/,
 *    README.md) and `npm pack` it.
 * 3. Write v2/gittifacts.tgz (latest), the same bytes as gittifacts-<version>.tgz, latest.json,
 *    and version.json ({ sha256, size } of dist/cli.mjs: what the CLI's self-update compares
 *    its own file with, src/self-update.ts). The platform serves the pre-v2 tarball path
 *    from v2/gittifacts.tgz (apps/platform/src/routes/cli.ts), so both are always this build.
 *
 * `deploy:prepare` runs it after the web build (vite empties packages/web/dist).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(root, "..", "web", "dist", "cli"));

execFileSync(process.execPath, [join(root, "build.mjs")], { stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = mkdtempSync(join(tmpdir(), "gittifacts-cli-pack-"));
try {
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: "module",
    bin: pkg.bin,
    files: ["dist"],
    engines: { node: ">=22" },
  };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(join(stage, "dist"));
  copyFileSync(join(root, "dist", "cli.mjs"), join(stage, "dist", "cli.mjs"));
  copyFileSync(join(root, "README.md"), join(stage, "README.md"));

  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", stage], {
      cwd: stage,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  )[0];
  if (packed === undefined || typeof packed.filename !== "string") {
    throw new Error("npm pack returned no tarball");
  }

  mkdirSync(out, { recursive: true });
  const pinned = `gittifacts-${pkg.version}.tgz`;
  copyFileSync(join(stage, packed.filename), join(out, pinned));
  mkdirSync(join(out, "v2"), { recursive: true });
  copyFileSync(join(stage, packed.filename), join(out, "v2", "gittifacts.tgz"));
  const latest = {
    name: pkg.name,
    version: pkg.version,
    tarball: `/cli/${pinned}`,
    latest: "/cli/v2/gittifacts.tgz",
    integrity: packed.integrity,
    shasum: packed.shasum,
    size: packed.size,
    node: ">=22",
  };
  writeFileSync(join(out, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  const cli = readFileSync(join(root, "dist", "cli.mjs"));
  const version = {
    name: pkg.name,
    version: pkg.version,
    sha256: createHash("sha256").update(cli).digest("hex"),
    size: cli.length,
    tarball: "/cli/v2/gittifacts.tgz",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(out, "version.json"), `${JSON.stringify(version, null, 2)}\n`);
  console.log(`packed ${pinned} (${(packed.size / 1024).toFixed(0)} KiB) into ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
