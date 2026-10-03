/**
 * Durable Runner jobs: start a job, then long-poll it with short RPCs, so no call to the Runner
 * stays open for a whole step. In the M5 dogfood a minutes-long `Runner.run` RPC died with
 * `WorkflowInternalError` / "Network connection lost" while the container kept working, and the
 * step's retry started the job over.
 *
 * - `start({ jobId, job })` returns at once. The same `jobId` re-attaches: to the running job, or
 *   to its finished outcome when that outcome is usable (`ok`). A failed outcome (an
 *   infrastructure error) is started again: that is what a retry is for.
 * - `poll(jobId, waitMs)` answers when the job finishes or after `waitMs`, whichever comes first.
 * - A poll that throws (a dropped connection) is retried; `lost` (the Runner restarted and no
 *   longer has the job) throws `RunnerJobLostError`, so the caller's retry starts it again.
 *
 * Self-contained (zod only): `@app/coordinator` and the platform import it through
 * `@app/ci-engine/runner-client` without type-checking the Worker sources.
 */
import { z } from "zod";

export const RunnerJobId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9:._@-]+$/);

export const RunnerJobState = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("running"),
    jobId: z.string(),
    startedAt: z.string(),
    elapsedMs: z.number().nonnegative(),
    /** start() found this job already running (a retry re-attached). */
    attached: z.boolean().optional(),
  }),
  z.object({
    state: z.literal("done"),
    jobId: z.string(),
    /** How many times the Runner launched this job id (usage records are keyed by it). */
    launch: z.number().int().min(1),
    attached: z.boolean().optional(),
    outcome: z.unknown(),
  }),
  z.object({ state: z.literal("lost"), jobId: z.string(), reason: z.string() }),
  z.object({ state: z.literal("unknown"), jobId: z.string() }),
]);
export type RunnerJobState = z.infer<typeof RunnerJobState>;

/** The Runner DO stub, as far as durable jobs are concerned. */
export interface DurableRunnerStub {
  start(input: { jobId: string; job: unknown }): Promise<unknown>;
  poll(jobId: string, waitMs?: number): Promise<unknown>;
}

export interface RunDurablyOptions {
  /** Long-poll window per poll RPC. Default 20 s (the Runner caps it at 30 s). */
  waitMs?: number;
  /** Consecutive failed polls before giving up (the step's retry then re-attaches). Default 8. */
  maxPollFailures?: number;
  /** Delay before re-polling after a failed poll. Default 1 s, 2 s, 4 s … capped at 15 s. */
  retryDelayMs?: (failures: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DurableResult {
  outcome: unknown;
  launch: number;
  /** A retry found the job (running or finished) instead of starting it. */
  attached: boolean;
  polls: number;
}

export class RunnerJobLostError extends Error {
  override readonly name = "RunnerJobLostError";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultRetryDelay = (failures: number) => Math.min(15_000, 1000 * 2 ** (failures - 1));

function parseState(raw: unknown, what: string): RunnerJobState {
  const parsed = RunnerJobState.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `the runner returned an invalid ${what} (${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"})`,
    );
  }
  return parsed.data;
}

/** Starts (or re-attaches to) `jobId` and polls until it finishes. */
export async function runDurably(
  stub: DurableRunnerStub,
  jobId: string,
  job: unknown,
  opts: RunDurablyOptions = {},
): Promise<DurableResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const waitMs = opts.waitMs ?? 20_000;
  const maxFailures = opts.maxPollFailures ?? 8;
  const retryDelay = opts.retryDelayMs ?? defaultRetryDelay;
  let state = parseState(await stub.start({ jobId, job }), "start result");
  const attached = state.state !== "lost" && state.state !== "unknown" && state.attached === true;
  let polls = 0;
  let failures = 0;
  for (;;) {
    if (state.state === "done") {
      return { outcome: state.outcome, launch: state.launch, attached, polls };
    }
    if (state.state === "lost")
      throw new RunnerJobLostError(`runner job ${jobId}: ${state.reason}`);
    if (state.state === "unknown")
      throw new RunnerJobLostError(`runner job ${jobId}: the runner has no record of it`);
    try {
      state = parseState(await stub.poll(jobId, waitMs), "poll result");
      polls += 1;
      failures = 0;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("the runner returned an invalid"))
        throw error;
      failures += 1;
      if (failures >= maxFailures) throw error;
      await sleep(retryDelay(failures));
    }
  }
}

/** A stub that may only have the old one-shot `run()` (test fakes, older deployments). */
export interface RunnerStubLike {
  run(job: Record<string, unknown>): Promise<unknown>;
  start?: DurableRunnerStub["start"];
  poll?: DurableRunnerStub["poll"];
}

/**
 * `runDurably` when the stub supports it, else the one-shot `run()`. Returns the raw outcome for
 * the caller to validate.
 */
export async function runOnRunner(
  stub: RunnerStubLike,
  jobId: string,
  job: Record<string, unknown>,
  opts: RunDurablyOptions = {},
): Promise<unknown> {
  if (typeof stub.start !== "function" || typeof stub.poll !== "function") return stub.run(job);
  const durable: DurableRunnerStub = {
    start: (input) => stub.start!(input),
    poll: (id, wait) => stub.poll!(id, wait),
  };
  return (await runDurably(durable, jobId, job, opts)).outcome;
}
