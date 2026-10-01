/**
 * `detect [--cwd dir] [--sha sha]`: what an imported repository is, for the platform's proposed
 * `.platform/ci.ts`, `.platform/policy.ts` and AGENTS.md (a Plan + Change a human approves).
 * Prints one `::detect::<DetectReport>` line.
 *
 * The analysis is `@app/conventions` `inspectRepo` (detectProject plus test-runner configs,
 * tsconfig, wrangler configs, workspaces and pnpm 11 build-script approvals); this command only
 * lists the tracked files (`git ls-files`, or a walk outside git) and reads them. Nothing is
 * installed or executed. Fail closed: when inspection crashes, the document still prints, with
 * `confidence: "low"` and the failure as the first uncertain sentence.
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DETECT_REPORT_VERSION,
  type DetectReport,
  inspectRepo,
  type RepoTree,
} from "@app/conventions";
import { git, isSha } from "../lib/git.js";
import { errorMessage, log } from "../lib/log.js";

export { DETECT_PREFIX } from "@app/conventions";

export interface DetectCommandInput {
  cwd: string;
  sha: string | undefined;
}

/** Lockfiles can be large; everything else detection reads is small. */
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 50_000;
const LOCKFILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lock)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", ".turbo", ".next"]);

async function gitFiles(cwd: string): Promise<{ root: string; files: string[] } | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const listed = await git(root, ["ls-files", "-z", "--cached"], { allowFail: true });
  if (listed.code !== 0) return null;
  return { root, files: listed.stdout.split("\0").filter((f) => f !== "") };
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
      }
    }
  }
  return out;
}

export function fileReader(root: string): (path: string) => string | null {
  return (path) => {
    if (path.startsWith("/") || path.split("/").includes("..")) return null;
    const full = join(root, path);
    try {
      const size = statSync(full).size;
      if (size > (LOCKFILE.test(path) ? MAX_LOCKFILE_BYTES : MAX_FILE_BYTES)) return null;
      const buf = readFileSync(full);
      return buf.subarray(0, 8192).includes(0) ? null : buf.toString("utf8");
    } catch {
      return null;
    }
  };
}

/** The fail-closed document: nothing could be inspected. */
export function detectError(note: string, sha: string | null): DetectReport {
  return {
    version: DETECT_REPORT_VERSION,
    sha,
    features: {
      hasPackageJson: false,
      packageManager: "npm",
      lockfile: null,
      scripts: { lint: null, typecheck: null, test: null, build: null },
      typescript: false,
      testRunner: null,
      worker: false,
      cacheInputs: null,
    },
    confidence: "low",
    uncertain: [`Detection failed: ${note}`.slice(0, 2000)],
    packageManager: "npm",
    packageManagerSpec: null,
    lockfile: null,
    testRunner: null,
    testConfigs: [],
    installCommand: "npm install --no-audit --no-fund",
    testCommand: null,
    buildCommand: null,
    typecheckCommand: null,
    lintCommand: null,
    tsconfig: null,
    workers: [],
    workerConfigs: [],
    workspaces: [],
    buildScriptsNeedingApproval: [],
    approvedBuilds: [],
    notes: [],
  };
}

export async function detect(input: DetectCommandInput): Promise<DetectReport> {
  const fromGit = await gitFiles(input.cwd).catch(() => null);
  const root = fromGit?.root ?? input.cwd;
  const files = fromGit?.files ?? walk(input.cwd);
  let sha: string | null = input.sha !== undefined && isSha(input.sha) ? input.sha : null;
  if (sha === null && fromGit !== null) {
    const head = await git(root, ["rev-parse", "HEAD"], { allowFail: true });
    sha = head.code === 0 && isSha(head.stdout.trim()) ? head.stdout.trim() : null;
  }
  const tree: RepoTree = { files: files.slice(0, MAX_FILES), read: fileReader(root) };
  const report = inspectRepo(tree, { sha });
  if (files.length > MAX_FILES) {
    report.uncertain.push(`Only the first ${MAX_FILES} of ${files.length} files were inspected.`);
  }
  log(
    `detect: ${files.length} file(s); ${report.packageManager}, tests ${report.testRunner ?? "none"}, ${report.workers.length} Worker(s), confidence ${report.confidence}`,
  );
  return report;
}

/** The `detect` command: always one `::detect::` document. */
export async function detectCommand(
  input: DetectCommandInput,
  emit: (doc: DetectReport) => void,
): Promise<number> {
  let doc: DetectReport;
  try {
    doc = await detect(input);
  } catch (error) {
    log(
      `detect failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    doc = detectError(errorMessage(error), input.sha ?? null);
  }
  emit(doc);
  return 0;
}
