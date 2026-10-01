/** Per-invocation context shared by the commands. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageManager } from "./ci-engine.js";
import { ensureCommit, gitText, resolveCommit } from "./git.js";
import { log } from "./log.js";

export interface Context {
  /** Top level of the checkout (the head working tree). */
  repo: string;
  /** Full base commit id. */
  base: string;
  /** Full head commit id. */
  head: string;
  packageManager: PackageManager | null;
  testCommand: string | null;
  /** Scratch directory for this invocation (worktrees, reports). Removed afterwards. */
  tmp: string;
  /** The working tree is checked out at `head` (code-running measurements require it). */
  atHead: boolean;
  /** Tracked files modified in the working tree (e.g. by an install step). */
  dirtyFiles: string[];
}

export interface ContextInput {
  cwd: string;
  base: string | undefined;
  head: string | undefined;
  packageManager: PackageManager | null;
  testCommand: string | null;
  /** Commands that only read git objects don't care where the working tree is. */
  needsBase: boolean;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export async function createContext(input: ContextInput): Promise<Context> {
  const repo = (await gitText(input.cwd, ["rev-parse", "--show-toplevel"])).trim();
  const checkedOut = await resolveCommit(repo, "HEAD");
  const headRev = input.head ?? checkedOut ?? "HEAD";
  const head = await ensureCommit(repo, headRev);
  let base = head;
  if (input.needsBase) {
    if (input.base === undefined || input.base === "") {
      throw new UsageError("--base (or $GITTIFACTS_BASE_SHA) is required");
    }
    base = await ensureCommit(repo, input.base);
  }
  const atHead = checkedOut === head;
  let dirtyFiles: string[] = [];
  if (!atHead) {
    log(`warning: the working tree is at ${checkedOut ?? "no commit"}, not at head ${head}`);
  } else {
    const dirty = await gitText(repo, ["status", "--porcelain", "--untracked-files=no"]);
    dirtyFiles = dirty
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.slice(3));
    if (dirtyFiles.length > 0)
      log(`warning: tracked files differ from head: ${dirtyFiles.slice(0, 10).join(", ")}`);
  }
  const tmp = mkdtempSync(join(process.env.GITTIFACTS_TMPDIR ?? tmpdir(), "gittifacts-"));
  return {
    repo,
    base,
    head,
    packageManager: input.packageManager,
    testCommand: input.testCommand,
    tmp,
    atHead,
    dirtyFiles,
  };
}

export function disposeContext(ctx: Context): void {
  if (process.env.GITTIFACTS_KEEP_TMP === "1") {
    log(`keeping scratch directory ${ctx.tmp}`);
    return;
  }
  rmSync(ctx.tmp, { recursive: true, force: true });
}

/**
 * For measurements that run code in the working tree: an error message when it is not at head,
 * else a note when tracked files were modified (null when clean).
 */
export function workdirCheck(ctx: Context): { error: string | null; note: string | null } {
  if (!ctx.atHead)
    return {
      error: `the working tree ${ctx.repo} is not checked out at head ${ctx.head}`,
      note: null,
    };
  if (ctx.dirtyFiles.length === 0) return { error: null, note: null };
  const shown = ctx.dirtyFiles.slice(0, 10).join(", ");
  return {
    error: null,
    note: `measured with tracked files modified in the working tree: ${shown}${ctx.dirtyFiles.length > 10 ? ", …" : ""}`,
  };
}
