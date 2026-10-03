/**
 * `SandboxJobs` on the ci-engine `Runner` Durable Object (one DO per job, `runnerName(runId, step)`),
 * using the Runner's RPC contract (packages/ci-engine/src/runner/job.ts):
 * - `plan(PlanJob)` → PlanOutcome: `gittifacts-runner plan` prints `::plan::<PipelineSpec>`;
 * - `run(RunnerJob)` → RunnerOutcome: a checkout of `headSha` plus one command; the last part of
 *   its output comes back as `tail`. Policy evaluation (`gittifacts-runner policy` prints
 *   `::evidence::<doc>`), rebase and revert print a marker line we parse from the tail.
 *
 * Rebase/revert must push to the fork, so those jobs get a short-lived write token for the change
 * fork ONLY, passed through git's env-config (never argv). Main's objects are first copied into
 * the fork (`transferObjects`), so the sandbox never needs a token for the main repo.
 */
import { type RunnerStubLike, runOnRunner } from "@app/ci-engine/runner-client";
import { z } from "zod";
import { newId } from "../ids.js";
import type { GitHost, SandboxJobs } from "../ports.js";

/**
 * Structural slice of the Runner DO stub (`RunnerRpc`). Results are validated here. Jobs run as
 * durable jobs (`start` + long `poll`, `@app/ci-engine/runner-client`) when the stub has them, so
 * no RPC stays open for a whole job; fakes with only `run` still work.
 */
export interface RunnerLike extends RunnerStubLike {
  plan(job: Record<string, unknown>): Promise<unknown>;
}

export interface ContainerSandboxJobsOptions {
  /** `(name) => env.RUNNER.getByName(name)`. */
  runner(name: string): RunnerLike;
  git: Pick<GitHost, "remoteOf" | "mintToken" | "transferObjects"> & Partial<Pick<GitHost, "readFile">>;
  /**
   * Plan results keyed by the content hash of `.platform/ci.ts`. Plan mode is deterministic in
   * the file's content, and starting a container just to re-plan an unchanged pipeline dominates
   * time-to-first-green. Only successful plans are cached.
   */
  planCache?: PlanCache;
  /** R2 key for a job's log. */
  logKey(jobId: string, step: string): string;
  newJobId?: () => string;
  /** Write-token TTL for rebase/revert pushes (seconds, ≤ 600). */
  pushTokenTtlSeconds?: number;
}

export interface PlanCache {
  get(key: string): Promise<unknown | null>;
  put(key: string, spec: unknown): Promise<void>;
}

/** Bump when the recorder's output format changes, so stale plans are never reused. */
export const PLAN_CACHE_VERSION = "v1";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const PLAN_PREFIX = "::plan::";
const EVIDENCE_PREFIX = "::evidence::";
export const RESULT_PREFIX = "::gittifacts-job::";
const ONTO_REF = "refs/gittifacts/onto";

const PlanOutcome = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), stdout: z.string(), stderr: z.string(), exitCode: z.number() })
    .passthrough(),
  z
    .object({ ok: z.literal(false), code: z.string(), message: z.string(), stderr: z.string() })
    .passthrough(),
]);

const RunOutcome = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), exitCode: z.number(), timedOut: z.boolean(), tail: z.string() })
    .passthrough(),
  z
    .object({ ok: z.literal(false), code: z.string(), message: z.string(), tail: z.string() })
    .passthrough(),
]);

const PolicyDocument = z
  .object({
    kind: z.literal("policy"),
    status: z.enum(["ok", "error"]),
    source: z.enum(["file", "default"]),
    policy: z.unknown(),
    issues: z.array(z.string()).default([]),
    note: z.string().optional(),
  })
  .passthrough();

const JobResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("clean"), newSha: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.object({ status: z.literal("conflict"), files: z.array(z.string()) }),
]);
export type JobResult = z.infer<typeof JobResult>;

