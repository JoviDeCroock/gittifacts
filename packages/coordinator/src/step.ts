/**
 * The subset of `WorkflowStep` the coordinator's workflows use. Workflow bodies are written
 * against this interface so they can run under the real engine (`fromWorkflowStep`) and under a
 * hand-rolled fake in node tests.
 */

export type DurationUnit = "second" | "minute" | "hour" | "day" | "week";
export type Duration = `${number} ${DurationUnit}${"" | "s"}` | number;

export interface StepConfig {
  retries?: { limit: number; delay: Duration; backoff?: "constant" | "linear" | "exponential" };
  timeout?: Duration;
}

export interface StepEvent<T> {
  payload: T;
  type: string;
  timestamp: Date;
}

export interface Step {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  /** Rejects when `timeout` elapses without a matching event. */
  waitForEvent<T>(name: string, options: { type: string; timeout?: Duration }): Promise<StepEvent<T>>;
}

/** Retry presets. Every external call gets its own step; steps must be idempotent. */
export const RETRY = {
  /** Store/audit/notify: fast, cheap, safe to repeat. */
  quick: { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" },
  /** Artifacts / gitwire / Cloudflare REST. */
  remote: { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
  /** Container jobs (plan mode, policy evaluation, rebase). */
  sandbox: { retries: { limit: 2, delay: "30 seconds", backoff: "linear" }, timeout: "20 minutes" },
  /** Model calls: retries cost money, so keep them few. */
  model: { retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "10 minutes" },
  /** Non-idempotent uploads (a retry may create a duplicate version). */
  once: { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "10 minutes" },
} as const satisfies Record<string, StepConfig>;

/** Structural slice of `WorkflowStep` from `cloudflare:workers` (kept loose: its generics are RPC-bound). */
export interface WorkflowStepLike {
  do(name: string, config: never, callback: () => Promise<never>): Promise<unknown>;
  sleep(name: string, duration: never): Promise<void>;
  waitForEvent(name: string, options: never): Promise<unknown>;
}

/**
 * Adapts the engine's `WorkflowStep`. The engine constrains step results to `Rpc.Serializable`;
 * every result the coordinator returns is plain JSON, so the casts below are sound.
 */
export function fromWorkflowStep(step: WorkflowStepLike): Step {
  const raw = step as unknown as {
    do(name: string, config: StepConfig, cb: () => Promise<unknown>): Promise<unknown>;
    sleep(name: string, duration: Duration): Promise<void>;
    waitForEvent(name: string, options: { type: string; timeout?: Duration }): Promise<unknown>;
  };
  return {
    do: <T>(name: string, config: StepConfig, cb: () => Promise<T>) =>
      raw.do(name, config, cb) as Promise<T>,
    sleep: (name, duration) => raw.sleep(name, duration),
    waitForEvent: <T>(name: string, options: { type: string; timeout?: Duration }) =>
      raw.waitForEvent(name, options) as Promise<StepEvent<T>>,
  };
}

/**
 * `waitForEvent` that resolves to null on timeout instead of rejecting. A wait can only reject by
 * timing out (termination aborts the whole run), so any rejection is read as a timeout.
 */
export async function waitOrTimeout<T>(
  step: Step,
  name: string,
  type: string,
  timeout: Duration,
): Promise<StepEvent<T> | null> {
  try {
    return await step.waitForEvent<T>(name, { type, timeout });
  } catch {
    return null;
  }
}
