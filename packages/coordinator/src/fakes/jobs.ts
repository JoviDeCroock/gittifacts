/** Fakes for the sandbox jobs and the CI engine, built on FakeGitHost. */
import type { EvidenceItem } from "@app/evidence";
import type { CiEngine, CiRunRequest, CiRunStatus, RunSink, SandboxJobs } from "../ports.js";
import { type FakeGitHost, type Files } from "./git-host.js";

// ---------------------------------------------------------------- sandbox

type JobResult = { status: "clean"; newSha: string } | { status: "conflict"; files: string[] };

export class FakeSandboxJobs implements SandboxJobs {
  /** repo name → what `.platform/policy.ts` exports (absent = no policy file). */
  readonly policies = new Map<string, unknown>();
  policyError: Error | null = null;
  pipeline: unknown = null;
  planError: Error | null = null;
  readonly calls: Array<{ op: string; input: unknown }> = [];

  constructor(private readonly git: FakeGitHost) {}

  async planPipeline(input: { repo: string; sha: string }): Promise<unknown> {
    this.calls.push({ op: "plan", input });
    if (this.planError !== null) throw this.planError;
    return this.pipeline;
  }

  async evaluatePolicy(input: { repo: string; sha: string }): Promise<unknown | null> {
    this.calls.push({ op: "policy", input });
    if (this.policyError !== null) throw this.policyError;
    return this.policies.has(input.repo) ? structuredClone(this.policies.get(input.repo)) : null;
  }

  /** File-level three-way rebase: conflicts when main and the change both touched a file differently. */
  async rebase(input: { fork: string; mainRepo: string; headSha: string; ontoSha: string; branch: string }): Promise<JobResult> {
    this.calls.push({ op: "rebase", input });
    const git = this.git;
    const main = git.repo(input.mainRepo);
    const base = git.ancestry(input.headSha).find((s) => main.objects.has(s));
    if (base === undefined) throw new Error("no merge base");
    const [b, h, o] = [git.filesAt(base), git.filesAt(input.headSha), git.filesAt(input.ontoSha)];
    const merged: Record<string, string> = { ...o };
    const conflicts: string[] = [];
    for (const path of new Set([...Object.keys(b), ...Object.keys(h)])) {
      if (b[path] === h[path]) continue; // the change did not touch it
      if (o[path] === b[path]) {
        const v = h[path];
        if (v === undefined) delete merged[path];
        else merged[path] = v;
      } else if (o[path] !== h[path]) conflicts.push(path);
    }
    if (conflicts.length > 0) return { status: "conflict", files: conflicts.sort() };
    git.copyObjects(input.fork, input.ontoSha);
    const sha = await this.commitOn(input.fork, input.branch, merged, [input.ontoSha], `rebase of ${input.headSha.slice(0, 12)}`);
    return { status: "clean", newSha: sha };
  }

  /** File-level revert of `sha` on top of `ontoSha`. */
  async revert(input: { fork: string; sha: string; ontoSha: string; branch: string; message: string }): Promise<JobResult> {
    this.calls.push({ op: "revert", input });
    const git = this.git;
    const parent = git.commits.get(input.sha)?.parents[0];
    if (parent === undefined) throw new Error("cannot revert a root commit");
    const [p, m, o] = [git.filesAt(parent), git.filesAt(input.sha), git.filesAt(input.ontoSha)];
    const result: Record<string, string> = { ...o };
    const conflicts: string[] = [];
    for (const path of new Set([...Object.keys(p), ...Object.keys(m)])) {
      if (p[path] === m[path]) continue;
      if (o[path] !== m[path]) {
        conflicts.push(path);
        continue;
      }
      const v = p[path];
      if (v === undefined) delete result[path];
      else result[path] = v;
    }
    if (conflicts.length > 0) return { status: "conflict", files: conflicts.sort() };
    const fork = git.repo(input.fork);
    if (fork.refs.get(`refs/heads/${input.branch}`) !== input.ontoSha) throw new Error("fork branch moved");
    const sha = await this.commitOn(input.fork, input.branch, result, [input.ontoSha], input.message);
    return { status: "clean", newSha: sha };
  }

  private async commitOn(repo: string, branch: string, files: Files, parents: string[], message: string): Promise<string> {
    const expectedOld = this.git.repo(repo).refs.get(`refs/heads/${branch}`) ?? "0".repeat(40);
    const { sha } = await this.git.commitTree(repo, { treeSha: this.git.treeSha(files), parents, message, branch, expectedOld });
    return sha;
  }
}

// ---------------------------------------------------------------- CI