/** The last `<prefix><json>` line in `text`, parsed. */
export function lastMarked(text: string, prefix: string): unknown {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith(prefix)) return JSON.parse(line.slice(prefix.length));
  }
  return undefined;
}

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Bash for `rebase --onto` of the change's commits, pushing the result with CAS. */
export function rebaseScript(): string {
  return [
    "set -eu",
    "cd /workspace",
    "git fetch -q --no-tags --unshallow origin 2>/dev/null || git fetch -q --no-tags --deepen=100000 origin || true",
    'git fetch -q --no-tags origin "$GJ_ONTO_REF"',
    'base="$(git merge-base "$GJ_ONTO" "$GJ_HEAD")"',
    'git -c advice.detachedHead=false checkout -q --detach "$GJ_HEAD"',
    'if git -c user.name=gittifacts -c user.email=bot@gittifacts.dev rebase -q --onto "$GJ_ONTO" "$base"; then',
    '  new="$(git rev-parse HEAD)"',
    '  git push -q origin "$new:refs/heads/$GJ_BRANCH" --force',
    `  printf '%s{"status":"clean","newSha":"%s"}\\n' ${sh(RESULT_PREFIX)} "$new"`,
    "else",
    `  files="$(git diff --name-only --diff-filter=U | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/.*/"&"/' | paste -sd, -)"`,
    "  git rebase --abort >/dev/null 2>&1 || true",
    `  printf '%s{"status":"conflict","files":[%s]}\\n' ${sh(RESULT_PREFIX)} "$files"`,
    "fi",
  ].join("\n");
}

/** Bash for `git revert` of one merge on top of the fork's tip, pushed with CAS on the branch. */
export function revertScript(): string {
  return [
    "set -eu",
    "cd /workspace",
    'git fetch -q --no-tags --deepen=2 origin "$GJ_SHA" || git fetch -q --no-tags --unshallow origin || true',
    'git -c advice.detachedHead=false checkout -q --detach "$GJ_ONTO"',
    'if git revert --no-edit --no-commit "$GJ_SHA"; then',
    '  git -c user.name=gittifacts -c user.email=bot@gittifacts.dev commit -q -m "$GJ_MESSAGE"',
    '  new="$(git rev-parse HEAD)"',
    '  git push -q origin "$new:refs/heads/$GJ_BRANCH" --force-with-lease="refs/heads/$GJ_BRANCH:$GJ_ONTO"',
    `  printf '%s{"status":"clean","newSha":"%s"}\\n' ${sh(RESULT_PREFIX)} "$new"`,
    "else",
    `  files="$(git diff --name-only --diff-filter=U | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/.*/"&"/' | paste -sd, -)"`,
    "  git revert --abort >/dev/null 2>&1 || true",
    `  printf '%s{"status":"conflict","files":[%s]}\\n' ${sh(RESULT_PREFIX)} "$files"`,
    "fi",
  ].join("\n");
}

export class ContainerSandboxJobs implements SandboxJobs {
  constructor(private readonly opts: ContainerSandboxJobsOptions) {}

  private jobId(kind: string): string {
    return `job-${kind}-${(this.opts.newJobId ?? newId)()}`;
  }

