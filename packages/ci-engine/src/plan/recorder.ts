/**
 * Plan mode: evaluates a `.platform/ci.ts` pipeline function against a recording `ci` object and
 * returns the static `PipelineSpec` DAG it describes.
 *
 * Plain module (no Workers or Node APIs beyond `queueMicrotask`/`setTimeout`). It runs inside the
 * sandbox container (`gittifacts-runner plan`), never in the platform Worker: repository code is
 * only ever executed in a container.
 *
 * ## How dependencies are inferred
 *
 * Every `runner()` call resolves immediately with `exitCode: 0`, but the resolution is delivered
 * to an awaiter in a microtask, and the recorder notes which runners have been *delivered*
 * (some code observed their completion) at that point. A runner's dependencies are:
 *
 * - `parent`: the runner whose result `.runner()` was called on (its snapshot is the start state);
 * - `after`: every runner already delivered when this one was called, reduced transitively.
 *
 * This is exact for sequential `await`s, `Promise.all([...])` fan-out and fan-in, and chaining.
 * It is conservative (never wrong order, sometimes less parallelism) for independent async chains
 * interleaved inside one `Promise.all`, where a later step in one chain may also be ordered after
 * an earlier step of a sibling chain. Branches are recorded as plan mode executes them: every
 * runner succeeds, so code that runs only when a step fails is never recorded.
 */
import { z } from "zod";
import { reduceAfter } from "./dag.js";
import {
  formatIssues,
  graphIssues,
  type InstanceType,
  MAX_STEP_TIMEOUT_MINUTES,
  MAX_STEPS,
  PIPELINE_SPEC_VERSION,
  PipelineSpec,
  StepSpec,
} from "./spec.js";

/** Options accepted by `ci.runner()` / `result.runner()`. A superset of `@cloudflare/ci` RunnerOptions. */
export interface RunnerOptions {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  cache?: { inputs: string[] };
  /** `global` (share with identical inputs in any repo) or `repo`. See `StepSpec.cacheScope`. */
  cacheScope?: "global" | "repo";
  /** Build outputs to upload after success, e.g. `[{ name: "bundle", paths: ["dist"] }]`. */
  artifacts?: { name: string; paths: string[]; optional?: boolean }[];
  /** Container size. Default `standard-2`. */
  instance?: InstanceType;
  /** Command timeout in minutes, 1-30. Default 25. */
  timeoutMinutes?: number;
  /** `@cloudflare/ci` compatibility: `timeout`/`commandTimeoutMs` (ms) map to `timeoutMinutes`. */
  config?: {
    timeout?: number;
    commandTimeoutMs?: number;
    retries?: unknown;
    snapshotRetentionSeconds?: number;
  };
  /** Rejected: CI steps never receive platform credentials or secrets. */
  cloudflareCredentials?: unknown;
  /** Rejected: CI steps never receive platform credentials or secrets. */
  sourceControlCredentials?: unknown;
  /** Rejected: CI steps never receive platform credentials or secrets. */
  secrets?: unknown;
}

export interface RunnerResult {
  readonly exitCode: number;
  readonly logs: { readonly stdout: string; readonly stderr: string };
  readonly snapshot: { readonly id: string; readonly dir: string };
  /** Starts a runner from this runner's snapshot. */
  runner(options: RunnerOptions): RunnerPromise;
}

/**
 * What `runner()` returns: a promise of the result that can also be chained before it settles
 * (`const install = ci.runner(…); install.runner(…)`), as `@cloudflare/ci` pipelines are written.
 * Chaining on the promise has the same meaning as chaining on the awaited result.
 */
export type RunnerPromise = Promise<RunnerResult> & {
  runner(options: RunnerOptions): RunnerPromise;
};

export interface PipelineCi {
  /** Starts a runner from a fresh checkout. */
  runner(options: RunnerOptions): RunnerPromise;
}

export interface PipelineContext {
  readonly mode: "plan";
  /** The commit the pipeline file was read from, when known. */
  readonly sha: string | null;
  readonly baseSha: string | null;
}

export type PipelineFunction = (ci: PipelineCi, ctx: PipelineContext) => unknown;

/** Identity helper for `.platform/ci.ts` authors. */
export function definePipeline(fn: PipelineFunction): PipelineFunction {
  return fn;
}

export class PlanError extends Error {
  override readonly name = "PlanError";
}

export interface RecordOptions {
  context?: Partial<Omit<PipelineContext, "mode">>;
  /** Wall-clock limit for the pipeline function. Default 30 s. */
  timeoutMs?: number;
}

