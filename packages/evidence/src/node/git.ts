/**
 * Node-only git helpers (child_process). Not exported from the package root, which
 * must stay runnable on Workers; import from "@app/evidence/node".
 */
import { execFile } from "node:child_process";
import { EVIDENCE_NOTES_REF } from "../schema.js";

export class GitError extends Error {
  override readonly name = "GitError";
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git -C <repo> ...args`. Resolves with the exit code; rejects only if git cannot start. */
export function runGit(repo: string, args: readonly string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", repo, ...args],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new GitError(`could not run git: ${error.message}`, null, String(stderr)));
          return;
        }
        resolve({
          code: error ? Number(error.code) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function assertRev(rev: string): void {
  if (rev.length === 0 || rev.startsWith("-") || /[\s\0]/.test(rev)) {
    throw new GitError(`refusing suspicious revision ${JSON.stringify(rev)}`, null, "");
  }
}

/** Resolve a revision to a full commit id, or null if it does not name a commit. */
export async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  assertRev(rev);
  const r = await runGit(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
}

/** The note text attached to `commit` under `ref`, or null when there is none. */
export async function readNote(
  repo: string,
  commit: string,
  ref: string = EVIDENCE_NOTES_REF,
): Promise<string | null> {
  assertRev(commit);
  if (!ref.startsWith("refs/notes/"))
    throw new GitError(`notes ref must be under refs/notes/: ${ref}`, null, "");
  const r = await runGit(repo, ["notes", `--ref=${ref}`, "show", commit]);
  if (r.code === 0) return r.stdout;
  if (/no note found/i.test(r.stderr)) return null;
  throw new GitError(`git notes show failed: ${r.stderr.trim()}`, r.code, r.stderr);
}

/** Attach (or replace with `force`) a note on `commit`. Used by producers and tests. */
export async function writeNote(
  repo: string,
  commit: string,
  text: string,
  opts: {
    ref?: string;
    force?: boolean;
    append?: boolean;
    /** Committer of the notes commit; defaults to a gittifacts service identity. */
    identity?: { name: string; email: string };
  } = {},
): Promise<void> {
  assertRev(commit);
  const ref = opts.ref ?? EVIDENCE_NOTES_REF;
  const verb = opts.append ? "append" : "add";
  const who = opts.identity ?? { name: "gittifacts", email: "evidence@gittifacts.invalid" };
  const args = [
    "-c",
    `user.name=${who.name}`,
    "-c",
    `user.email=${who.email}`,
    "notes",
    `--ref=${ref}`,
    verb,
  ];
  if (opts.force && !opts.append) args.push("-f");
  args.push("-F", "-", commit);
  const r = await runGit(repo, args, text);
  if (r.code !== 0)
    throw new GitError(`git notes ${verb} failed: ${r.stderr.trim()}`, r.code, r.stderr);
}