  private async exec(input: {
    kind: string;
    repo: string;
    headSha: string;
    baseSha?: string;
    command: string;
    env?: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<string> {
    const runId = this.jobId(input.kind);
    const raw = await runOnRunner(this.opts.runner(`${runId}:${input.kind}`), "main", {
      runId,
      step: input.kind,
      kind: "user",
      attempt: 1,
      command: input.command,
      env: input.env ?? {},
      instance: "lite",
      timeoutSeconds: input.timeoutSeconds,
      artifactsRepo: input.repo,
      remote: this.opts.git.remoteOf(input.repo),
      headSha: input.headSha,
      ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
      from: { kind: "image" },
      replay: [],
      snapshot: false,
      logKey: this.opts.logKey(runId, input.kind),
    });
    const outcome = RunOutcome.parse(raw);
    if (!outcome.ok)
      throw new Error(`sandbox ${input.kind} job failed (${outcome.code}): ${outcome.message}`);
    if (outcome.timedOut) throw new Error(`sandbox ${input.kind} job timed out`);
    if (outcome.exitCode !== 0)
      throw new Error(
        `sandbox ${input.kind} job exited ${outcome.exitCode}: ${outcome.tail.slice(-500)}`,
      );
    return outcome.tail;
  }

  /** Env that makes git authenticate to the fork with a write token, without putting it in argv. */
  private async pushEnv(fork: string): Promise<Record<string, string>> {
    const ttl = Math.min(this.opts.pushTokenTtlSeconds ?? 600, 600);
    const { token } = await this.opts.git.mintToken(fork, "write", ttl);
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  async planPipeline(input: { repo: string; sha: string }): Promise<unknown> {
    const cacheKey = await this.planCacheKey(input);
    if (cacheKey !== null) {
      const cached = await this.opts.planCache?.get(cacheKey).catch(() => null);
      if (cached !== null && cached !== undefined) return cached;
    }
    const spec = await this.planInSandbox(input);
    if (cacheKey !== null) await this.opts.planCache?.put(cacheKey, spec).catch(() => undefined);
    return spec;
  }

  /** `null` when there is nothing safe to key on (no cache, no file, or the read failed). */
  private async planCacheKey(input: { repo: string; sha: string }): Promise<string | null> {
    if (this.opts.planCache === undefined || this.opts.git.readFile === undefined) return null;
    try {
      const file = await this.opts.git.readFile(input.repo, input.sha, ".platform/ci.ts");
      if (file === null) return null;
      return `${PLAN_CACHE_VERSION}/${await sha256Hex(file)}`;
    } catch {
      return null;
    }
  }

  private async planInSandbox(input: { repo: string; sha: string }): Promise<unknown> {
    const runId = this.jobId("plan");
    const raw = await this.opts.runner(`${runId}:plan`).plan({
      runId,
      artifactsRepo: input.repo,
      remote: this.opts.git.remoteOf(input.repo),
      sha: input.sha,
      file: ".platform/ci.ts",
      timeoutSeconds: 120,
      logKey: this.opts.logKey(runId, "plan"),
    });
    const outcome = PlanOutcome.parse(raw);
    if (!outcome.ok) throw new Error(`plan job failed (${outcome.code}): ${outcome.message}`);
    const doc = lastMarked(outcome.stdout, PLAN_PREFIX);
    if (doc === undefined)
      throw new Error(`plan job printed no ${PLAN_PREFIX} line (exit ${outcome.exitCode})`);
    if (typeof doc === "object" && doc !== null && "error" in doc) {
      throw new Error(`.platform/ci.ts: ${String((doc as { error: unknown }).error)}`);
    }
    return doc;
  }

  async evaluatePolicy(input: { repo: string; sha: string }): Promise<unknown | null> {
    const tail = await this.exec({
      kind: "policy",
      repo: input.repo,
      headSha: input.sha,
      command: `gittifacts-runner policy --base ${input.sha}`,
      timeoutSeconds: 300,
    });
    const doc = PolicyDocument.parse(lastMarked(tail, EVIDENCE_PREFIX));
    if (doc.status === "error")
      throw new Error(`policy at ${input.sha.slice(0, 12)}: ${doc.note ?? doc.issues.join("; ")}`);
    return doc.source === "default" ? null : doc.policy;
  }

  async rebase(input: {
    fork: string;
    mainRepo: string;
    headSha: string;
    ontoSha: string;
    branch: string;
  }): Promise<JobResult> {
    // Bring the new main into the fork so the sandbox only ever talks to the fork.
    await this.opts.git.transferObjects(input.mainRepo, input.fork, input.ontoSha, ONTO_REF);
    const tail = await this.exec({
      kind: "rebase",
      repo: input.fork,
      headSha: input.headSha,
      command: rebaseScript(),
      env: {
        ...(await this.pushEnv(input.fork)),
        GJ_HEAD: input.headSha,
        GJ_ONTO: input.ontoSha,
        GJ_ONTO_REF: ONTO_REF,
        GJ_BRANCH: input.branch,
      },
      timeoutSeconds: 600,
    });
    return JobResult.parse(lastMarked(tail, RESULT_PREFIX));
  }

  async revert(input: {
    fork: string;
    sha: string;
    ontoSha: string;
    branch: string;
    message: string;
  }): Promise<JobResult> {
    const tail = await this.exec({
      kind: "revert",
      repo: input.fork,
      headSha: input.ontoSha,
      command: revertScript(),
      env: {
        ...(await this.pushEnv(input.fork)),
        GJ_SHA: input.sha,
        GJ_ONTO: input.ontoSha,
        GJ_BRANCH: input.branch,
        GJ_MESSAGE: input.message,
      },
      timeoutSeconds: 600,
    });
    return JobResult.parse(lastMarked(tail, RESULT_PREFIX));
  }
}