const RunnerOptionsInput = z
  .object({
    name: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    cache: z
      .object({ inputs: z.array(z.string()) })
      .strict()
      .optional(),
    cacheScope: z.string().optional(),
    artifacts: z.array(z.unknown()).optional(),
    instance: z.string().optional(),
    timeoutMinutes: z.number().optional(),
    config: z
      .object({
        timeout: z.number().optional(),
        commandTimeoutMs: z.number().optional(),
        retries: z.unknown().optional(),
        snapshotRetentionSeconds: z.number().optional(),
      })
      .strict()
      .optional(),
    cloudflareCredentials: z.unknown().optional(),
    sourceControlCredentials: z.unknown().optional(),
    secrets: z.unknown().optional(),
  })
  .strict();

const StepFields = StepSpec.omit({ parent: true, after: true });
type StepFields = z.infer<typeof StepFields>;

function describe(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "name" in raw && typeof raw.name === "string") {
    return `runner(${JSON.stringify(raw.name)})`;
  }
  return "runner()";
}

function normalizeCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  let p = cwd.trim();
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  return p === "" || p === "." ? undefined : p;
}

function minutesFromMs(ms: number, label: string, where: string, warnings: string[]): number {
  if (!Number.isFinite(ms) || ms <= 0)
    throw new PlanError(`${where}: config.${label} must be a positive number of ms`);
  const minutes = Math.ceil(ms / 60_000);
  const clamped = Math.min(MAX_STEP_TIMEOUT_MINUTES, Math.max(1, minutes));
  if (clamped !== minutes) warnings.push(`${where}: config.${label} clamped to ${clamped} minutes`);
  return clamped;
}

