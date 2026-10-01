/**
 * The resolver eval corpus (fixtures/conflicts): load cases, materialize them as git repositories,
 * run the real runner (`merge-attempt`, `apply-resolution`), the resolver, and the cases'
 * expected-behaviour tests on the resolved tree. Node only; shared by scripts/eval.ts (real model)
 * and test/corpus.test.ts (scripted model).
 */
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClassifyResult, classify, neverLower } from "@app/classifier";
import { type FileDiffStat, Plan, RepoPolicy } from "@app/domain";
import { type EvidenceItem, matchRegions, splitLines } from "@app/evidence";
import { FakeLlmClient, type LlmClient } from "@app/tour";
import { z } from "zod";
import { ApplyResolutionDoc, MergeAttempt, parseMergeOutput } from "../../src/merge-doc.js";
import {
  type ContextFileInput,
  createResolver,
  type ResolutionOutcome,
  type ResolverInput,
} from "../../src/resolver.js";
import type { ModelResolution } from "../../src/schema.js";
import { buildWorkspace } from "../../src/workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const CORPUS_DIR = join(REPO_ROOT, "fixtures/conflicts");

// ---------------------------------------------------------------- case files

const PlanSpec = z.object({
  title: z.string().min(3),
  intent: z.string().min(10),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  scopePaths: z.array(z.string()).default(["src/**", "test/**"]),
});

const ChangeSpec = z.object({
  changeId: z.string().min(1),
  title: z.string().min(1),
  /** Overlay directory, relative to the case. */
  dir: z.string().min(1),
  plan: PlanSpec,
  /** Paths deleted by this change. */
  delete: z.array(z.string()).default([]),
});

export const CaseSpec = z.object({
  name: z.string().min(1),
  kind: z.enum(["textual", "semantic"]),
  description: z.string().min(1),
  change: ChangeSpec,
  /** Applied to base in order, each as one commit on main. */
  upstream: z.array(ChangeSpec).min(1),
  expect: z.object({
    /** Paths merge-attempt reports as conflicted (textual cases). */
    conflicted: z.array(z.string()).default([]),
    /** Whether a correct resolution needs edits outside the conflict hunks. */
    outsideHunks: z.boolean(),
    /** The upstream changeId that causes a semantic conflict. */
    culprit: z.string().nullable().default(null),
    /** Paths the correct resolution deletes (the rest of it is in `resolved/`). */
    delete: z.array(z.string()).default([]),
  }),
});
export type CaseSpec = z.infer<typeof CaseSpec>;

export interface ConflictCase {
  name: string;
  dir: string;
  spec: CaseSpec;
}

export function listCases(filter: readonly string[] = []): ConflictCase[] {
  return readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name))
    .filter((e) => existsSync(join(CORPUS_DIR, e.name, "case.json")))
    .filter((e) => filter.length === 0 || filter.includes(e.name))
    .map((e) => {
      const dir = join(CORPUS_DIR, e.name);
      const spec = CaseSpec.parse(JSON.parse(readFileSync(join(dir, "case.json"), "utf8")));
      if (spec.name !== e.name) throw new Error(`${dir}: name ${spec.name} != directory`);
      return { name: e.name, dir, spec };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Every file under `dir`, as repo-relative path → content. */
export function readOverlay(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(relative(dir, full).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}

export function toPlan(id: string, spec: z.infer<typeof PlanSpec>): Plan {
  return Plan.parse({
    id,
    repoId: "repo_corpus",
    title: spec.title,
    intent: spec.intent,
    acceptanceCriteria: spec.acceptanceCriteria,
    outOfScope: [],
    riskDeclarations: [],
    scopePaths: spec.scopePaths,
    affectedRoutes: [],
    status: "approved",
    authorId: "agent_author",
    approvedBy: "human_owner",
    approvedAt: "2026-10-01T10:00:00.000Z",
    approvalSignature: "sig",
    supersedes: null,
    createdAt: "2026-10-01T09:00:00.000Z",
  });
}

// ---------------------------------------------------------------- git

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Corpus Author",
  GIT_AUTHOR_EMAIL: "author@corpus.invalid",
  GIT_COMMITTER_NAME: "Corpus Author",
  GIT_COMMITTER_EMAIL: "author@corpus.invalid",
};

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "TEST" || k.startsWith("VITEST") || k === "NODE_V8_COVERAGE") continue;
    env[k] = v;
  }
  return { ...env, ...GIT_ENV, ...extra };
}

