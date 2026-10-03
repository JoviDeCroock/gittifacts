/**
 * Import detection runs `gittifacts-runner detect` in the sandbox on the imported repo's default
 * branch: a one-off job on the CI engine's `Runner` Durable Object (same image, read token minted
 * by the Runner itself, unprivileged user, egress limited to the git host since detection installs
 * nothing). Its `::detect::` line is the job's last output line, validated with `DetectReport`.
 *
 * Tests replace the job through `configureImportRuntime` (workerd can't run containers).
 */
import { RunKeys } from "@app/ci-engine";
import { type RunnerStubLike, runOnRunner } from "@app/ci-engine/runner-client";
import { type DetectReport, parseDetectOutput } from "@app/conventions";
import { newId } from "@app/coordinator";
import { z } from "zod";

export interface ImportSandbox {
  detect(input: { repo: string; remote: string; sha: string }): Promise<DetectReport>;
}

export interface ImportRuntime {
  sandbox?(env: unknown): ImportSandbox;
}

const KEY = "__gittifactsImportRuntime";

export function configureImportRuntime(runtime: ImportRuntime): void {
  (globalThis as unknown as Record<string, ImportRuntime>)[KEY] = runtime;
}

function importRuntime(): ImportRuntime {
  return (globalThis as unknown as Record<string, ImportRuntime | undefined>)[KEY] ?? {};
}

const RunOutcome = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), exitCode: z.number(), tail: z.string() }).passthrough(),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).passthrough(),
]);

type RunnerStub = RunnerStubLike;

/** The production job, on `env.RUNNER`. */
export function runnerImportSandbox(env: {
  RUNNER: { getByName(name: string): unknown };
}): ImportSandbox {
  return {
    async detect(input) {
      const runId = `job-detect-${newId()}`;
      const stub = env.RUNNER.getByName(`${runId}:detect`) as RunnerStub;
      const raw = await runOnRunner(stub, "main", {
        runId,
        step: "detect",
        kind: "user",
        attempt: 1,
        command: `gittifacts-runner detect --sha ${input.sha}`,
        env: {},
        instance: "standard-1",
        timeoutSeconds: 300,
        artifactsRepo: input.repo,
        remote: input.remote,
        headSha: input.sha,
        from: { kind: "image" },
        replay: [],
        snapshot: false,
        logKey: RunKeys.log(runId, "detect"),
        network: "registries-only",
      });
      const outcome = RunOutcome.parse(raw);
      if (!outcome.ok) throw new Error(`detect job failed (${outcome.code}): ${outcome.message}`);
      const report = parseDetectOutput(outcome.tail);
      if (report === null) {
        throw new Error(
          `detect job printed no valid ::detect:: line (exit ${outcome.exitCode}): ${outcome.tail.slice(-500)}`,
        );
      }
      return report;
    },
  };
}

export function importSandbox(env: unknown): ImportSandbox {
  const seam = importRuntime().sandbox;
  if (seam !== undefined) return seam(env);
  return runnerImportSandbox(env as { RUNNER: { getByName(name: string): unknown } });
}