/** Validates one `runner()` call's options and maps compatibility fields. Throws `PlanError`. */
export function parseRunnerOptions(raw: unknown, warnings: string[]): StepFields {
  const where = describe(raw);
  const input = RunnerOptionsInput.safeParse(raw);
  if (!input.success)
    throw new PlanError(`${where}: invalid options\n${formatIssues(input.error)}`);
  const o = input.data;
  for (const key of ["secrets", "cloudflareCredentials", "sourceControlCredentials"] as const) {
    if (o[key] !== undefined && o[key] !== false) {
      throw new PlanError(
        `${where}: "${key}" is not supported. CI steps never receive platform credentials or secrets.`,
      );
    }
  }
  let timeoutMinutes = o.timeoutMinutes;
  if (o.config !== undefined) {
    if (timeoutMinutes === undefined) {
      if (o.config.commandTimeoutMs !== undefined) {
        timeoutMinutes = minutesFromMs(
          o.config.commandTimeoutMs,
          "commandTimeoutMs",
          where,
          warnings,
        );
      } else if (o.config.timeout !== undefined) {
        timeoutMinutes = minutesFromMs(o.config.timeout, "timeout", where, warnings);
      }
    }
    if (o.config.retries !== undefined) {
      warnings.push(
        `${where}: config.retries is ignored; the platform retries infrastructure failures once and never retries a failing command`,
      );
    }
    if (o.config.snapshotRetentionSeconds !== undefined) {
      warnings.push(
        `${where}: config.snapshotRetentionSeconds is ignored; snapshots are kept for 30 days`,
      );
    }
  }
  const cwd = normalizeCwd(o.cwd);
  const fields = StepFields.safeParse({
    name: o.name,
    command: o.command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(o.env === undefined || Object.keys(o.env).length === 0 ? {} : { env: o.env }),
    ...(o.cache === undefined ? {} : { cache: o.cache }),
    ...(o.cacheScope === undefined ? {} : { cacheScope: o.cacheScope }),
    ...(o.artifacts === undefined ? {} : { artifacts: o.artifacts }),
    ...(o.instance === undefined ? {} : { instance: o.instance }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
  });
  if (!fields.success)
    throw new PlanError(`${where}: invalid options\n${formatIssues(fields.error)}`);
  return fields.data;
}

interface Recorded extends StepFields {
  parent: string | null;
  after: string[];
}

class Recording {
  readonly steps: Recorded[] = [];
  readonly warnings: string[] = [];
  private readonly delivered: string[] = [];
  private pendingDeliveries = 0;
  private closed = false;

  readonly ci: PipelineCi = Object.freeze({
    runner: (options: RunnerOptions) => this.call(null, options),
  });

  get pending(): number {
    return this.pendingDeliveries;
  }

  close(): void {
    this.closed = true;
  }

  private call(parent: string | null, raw: unknown): RunnerPromise {
    const where = describe(raw);
    if (this.closed) {
      throw new PlanError(
        `${where} was called after the pipeline function finished; await every runner`,
      );
    }
    if (this.steps.length >= MAX_STEPS) {
      throw new PlanError(`${where}: a pipeline has at most ${MAX_STEPS} steps`);
    }
    const fields = parseRunnerOptions(raw, this.warnings);
    const after = this.delivered.filter((d) => d !== parent);
    this.steps.push({ ...fields, parent, after });
    const name = fields.name;
    const result: RunnerResult = Object.freeze({
      exitCode: 0,
      logs: Object.freeze({ stdout: "", stderr: "" }),
      snapshot: Object.freeze({ id: `plan:${name}`, dir: "/workspace" }),
      runner: (options: RunnerOptions) => this.call(name, options),
    });
    return this.promiseFor(name, result);
  }

  /**
   * A thenable whose resolution is delivered in a microtask. Delivery is the moment the awaiting
   * code can observe completion, which is what orders later `runner()` calls after this one.
   */
  private promiseFor(name: string, result: RunnerResult): RunnerPromise {
    const deliver = (): void => {
      this.pendingDeliveries -= 1;
      if (!this.delivered.includes(name)) this.delivered.push(name);
    };
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: plan mode needs a thenable whose delivery it can observe.
      then: <A = RunnerResult, B = never>(
        onFulfilled?: ((value: RunnerResult) => A | PromiseLike<A>) | null,
        _onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): Promise<A | B> => {
        this.pendingDeliveries += 1;
        return new Promise<A | B>((resolve, reject) => {
          queueMicrotask(() => {
            deliver();
            if (typeof onFulfilled !== "function") {
              resolve(result as unknown as A);
              return;
            }
            try {
              resolve(onFulfilled(result));
            } catch (error) {
              reject(error);
            }
          });
        });
      },
      catch: <B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null) =>
        thenable.then<RunnerResult, B>(undefined, onRejected),
      finally: (onFinally?: (() => void) | null) =>
        thenable.then((value) => {
          onFinally?.();
          return value;
        }),
      // Chaining before the result settles: same parent as chaining on the result.
      runner: (options: RunnerOptions) => this.call(name, options),
      [Symbol.toStringTag]: "PlanRunnerPromise",
    };
    return thenable as unknown as RunnerPromise;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Runs `fn` in plan mode and returns the validated spec. Throws `PlanError` with a message meant
 * for the pipeline author when the function throws, misuses the API, or produces an invalid DAG.
 */
export async function recordPipeline(
  fn: PipelineFunction,
  options: RecordOptions = {},
): Promise<PipelineSpec> {
  const recording = new Recording();
  const ctx: PipelineContext = Object.freeze({
    mode: "plan" as const,
    sha: options.context?.sha ?? null,
    baseSha: options.context?.baseSha ?? null,
  });
  const timeoutMs = options.timeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new PlanError(
            `the pipeline function did not finish within ${timeoutMs} ms (plan mode resolves runners immediately; is it waiting on something else?)`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      (async () => {
        try {
          const ret = fn(recording.ci, ctx);
          if (isThenable(ret)) await ret;
        } catch (error) {
          if (error instanceof PlanError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new PlanError(`the pipeline function threw: ${message}`);
        }
        // Let fire-and-forget chains (`ci.runner(a).then(r => r.runner(b))`) finish recording.
        for (let i = 0; i < 100; i++) {
          await macrotask();
          if (recording.pending === 0) break;
        }
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    recording.close();
  }

  const issues = graphIssues(recording.steps);
  if (issues.length > 0) {
    throw new PlanError(`invalid pipeline\n${issues.map((i) => i.message).join("\n")}`);
  }
  const reduced = reduceAfter(recording.steps);
  const steps = recording.steps.map((s) => ({ ...s, after: reduced.get(s.name) ?? s.after }));
  const parsed = PipelineSpec.safeParse({
    version: PIPELINE_SPEC_VERSION,
    source: "file",
    steps,
    warnings: recording.warnings,
  });
  if (!parsed.success) throw new PlanError(`invalid pipeline\n${formatIssues(parsed.error)}`);
  return parsed.data;
}

/** Picks the pipeline function out of an imported `.platform/ci.ts` module. */
export function resolvePipelineExport(mod: unknown): PipelineFunction {
  const candidates: unknown[] = [mod];
  if (typeof mod === "object" && mod !== null) {
    if ("default" in mod) {
      candidates.push(mod.default);
      if (typeof mod.default === "object" && mod.default !== null && "default" in mod.default) {
        candidates.push(mod.default.default);
      }
    }
    if ("pipeline" in mod) candidates.push(mod.pipeline);
  }
  for (const c of candidates) if (typeof c === "function") return c as PipelineFunction;
  throw new PlanError(
    "the pipeline file must `export default async function pipeline(ci) { ... }`",
  );
}
