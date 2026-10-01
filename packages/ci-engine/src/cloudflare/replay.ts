/**
 * Replays a `PipelineSpec` (+ evidence steps) through an `@cloudflare/ci` `CiContext`, with the
 * same step semantics as `CiRunWorkflow`:
 *
 * - a root step is `ci.runner(opts)`; a step with a parent is `parentResult.runner(opts)`, so it
 *   restores the parent's workspace snapshot;
 * - every step starts as soon as its parent and `after` steps passed, so independent steps run in
 *   parallel (each is its own `step.do` inside `@cloudflare/ci`);
 * - a step whose dependency did not pass is skipped;
 * - evidence steps run after all user steps; `requiresGreen` ones only if every user step passed.
 *
 * `@cloudflare/ci` throws (after its retries) when a command exits non-zero; that is recorded as a
 * failed step instead of failing the whole replay. Pure: no Workers or `@cloudflare/ci` imports.
 */

import type { EvidenceStepSpec } from "../evidence-steps.js";
import { topologicalOrder } from "../plan/dag.js";
import {
  DEFAULT_STEP_TIMEOUT_MINUTES,
  type PipelineSpec,
  type StepSpec,
  stepDependencies,
} from "../plan/spec.js";
import { errorMessage, pumpText } from "../runner/container.js";
import { EvidenceLineScanner, TailBuffer } from "../runner/log-sink.js";
import type { CfCiContext, CfLogs, CfRunnerOptions, CfRunnerResult } from "./types.js";

export type ReplayStatus = "passed" | "failed" | "skipped";

export interface ReplayStepResult {
  name: string;
  kind: "user" | "evidence";
  status: ReplayStatus;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  reason: string | null;
  /** Failure output (tail) for failed steps. */
  output: string;
  /** For evidence steps: the last `::evidence::` payload printed, if any. */
  evidenceRaw: string | null;
  snapshotId: string | null;
}

export interface ReplayContext {
  runId: string;
  headSha: string;
  baseSha: string;
}

export interface ReplayHooks {
  onStepStart?(name: string, kind: "user" | "evidence", startedAt: string): Promise<void> | void;
  onStepFinish?(result: ReplayStepResult): Promise<void> | void;
  now?(): number;
}

export interface ReplayResult {
  steps: ReplayStepResult[];
  green: boolean;
}

const MAX_EVIDENCE_LINE = 4 * 1024 * 1024;

/** Maps a pipeline step to `@cloudflare/ci` runner options. */
export function toRunnerOptions(
  step: {
    name: string;
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    cache?: { inputs: string[] } | undefined;
    timeoutMinutes?: number | undefined;
  },
  extraEnv: Record<string, string> = {},
): CfRunnerOptions {
  const minutes = step.timeoutMinutes ?? DEFAULT_STEP_TIMEOUT_MINUTES;
  const env = { ...(step.env ?? {}), ...extraEnv };
  return {
    name: step.name,
    command: step.command,
    ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(step.cache === undefined ? {} : { cache: { inputs: [...step.cache.inputs] } }),
    config: {
      retries: { limit: 1, delay: 10_000, backoff: "constant" },
      timeout: (minutes + 5) * 60_000,
      commandTimeoutMs: minutes * 60_000,
    },
  };
}

function isStream(v: CfLogs["stdout"]): v is ReadableStream<Uint8Array> {
  return typeof v !== "string";
}

/** Large logs come back as streams that keep the sandbox alive until read or cancelled. */
async function releaseLogs(logs: CfLogs): Promise<void> {
  await Promise.all(
    [logs.stdout, logs.stderr].map(async (l) => {
      if (isStream(l)) await l.cancel().catch(() => {});
    }),
  );
}

async function evidenceFromLogs(logs: CfLogs): Promise<string | null> {
  const scanner = new EvidenceLineScanner(MAX_EVIDENCE_LINE);
  if (isStream(logs.stdout)) await pumpText(logs.stdout, (t) => scanner.push(t));
  else scanner.push(logs.stdout);
  if (isStream(logs.stderr)) await logs.stderr.cancel().catch(() => {});
  return scanner.finish();
}

/** The output `@cloudflare/ci` attached to a `CiRunnerFailure` for `name`, else the message. */
export function failureOutput(error: unknown, name: string): string {
  if (typeof error === "object" && error !== null && "diagnostics" in error) {
    const d = (
      error as { diagnostics?: { failures?: { runner?: { name?: unknown }; output?: unknown }[] } }
    ).diagnostics;
    const own = d?.failures?.find((f) => f.runner?.name === name);
    if (typeof own?.output === "string") return own.output;
  }
  return errorMessage(error);
}

