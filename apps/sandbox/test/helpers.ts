/** Test helpers: tiny git repositories and running the built CLI bundle. */
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SANDBOX = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(SANDBOX, "..", "..");
export const BUNDLE = join(SANDBOX, "dist", "gittifacts-runner.mjs");

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "@1767258000 +0000",
  GIT_COMMITTER_DATE: "@1767258000 +0000",
};

export function gitSync(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgSign=false", ...args], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
  }).trim();
}

export type Files = Record<string, string | null>;

function apply(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (path.endsWith(".sh")) chmodSync(full, 0o755);
  }
}

export interface TempRepo {
  dir: string;
  base: string;
  head: string;
  cleanup(): void;
}

/** A repo with a base commit on main and a head commit (checked out) on `change`. */
export function tempRepo(base: Files, head: Files): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "gittifacts-unit-"));
  const dir = join(root, "repo");
  mkdirSync(dir);
  gitSync(dir, ["init", "-q"]);
  apply(dir, base);
  gitSync(dir, ["add", "-A"]);
  gitSync(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  const baseSha = gitSync(dir, ["rev-parse", "HEAD"]);
  gitSync(dir, ["checkout", "-q", "-b", "change"]);
  apply(dir, head);
  gitSync(dir, ["add", "-A"]);
  gitSync(dir, ["commit", "-q", "--allow-empty", "-m", "head"]);
  const headSha = gitSync(dir, ["rev-parse", "HEAD"]);
  return { dir, base: baseSha, head: headSha, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function cli(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const clean: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("VITEST") && k !== "TEST") clean[k] = v;
    execFile(process.execPath, [BUNDLE, ...args], { cwd, env: { ...clean, ...env }, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

/** The single `<prefix><json>` stdout line, parsed; throws when the contract is violated. */
export function document(result: CliResult, prefix = "::evidence::"): unknown {
  const lines = result.stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== 1 || !lines[0]?.startsWith(prefix)) {
    throw new Error(`expected exactly one ${prefix} line, got:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(lines[0].slice(prefix.length));
}

let built = false;

/** Build the bundle once per test process. */
export function ensureBundle(): void {
  if (built && existsSync(BUNDLE)) return;
  execFileSync(process.execPath, [join(SANDBOX, "build.mjs")], { cwd: SANDBOX, stdio: "ignore" });
  built = true;
}