/** A fully green Lane-0 evidence set for (base, head): what a healthy CI run emits. */
export function greenEvidence(baseSha: string, headSha: string): EvidenceItem[] {
  return [
    {
      id: "test-run:test",
      kind: "test-run",
      status: "ok",
      sha: headSha,
      step: "test",
      runner: "vitest",
      passed: 12,
      failed: 0,
      skipped: 0,
      durationMs: 900,
      failures: [],
    },
    {
      id: "red-green",
      kind: "red-green",
      status: "ok",
      tests: [{ id: "t1", file: "test/a.test.ts", name: "fixes it" }],
      base: { sha: baseSha, results: [{ id: "t1", outcome: "fail" }] },
      head: { sha: headSha, results: [{ id: "t1", outcome: "pass" }] },
      verdict: "proven",
    },
    { id: "coverage", kind: "coverage", status: "ok", changedLines: 10, coveredChangedLines: 10, ratio: 1, files: [] },
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "stryker",
      files: ["src/a.ts"],
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
  ];
}

export interface FakeRunOutcome {
  status: "passed" | "failed";
  evidence: unknown[];
  evidenceErrors?: Array<{ step: string; message: string }>;
  bundleRef?: string | null;
}

export class FakeCiEngine implements CiEngine {
  readonly runs = new Map<string, { request: CiRunRequest; status: CiRunStatus; cancelReason: string | null }>();
  readonly starts: CiRunRequest[] = [];
  readonly restarts: Array<{ runId: string; step: string }> = [];
  /** Where finished full runs are reported (the coordinator's run sink). */
  sink: RunSink | null = null;
  /** Finish runs right after `start` (on a macrotask). */
  autoFinish = true;
  /** Result per request (default: green evidence, bundle `bundle/<runId>`). */
  outcome: (req: CiRunRequest) => FakeRunOutcome = (req) => ({
    status: "passed",
    evidence: req.evidenceSteps !== undefined && req.evidenceSteps.length === 0 ? [] : greenEvidence(req.baseSha, req.headSha),
    bundleRef: `bundle/${req.runId}`,
  });
  private pending: Promise<unknown>[] = [];

  async start(req: CiRunRequest): Promise<{ runId: string }> {
    this.starts.push(structuredClone(req));
    if (this.runs.has(req.runId)) return { runId: req.runId };
    this.runs.set(req.runId, {
      request: structuredClone(req),
      status: {
        id: req.runId,
        changeId: req.changeId,
        headSha: req.headSha,
        baseSha: req.baseSha,
        engine: "workflows",
        status: "running",
        startedAt: "2026-10-01T12:00:00.000Z",
        finishedAt: null,
        steps: [],
      },
      cancelReason: null,
    });
    if (this.autoFinish) {
      const p: Promise<unknown> = new Promise((r) => setTimeout(r, 0))
        .then(() => this.finish(req.runId))
        .finally(() => this.pending.splice(this.pending.indexOf(p), 1));
      this.pending.push(p);
    }
    return { runId: req.runId };
  }

  /** Complete a run now (with the configured or given outcome) and report it to the sink. */
  async finish(runId: string, override?: FakeRunOutcome): Promise<unknown> {
    const run = this.runs.get(runId);
    if (run === undefined || run.status.status !== "running") return null;
    const out = override ?? this.outcome(run.request);
    run.status = {
      ...run.status,
      status: out.status,
      finishedAt: "2026-10-01T12:05:00.000Z",
      steps: [{ name: "test", kind: "user", status: out.status === "passed" ? "passed" : "failed", durationMs: 1000, logRef: null }],
    };
    if (this.sink === null) return null;
    return this.sink.onRunFinished({
      ...run.status,
      evidence: out.evidence,
      evidenceErrors: out.evidenceErrors ?? [],
      ...(out.bundleRef === undefined ? {} : { outputs: { bundleRef: out.bundleRef } }),
    });
  }

  async status(runId: string): Promise<CiRunStatus> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`CI run ${runId} not found`);
    return structuredClone(run.status);
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined || run.status.status !== "running") return;
    run.cancelReason = reason;
    run.status = { ...run.status, status: reason.startsWith("superseded") ? "superseded" : "cancelled" };
  }

  async restartFrom(runId: string, step: string): Promise<void> {
    this.restarts.push({ runId, step });
  }

  get pendingDeliveries(): number {
    return this.pending.length;
  }

  /** Wait for auto-finished runs (and their sink deliveries). */
  async settle(): Promise<void> {
    while (this.pending.length > 0) await Promise.allSettled([...this.pending]);
  }
}
