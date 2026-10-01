/**
 * Materializes an import fixture (`fixtures/imports/<name>`) as a standalone git repository with
 * one commit on `main`: what `create_project({ from: <github url> })` would import.
 *
 *   pnpm tsx scripts/materialize-import-fixture.ts clock-api            # → fixtures/.materialized/imports/clock-api
 *   pnpm tsx scripts/materialize-import-fixture.ts clock-api --out /tmp/x
 *   pnpm tsx scripts/materialize-import-fixture.ts clock-api --push https://github.com/<org>/clock-api.git
 *
 * `--push` pushes `main` to an (empty, public) remote with your own git credentials; the eval's
 * task 2 needs the fixture at a public GitHub URL. Commits are deterministic (fixed author/date),
 * so re-materializing gives the same SHA.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORTS = join(ROOT, "fixtures", "imports");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, push: { type: "string" } },
});

const name = positionals[0];
if (name === undefined || !/^[a-z0-9-]+$/.test(name) || !existsSync(join(IMPORTS, name))) {
  console.error("usage: materialize-import-fixture.ts <name> [--out dir] [--push url]");
  process.exit(2);
}

const out = resolve(values.out ?? join(ROOT, "fixtures", ".materialized", "imports"), name);
rmSync(out, { recursive: true, force: true });
mkdirSync(dirname(out), { recursive: true });
cpSync(join(IMPORTS, name), out, {
  recursive: true,
  filter: (src) => !/(^|\/)(node_modules|dist|\.wrangler)(\/|$)/.test(src),
});

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "gittifacts fixtures",
  GIT_AUTHOR_EMAIL: "fixtures@gittifacts.dev",
  GIT_COMMITTER_NAME: "gittifacts fixtures",
  GIT_COMMITTER_EMAIL: "fixtures@gittifacts.dev",
  GIT_AUTHOR_DATE: "@1790000000 +0000",
  GIT_COMMITTER_DATE: "@1790000000 +0000",
};
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgSign=false", ...args], {
    cwd: out,
    env,
    encoding: "utf8",
  }).trim();

git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", `${name}: initial import fixture`);
const sha = git("rev-parse", "HEAD");
console.log(`${name}\n  dir  ${out}\n  main ${sha}`);

if (values.push !== undefined) {
  // Your own credentials (credential helper / ssh agent): not the fixture's isolated config.
  execFileSync("git", ["push", values.push, "main:main"], { cwd: out, stdio: "inherit" });
  console.log(`  pushed to ${values.push}`);
}