type Settled = { result: ReplayStepResult; handle: CfRunnerResult | null };

export async function replayPipeline(
  ci: CfCiContext,
  pipeline: PipelineSpec,
  evidenceSteps: readonly EvidenceStepSpec[],
  ctx: ReplayContext,
  hooks: ReplayHooks = {},
): Promise<ReplayResult> {
  const now = hooks.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const settled = new Map<string, Promise<Settled>>();
  const platformEnv = {
    GITTIFACTS: "1",
    GITTIFACTS_RUN_ID: ctx.runId,
    GITTIFACTS_HEAD_SHA: ctx.headSha,
  };

  const finish = async (
    result: ReplayStepResult,
    handle: CfRunnerResult | null,
  ): Promise<Settled> => {
    await hooks.onStepFinish?.(result);
    return { result, handle };
  };
  const skipped = (name: string, kind: "user" | "evidence", reason: string) =>
    finish(
      {
        name,
        kind,
        status: "skipped",
        exitCode: null,
        durationMs: null,
        startedAt: null,
        finishedAt: null,
        reason,
        output: "",
        evidenceRaw: null,
        snapshotId: null,
      },
      null,
    );

  const run = async (
    name: string,
    kind: "user" | "evidence",
    options: CfRunnerOptions,
    parent: string | null,
    deps: string[],
    gate: string | null,
  ): Promise<Settled> => {
    const before = await Promise.all(deps.map((d) => settled.get(d)!));
    const blocked = before.find((b) => b.result.status !== "passed");
    if (blocked !== undefined)
      return skipped(name, kind, `"${blocked.result.name}" ${blocked.result.status}`);
    if (gate !== null) return skipped(name, kind, gate);
    const parentHandle = parent === null ? null : (before[deps.indexOf(parent)]?.handle ?? null);
    const startedAt = iso();
    const t0 = now();
    await hooks.onStepStart?.(name, kind, startedAt);
    try {
      const handle =
        parentHandle === null ? await ci.runner(options) : await parentHandle.runner(options);
      const evidenceRaw = kind === "evidence" ? await evidenceFromLogs(handle.logs) : null;
      if (kind !== "evidence") await releaseLogs(handle.logs);
      return finish(
        {
          name,
          kind,
          status: handle.exitCode === 0 ? "passed" : "failed",
          exitCode: handle.exitCode,
          durationMs: now() - t0,
          startedAt,
          finishedAt: iso(),
          reason: null,
          output: "",
          evidenceRaw,
          snapshotId: handle.snapshot.id,
        },
        handle,
      );
    } catch (error) {
      const tail = new TailBuffer(16 * 1024);
      tail.push(failureOutput(error, name));
      return finish(
        {
          name,
          kind,
          status: "failed",
          exitCode: null,
          durationMs: now() - t0,
          startedAt,
          finishedAt: iso(),
          reason: errorMessage(error).slice(0, 2000),
          output: tail.toString(),
          evidenceRaw: null,
          snapshotId: null,
        },
        null,
      );
    }
  };

  const byName = new Map<string, StepSpec>(pipeline.steps.map((s) => [s.name, s] as const));
  for (const name of topologicalOrder(pipeline.steps)) {
    const s = byName.get(name)!;
    settled.set(
      name,
      run(name, "user", toRunnerOptions(s, platformEnv), s.parent, stepDependencies(s), null),
    );
  }
  const user = await Promise.all(pipeline.steps.map((s) => settled.get(s.name)!));
  const green = user.every((u) => u.result.status === "passed");

  const evidence = await Promise.all(
    evidenceSteps.map((e) => {
      const options = toRunnerOptions(e, { ...platformEnv, GITTIFACTS_BASE_SHA: ctx.baseSha });
      // The evidence CLI fetches the base commit itself with $ARTIFACTS_TOKEN (read-only).
      options.sourceControlCredentials = true;
      const gate = e.requiresGreen && !green ? "requires every pipeline step to pass" : null;
      return run(e.name, "evidence", options, e.parent, e.parent === null ? [] : [e.parent], gate);
    }),
  );
  return { steps: [...user, ...evidence].map((s) => s.result), green };
}