export function git(dir: string, args: readonly string[], date?: string): string {
  return execFileSync(
    "git",
    ["-c", "init.defaultBranch=main", "-c", "commit.gpgSign=false", ...args],
    {
      cwd: dir,
      env: cleanEnv(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trimEnd();
}

const DEFAULT_PACKAGE = `${JSON.stringify({ name: "@corpus/case", private: true, type: "module" }, null, 2)}\n`;

function applyOverlay(
  repo: string,
  files: Map<string, string>,
  deletions: readonly string[],
): void {
  for (const [path, content] of files) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const path of deletions) rmSync(join(repo, path), { force: true });
}

export interface Materialized {
  dir: string;
  base: string;
  onto: string;
  head: string;
  upstream: Array<{ changeId: string; sha: string }>;
}

/** base on main, each upstream change as a commit on main (onto = the last), the change on a branch. */
export function materialize(c: ConflictCase, root: string): Materialized {
  const dir = join(root, c.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  const base = readOverlay(join(c.dir, "base"));
  if (!base.has("package.json")) base.set("package.json", DEFAULT_PACKAGE);
  base.set(".gitignore", "node_modules\n");
  applyOverlay(dir, base, []);
  const commit = (message: string, date: string) => {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", message], date);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const baseSha = commit("base", "@1767258000 +0000");
  const upstream: Materialized["upstream"] = [];
  c.spec.upstream.forEach((u, i) => {
    applyOverlay(dir, readOverlay(join(c.dir, u.dir)), u.delete);
    upstream.push({
      changeId: u.changeId,
      sha: commit(`${u.title}\n\nChange: ${u.changeId}`, `@${1767261600 + i * 60} +0000`),
    });
  });
  const onto = upstream[upstream.length - 1]!.sha;
  git(dir, ["checkout", "-q", "-b", "change", baseSha]);
  applyOverlay(dir, readOverlay(join(c.dir, c.spec.change.dir)), c.spec.change.delete);
  const head = commit(
    `${c.spec.change.title}\n\nChange: ${c.spec.change.changeId}`,
    "@1767265200 +0000",
  );
  return { dir, base: baseSha, onto, head, upstream };
}

/** `git diff --numstat` + `--name-status` → FileDiffStat[]. */
export function diffStats(dir: string, from: string, to: string): FileDiffStat[] {
  const status = new Map<string, string>();
  for (const line of git(dir, ["diff", "--name-status", "--no-renames", from, to]).split("\n")) {
    if (line.trim() === "") continue;
    const [s = "M", path = ""] = line.split("\t");
    status.set(path, s);
  }
  return git(dir, ["diff", "--numstat", "--no-renames", from, to])
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [a = "0", d = "0", path = ""] = l.split("\t");
      const s = status.get(path) ?? "M";
      return {
        path,
        previousPath: null,
        status: s === "A" ? "added" : s === "D" ? "deleted" : "modified",
        additions: a === "-" ? 0 : Number(a),
        deletions: d === "-" ? 0 : Number(d),
        binary: a === "-",
      };
    });
}

function show(dir: string, sha: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      cwd: dir,
      env: cleanEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- runner and tests

/** Build the sandbox runner bundle (esbuild) into `outDir`; returns the bundle path. */
export function buildRunner(outDir: string): string {
  execFileSync(process.execPath, [join(REPO_ROOT, "apps/sandbox/build.mjs"), outDir], {
    cwd: join(REPO_ROOT, "apps/sandbox"),
    stdio: "ignore",
  });
  return join(outDir, "gittifacts-runner.mjs");
}

interface Proc {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<Proc> {
  return new Promise((done) => {
    execFile(
      cmd,
      [...args],
      { cwd, env: cleanEnv(), maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) =>
        done({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

export function runRunner(bundle: string, args: readonly string[], cwd: string): Promise<Proc> {
  return exec(process.execPath, [bundle, ...args, "--cwd", cwd], cwd);
}

export interface TestRun {
  passed: number;
  failed: number;
  failing: Array<{ id: string; file: string; message: string }>;
  ok: boolean;
}

const VitestJson = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      message: z.string().optional(),
      assertionResults: z.array(
        z.object({
          ancestorTitles: z.array(z.string()),
          title: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()).default([]),
        }),
      ),
    }),
  ),
});

/** Run vitest on `sha` (optionally with an overlay of check tests) in a throwaway worktree. */
export async function runTests(
  repo: string,
  sha: string,
  scratch: string,
  overlay: Map<string, string> = new Map(),
): Promise<TestRun> {
  const wt = mkdtempSync(join(scratch, "wt-"));
  rmSync(wt, { recursive: true, force: true });
  git(repo, ["worktree", "add", "-q", "--detach", wt, sha]);
  try {
    applyOverlay(wt, overlay, []);
    symlinkSync(join(REPO_ROOT, "node_modules"), join(wt, "node_modules"), "dir");
    const out = join(wt, ".vitest-report.json");
    const r = await exec(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        wt,
        "--reporter=json",
        `--outputFile=${out}`,
      ],
      wt,
    );
    if (!existsSync(out)) {
      return {
        passed: 0,
        failed: 1,
        ok: false,
        failing: [{ id: "(vitest)", file: "", message: r.stderr.slice(-2000) }],
      };
    }
    const report = VitestJson.parse(JSON.parse(readFileSync(out, "utf8")));
    let passed = 0;
    const failing: TestRun["failing"] = [];
    for (const file of report.testResults) {
      const rel = relative(wt, file.name).split("\\").join("/");
      if (file.assertionResults.length === 0 && file.message)
        failing.push({ id: rel, file: rel, message: file.message.slice(0, 2000) });
      for (const a of file.assertionResults) {
        if (a.status === "passed") passed++;
        else if (a.status === "failed")
          failing.push({
            id: [rel, ...a.ancestorTitles, a.title].join(" > "),
            file: rel,
            message: (a.failureMessages[0] ?? "").split("\n")[0]!.slice(0, 600),
          });
      }
    }
    return { passed, failed: failing.length, failing, ok: failing.length === 0 && passed > 0 };
  } finally {
    git(repo, ["worktree", "remove", "--force", wt]);
  }
}

// ---------------------------------------------------------------- lanes (synthetic, green evidence)

const policy = RepoPolicy.parse({ lane0Enabled: true });

function greenItems(sha: string, passed: number): EvidenceItem[] {
  return [
    {
      id: "test-run",
      kind: "test-run",
      status: "ok",
      sha,
      step: "test",
      runner: "vitest",
      passed,
      failed: 0,
      skipped: 0,
      durationMs: 1,
      failures: [],
    },
    {
      id: "coverage",
      kind: "coverage",
      status: "ok",
      changedLines: 10,
      coveredChangedLines: 10,
      ratio: 1,
      files: [],
    },
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "stryker",
      files: [],
      killed: 9,
      survived: 1,
      timedOut: 0,
      noCoverage: 0,
      score: 0.9,
      survivors: [],
    },
    { id: "public-api", kind: "public-api", status: "ok", classification: "none", packages: [] },
    {
      id: "dependencies",
      kind: "dependencies",
      status: "ok",
      added: [],
      removed: [],
      changed: [],
      newInstallScripts: [],
      lockfileChanged: false,
    },
    {
      id: "sensitive-paths",
      kind: "sensitive-paths",
      status: "ok",
      patterns: policy.sensitivePaths,
      hits: [],
    },
  ];
}

function laneOf(
  dir: string,
  plan: Plan,
  from: string,
  to: string,
  items: EvidenceItem[],
): ClassifyResult {
  const files = diffStats(dir, from, to);
  return classify(
    { items },
    policy,
    plan,
    {
      baseSha: from,
      headSha: to,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
    { category: "feature" },
    {
      ciStatus: "passed",
      evidenceVerified: true,
      budgetExceeded: false,
      tourStatus: "not-generated",
      pureRevertVerified: false,
    },
  );
}

// ---------------------------------------------------------------- evaluation

export interface CaseResult {
  name: string;
  kind: "textual" | "semantic";
  success: boolean;
  /** Why it failed (resolver eject cause, apply error, failing checks, broken case). */
  failure: string | null;
  attempts: number;
  costUsd: number;
  model: string | null;
  outside: boolean | null;
  expectedOutside: boolean;
  culprit: string | null;
  expectedCulprit: string | null;
  lanes: { before: number; merged: number; final: number } | null;
  /** final < before: must never happen. */
  downgrade: boolean;
  /** The merged tree classified lower and neverLower kept the lane. */
  keptByFloor: boolean;
  checks: { passed: number; failed: number; failing: string[] } | null;
  durationMs: number;
  outcome?: ResolutionOutcome;
}

export interface Prepared {
  c: ConflictCase;
  m: Materialized;
  merge: MergeAttempt;
  input: ResolverInput;
}

/** Materialize a case, run merge-attempt, and build the resolver's input. */
export async function prepareCase(
  c: ConflictCase,
  bundle: string,
  root: string,
  budgetUsd: number,
): Promise<Prepared> {
  const m = materialize(c, root);
  const mergeRun = await runRunner(
    bundle,
    ["merge-attempt", "--base", m.base, "--onto", m.onto, "--head", m.head],
    m.dir,
  );
  const merge = parseMergeOutput(mergeRun.stdout, MergeAttempt);
  const want = c.spec.kind === "textual" ? "conflict" : "clean";
  if (merge.status !== want)
    throw new Error(`${c.name}: merge-attempt says ${merge.status}, the case expects ${want}`);
  if (merge.status === "conflict") {
    const got = merge.files.map((f) => f.path).sort();
    const exp = [...c.spec.expect.conflicted].sort();
    if (JSON.stringify(got) !== JSON.stringify(exp))
      throw new Error(
        `${c.name}: conflicted ${got.join(", ")}, the case expects ${exp.join(", ")}`,
      );
  }
  const applyOnto =
    merge.status === "conflict"
      ? merge.conflictSha
      : merge.status === "clean"
        ? merge.newSha
        : m.onto;
  let semantic: ResolverInput["semantic"];
  if (c.spec.kind === "semantic") {
    const run = await runTests(m.dir, applyOnto, root);
    if (run.failing.length === 0)
      throw new Error(`${c.name}: the merged tree passes; not a semantic conflict`);
    semantic = {
      failingTests: run.failing.map((f) => ({ id: f.id, message: f.message })),
      candidates: m.upstream.map((u) => u.changeId),
    };
  }
  // Context: what either side touched, plus failing test files, as they are in the merged tree.
  const conflicted = new Set(merge.status === "conflict" ? merge.files.map((f) => f.path) : []);
  const touched = new Set<string>();
  for (const f of diffStats(m.dir, m.base, m.head)) touched.add(f.path);
  for (const u of m.upstream)
    for (const f of diffStats(m.dir, `${u.sha}^`, u.sha)) touched.add(f.path);
  for (const t of semantic?.failingTests ?? []) touched.add(t.id.split(" > ")[0]!);
  const files: ContextFileInput[] = [];
  for (const path of [...touched].sort()) {
    if (conflicted.has(path) || path === "package.json" || path === ".gitignore") continue;
    const content = show(m.dir, applyOnto, path);
    if (content !== null) files.push({ path, content });
  }
  const input: ResolverInput = {
    change: {
      id: c.spec.change.changeId,
      title: c.spec.change.title,
      baseSha: m.base,
      headSha: m.head,
    },
    plan: toPlan(`plan_${c.spec.change.changeId}`, c.spec.change.plan),
    diff: git(m.dir, ["diff", m.base, m.head]),
    upstream: c.spec.upstream.map((u, i) => ({
      changeId: u.changeId,
      sha: m.upstream[i]!.sha,
      title: u.title,
      plan: toPlan(`plan_${u.changeId}`, u.plan),
      diff: git(m.dir, ["diff", `${m.upstream[i]!.sha}^`, m.upstream[i]!.sha]),
    })),
    merge,
    files,
    budget: { changeId: c.spec.change.changeId, limitUsd: budgetUsd, spentUsd: 0 },
    excludePrincipals: ["agent_author"],
    ...(semantic === undefined ? {} : { semantic }),
  };
  return { c, m, merge, input };
}

/** The correct answer for a prepared case, from its `resolved/` directory (the scripted model). */
export function scriptedAnswer(p: Prepared): ModelResolution {
  const resolvedFiles = readOverlay(join(p.c.dir, "resolved"));
  const deleted = new Set(p.c.spec.expect.delete);
  const ws = buildWorkspace(p.merge, p.input.files ?? [], p.c.spec.kind === "semantic");
  if (!ws.ok) throw new Error(`${p.c.name}: ${ws.message}`);
  const answer: ModelResolution = {
    status: "resolved",
    regions: [],
    files: [],
    semanticConflictWith: p.c.spec.expect.culprit,
    rationale: "Scripted resolution from the corpus.",
  };
  const done = new Set<string>();
  for (const f of ws.ws.conflicted) {
    done.add(f.path);
    const expected = deleted.has(f.path) ? null : (resolvedFiles.get(f.path) ?? undefined);
    if (expected === undefined) throw new Error(`${p.c.name}: resolved/${f.path} is missing`);
    const spans =
      expected === null || f.segments === null
        ? null
        : matchRegions(f.segments, splitLines(expected));
    if (spans === null) answer.files.push({ path: f.path, content: expected });
    else {
      const lines = splitLines(expected ?? "");
      spans.forEach(([s, e], i) => {
        answer.regions.push({ file: f.path, conflict: i + 1, text: lines.slice(s, e).join("") });
      });
    }
  }
  for (const [path, content] of resolvedFiles)
    if (!done.has(path)) answer.files.push({ path, content });
  for (const path of deleted) if (!done.has(path)) answer.files.push({ path, content: null });
  return answer;
}

export function scriptedClient(p: Prepared): FakeLlmClient {
  return new FakeLlmClient([{ json: scriptedAnswer(p) }], { model: "fake/scripted-resolver" });
}

/** Run one case end to end with `client`. */
export async function evaluateCase(
  c: ConflictCase,
  opts: { bundle: string; root: string; budgetUsd: number; client: (p: Prepared) => LlmClient },
): Promise<CaseResult> {
  const started = Date.now();
  const result: CaseResult = {
    name: c.name,
    kind: c.spec.kind,
    success: false,
    failure: null,
    attempts: 0,
    costUsd: 0,
    model: null,
    outside: null,
    expectedOutside: c.spec.expect.outsideHunks,
    culprit: null,
    expectedCulprit: c.spec.expect.culprit,
    lanes: null,
    downgrade: false,
    keptByFloor: false,
    checks: null,
    durationMs: 0,
  };
  const finish = (failure: string | null): CaseResult => {
    result.failure = failure;
    result.success = failure === null;
    result.durationMs = Date.now() - started;
    return result;
  };
  let p: Prepared;
  try {
    p = await prepareCase(c, opts.bundle, opts.root, opts.budgetUsd);
  } catch (e) {
    return finish(`case broken: ${e instanceof Error ? e.message : String(e)}`);
  }
  const outcome = await createResolver(opts.client(p)).resolve(p.input);
  result.outcome = outcome;
  result.attempts = outcome.diagnostics.attempts;
  result.costUsd = outcome.costUsd;
  result.model = outcome.evidence.resolver.model;
  if (outcome.status === "ejected")
    return finish(`ejected (${outcome.eject.cause}): ${outcome.eject.message}`);
  result.outside = outcome.evidence.touchesOutsideConflictHunks;
  result.culprit = outcome.semanticConflictWith;

  const patchFile = join(opts.root, `${c.name}.patch`);
  writeFileSync(patchFile, outcome.patch);
  const applied = await runRunner(
    opts.bundle,
    ["apply-resolution", "--patch", patchFile, "--onto", outcome.applyOnto],
    p.m.dir,
  );
  const doc = parseMergeOutput(applied.stdout, ApplyResolutionDoc);
  if (doc.status !== "resolved") return finish(`apply-resolution failed: ${doc.note}`);

  const checks = await runTests(p.m.dir, doc.newSha, opts.root, readOverlay(join(c.dir, "checks")));
  result.checks = {
    passed: checks.passed,
    failed: checks.failed,
    failing: checks.failing.map((f) => f.id),
  };

  // Lanes: the Change before (base..head) vs the merged tree (onto..resolved) with the resolution.
  const plan = p.input.plan as Plan;
  const before = laneOf(
    p.m.dir,
    plan,
    p.m.base,
    p.m.head,
    greenItems(p.m.head, Math.max(1, checks.passed)),
  );
  const merged = laneOf(p.m.dir, plan, p.m.onto, doc.newSha, [
    ...greenItems(doc.newSha, Math.max(1, checks.passed)),
    outcome.evidence,
  ]);
  const final = neverLower(before, merged);
  result.lanes = { before: before.lane, merged: merged.lane, final: final.lane };
  result.downgrade = final.lane < before.lane;
  result.keptByFloor = merged.lane < before.lane;
  if (!checks.ok)
    return finish(
      `expected-behaviour tests failed: ${checks.failing
        .map((f) => `${f.id}: ${f.message}`)
        .join("; ")
        .slice(0, 1500)}`,
    );
  return finish(null);
}

export function scratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return statSync(root).isDirectory() ? root : tmpdir();
}
