import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Environment that isolates git from the developer's global/system config. */
export function gitEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "Test Committer",
    GIT_COMMITTER_EMAIL: "committer@example.com",
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: "1700000000 +0000",
    ...extra,
  };
}

export interface GitOptions {
  input?: string | Uint8Array;
  env?: Record<string, string>;
}

/** Runs git and returns raw stdout bytes. Throws with stderr on a non-zero exit. */
export function gitBytes(cwd: string, args: string[], opts: GitOptions = {}): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      env: gitEnv(cwd, opts.env),
      input: opts.input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.toString() ?? e.message}`);
  }
}

/** Runs git and returns trimmed stdout text. */
export function git(cwd: string, args: string[], opts: GitOptions = {}): string {
  return gitBytes(cwd, args, opts).toString("utf8").trim();
}

/**
 * Async variant for git commands that talk to the in-process HTTP server: a synchronous child
 * would block the event loop the server needs to answer it.
 */
export function gitAsync(
  cwd: string,
  args: string[],
  opts: Pick<GitOptions, "env"> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: gitEnv(cwd, opts.env), maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

export function tempDir(prefix = "gitwire-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Creates a non-bare work repo on `main`. */
export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

/** Writes files (relative paths) and commits them; returns the new commit SHA. */
export function commitFiles(
  dir: string,
  files: Record<string, string | Uint8Array>,
  message: string,
  date?: string,
): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, ["add", "-A"]);
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : undefined;
  git(dir, ["commit", "-q", "-m", message], env ? { env } : {});
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Deterministic pseudo-random text so tests are reproducible but blobs deltify. */
export function lorem(seed: number, lines: number): string {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(`line ${i} ${x.toString(36)} the quick brown fox jumps over the lazy dog ${x % 97}`);
  }
  return `${out.join("\n")}\n`;
}
