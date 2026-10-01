/**
 * `Runner`: one Durable Object per (run, step), named `${runId}:${step}`, driving one container
 * through `this.ctx.container` (`scheduling_policy: "durable_object"`). It never uses
 * `@cloudflare/containers` or `@cloudflare/sandbox`.
 *
 * A job: start from `images.base` or the parent step's container snapshot → check out the head
 * commit with a short-lived read token passed only in that exec's env → run the command under
 * coreutils `timeout`, streaming redacted combined output to R2 → (evidence steps) collect the
 * evidence JSON → snapshot on success when asked → destroy the container.
 *
 * Platform secrets never enter the container: the only credential is the per-step read token,
 * and only the checkout exec sees it.
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { formatIssues } from "../plan/spec.js";
import { type ObjectStore, writeJson } from "../storage.js";
import {
  type ContainerLike,
  DeadlineError,
  deadline,
  errorMessage,
  pumpText,
  readCapped,
} from "./container.js";
import { parseEvidenceDocument } from "./evidence.js";
import {
  type EvidenceCapture,
  type LogInfo,
  PlanJob,
  type PlanOutcome,
  type RunnerErrorCode,
  RunnerJob,
  type RunnerOutcome,
} from "./job.js";
import { EvidenceLineScanner, type LogBucket, R2LogSink, TailBuffer } from "./log-sink.js";
import { createStreamRedactor, redactText, type StreamRedactor, secretVariants } from "./redact.js";
import {
  CHECKOUT_SCRIPT,
  checkoutEnv,
  EVIDENCE_OUT,
  isTimeoutExit,
  KILL_AFTER_SECONDS,
  shellQuote,
  timedCommandArgv,
  WORKSPACE,
  workspacePath,
} from "./shell.js";

export interface RunnerEnv {
  ARTIFACTS: Artifacts;
  CI_BUCKET: R2Bucket;
}

/** The token is only needed for the checkout at the start of a step. */
export const TOKEN_TTL_SECONDS = 15 * 60;
export const START_TIMEOUT_MS = 3 * 60_000;
export const CHECKOUT_TIMEOUT_SECONDS = 300;
export const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const MAX_PLAN_STDOUT_BYTES = 512 * 1024;
/** How long past the command timeout the Runner waits before destroying the container itself. */
export const WATCHDOG_GRACE_SECONDS = 60;
const MAX_INACTIVITY_MS = 6 * 60 * 60 * 1000;

const AbortRecord = z.object({ reason: z.string(), at: z.string() });

class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function snapshotName(runId: string, step: string): string {
  return `${runId}-${step}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 63);
}

function label(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63);
}

/** Redacted, size-capped step log streamed to R2, with a tail and the `::evidence::` scanner. */
class StepLog {
  private readonly sink: R2LogSink;
  private readonly redactor: StreamRedactor;
  private readonly tailBuffer = new TailBuffer(16 * 1024);
  readonly scanner = new EvidenceLineScanner(MAX_EVIDENCE_BYTES);
  private closed: LogInfo | null = null;

  constructor(
    bucket: LogBucket,
    key: string,
    private readonly secrets: readonly string[],
  ) {
    this.sink = new R2LogSink(bucket, key);
    this.redactor = createStreamRedactor(secrets);
  }

  get tail(): string {
    return this.tailBuffer.toString();
  }

  redact(text: string): string {
    return redactText(text, this.secrets);
  }

  async write(raw: string): Promise<void> {
    await this.emit(this.redactor.push(raw));
  }

  /** A platform line, after flushing any partial process output. */
  async line(message: string): Promise<void> {
    await this.emit(this.redactor.flush());
    await this.emit(this.redact(`[gittifacts] ${message}\n`));
  }

  async close(): Promise<LogInfo> {
    if (this.closed !== null) return this.closed;
    await this.emit(this.redactor.flush());
    const res = await this.sink.close();
    this.closed = { key: res.key, bytes: res.bytes, truncated: res.truncated };
    return this.closed;
  }

  async closeQuietly(): Promise<LogInfo | null> {
    try {
      return await this.close();
    } catch {
      await this.sink.abort();
      return null;
    }
  }

  private async emit(text: string): Promise<void> {
    if (text === "" || this.closed !== null) return;
    this.tailBuffer.push(text);
    this.scanner.push(text);
    await this.sink.write(text);
  }
}

export class Runner<E extends RunnerEnv = RunnerEnv> extends DurableObject<E> {
  private active: { controller: AbortController; done: Promise<void> } | null = null;

  // ------------------------------------------------------------------ seams (overridden in tests)

  /** The container. Production: `ctx.container`. */
  protected container(): ContainerLike {
    const c = this.ctx.container;
    if (c === undefined) {
      throw new RunnerError(
        "internal",
        'no container is attached to this Durable Object (containers[] must name class "Runner" with scheduling_policy "durable_object")',
      );
    }
    return c;
  }

  /** A short-lived read token for the repository. Never stored or logged. */
  protected async mintReadToken(artifactsRepo: string): Promise<string> {
    using repo = await this.env.ARTIFACTS.get(artifactsRepo);
    const token = await repo.createToken("read", TOKEN_TTL_SECONDS);
    return token.plaintext;
  }

  protected logBucket(): LogBucket {
    return this.env.CI_BUCKET;
  }

  protected objectStore(): ObjectStore {
    return this.env.CI_BUCKET;
  }

  // ------------------------------------------------------------------ RPC

  /** Runs one step. Never throws: failures come back as `{ ok: false, code }`. */
  async run(input: unknown): Promise<RunnerOutcome> {
    const started = Date.now();
    const parsed = RunnerJob.safeParse(input);
    if (!parsed.success) {
      return failure("invalid-job", `invalid runner job\n${formatIssues(parsed.error)}`, started);
    }
    const job = parsed.data;
    const aborted = await this.abortRecord();
    if (aborted !== null)
      return failure("aborted", `the run was cancelled: ${aborted.reason}`, started);
    return this.exclusive((signal) => this.execute(job, signal, started));
  }

  /** Evaluates a pipeline file in plan mode (`gittifacts-runner plan`). Never throws. */
  async plan(input: unknown): Promise<PlanOutcome> {
    const started = Date.now();
    const parsed = PlanJob.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: "invalid-job", message: formatIssues(parsed.error), stderr: "" };
    }
    const aborted = await this.abortRecord();
    if (aborted !== null) {
      return {
        ok: false,
        code: "aborted",
        message: `the run was cancelled: ${aborted.reason}`,
        stderr: "",
      };
    }
    return this.exclusive((signal) => this.executePlan(parsed.data, signal, started));
  }

  /** Stops any running job, destroys the container and refuses later jobs for this run/step. */
  async abort(reason: string): Promise<void> {
    await this.ctx.storage.put("aborted", {
      reason: reason.slice(0, 500),
      at: new Date().toISOString(),
    });
    this.active?.controller.abort(reason);
    const c = this.containerOrNull();
    if (c?.running) await destroyQuietly(c);
  }

  /** Clears a previous `abort()` so the step can run again (used by `restartFrom`). */
  async clearAbort(): Promise<void> {
    await this.ctx.storage.delete("aborted");
  }

  // ------------------------------------------------------------------ internals

  private containerOrNull(): ContainerLike | null {
    try {
      return this.container();
    } catch {
      return null;
    }
  }

  private async abortRecord(): Promise<z.infer<typeof AbortRecord> | null> {
    const parsed = AbortRecord.safeParse(await this.ctx.storage.get("aborted"));
    return parsed.success ? parsed.data : null;
  }

  /** One job at a time per Durable Object: a new attempt first stops a stale one. */
  private async exclusive<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.active;
    if (previous !== null) {
      previous.controller.abort("superseded by a new attempt");
      await previous.done;
    }
    const controller = new AbortController();
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.active = { controller, done };
    try {
      return await fn(controller.signal);
    } finally {
      release();
      if (this.active?.controller === controller) this.active = null;
    }
  }

  private async execute(
    job: RunnerJob,
    signal: AbortSignal,
    started: number,
  ): Promise<RunnerOutcome> {
    await this.ctx.storage.put("job", {
      runId: job.runId,
      step: job.step,
      attempt: job.attempt,
      startedAt: new Date(started).toISOString(),
    });
    let token: string;
    try {
      token = await this.mintReadToken(job.artifactsRepo);
    } catch (error) {
      return failure(
        "token",
        `could not mint a read token for ${job.artifactsRepo}: ${errorMessage(error)}`,
        started,
      );
    }
    const log = new StepLog(this.logBucket(), job.logKey, secretVariants(token));
    const fail = async (code: RunnerErrorCode, message: string): Promise<RunnerOutcome> => {
      const safe = log.redact(message);
      await log.line(`error (${code}): ${safe}`).catch(() => {});
      return {
        ok: false,
        code,
        message: safe,
        durationMs: Date.now() - started,
        log: await log.closeQuietly(),
        tail: log.tail,
      };
    };

    let c: ContainerLike;
    try {
      c = this.container();
    } catch (error) {
      return fail(error instanceof RunnerError ? error.code : "internal", errorMessage(error));
    }
    try {
      await log.line(`${job.kind} step "${job.step}" attempt ${job.attempt} on ${job.instance}`);
      await this.startContainer(c, job, log, signal);

      await log.line(
        `checkout ${job.headSha}${job.baseSha === undefined ? "" : ` (base ${job.baseSha})`}`,
      );
      const checkout = await this.runProcess(
        c,
        timedCommandArgv(CHECKOUT_SCRIPT, CHECKOUT_TIMEOUT_SECONDS),
        {
          cwd: "/",
          env: checkoutEnv({
            remote: job.remote,
            headSha: job.headSha,
            baseSha: job.baseSha,
            token,
          }),
        },
        log,
        signal,
        CHECKOUT_TIMEOUT_SECONDS,
      );
      if (checkout !== 0)
        throw new RunnerError(
          "checkout",
          `checkout of ${job.headSha} failed with exit code ${checkout}`,
        );

      for (const r of job.replay) {
        await log.line(`replaying "${r.name}" (its snapshot is no longer available): ${r.command}`);
        const code = await this.runProcess(
          c,
          timedCommandArgv(r.command, job.timeoutSeconds),
          { cwd: workspacePath(r.cwd), env: stepEnv(job, r.env ?? {}) },
          log,
          signal,
          job.timeoutSeconds,
        );
        if (code !== 0)
          throw new RunnerError("replay", `replaying "${r.name}" failed with exit code ${code}`);
      }

      if (job.kind === "evidence") {
        await this.runQuiet(c, ["sh", "-c", `rm -rf /tmp/gittifacts && mkdir -p /tmp/gittifacts`]);
      }

      await log.line(`$ ${job.command}`);
      const commandStarted = Date.now();
      const exitCode = await this.runProcess(
        c,
        timedCommandArgv(job.command, job.timeoutSeconds),
        { cwd: workspacePath(job.cwd), env: stepEnv(job, job.env) },
        log,
        signal,
        job.timeoutSeconds,
      );
      const timedOut =
        isTimeoutExit(exitCode) && Date.now() - commandStarted >= job.timeoutSeconds * 1000 - 2000;
      await log.line(
        timedOut
          ? `timed out after ${job.timeoutSeconds}s (exit ${exitCode})`
          : `exit code ${exitCode}`,
      );

      const evidence = job.kind === "evidence" ? await this.captureEvidence(c, job, log) : null;
      if (evidence !== null && "error" in evidence) await log.line(`evidence: ${evidence.error}`);

      let snapshot: { id: string; size: number } | null = null;
      if (exitCode === 0 && job.snapshot) {
        try {
          const s = await c.snapshotContainer({ name: snapshotName(job.runId, job.step) });
          snapshot = { id: s.id, size: s.size };
          await this.ctx.storage.put("snapshot", {
            ...snapshot,
            takenAt: new Date().toISOString(),
          });
          await log.line(`snapshot ${s.id} (${s.size} bytes)`);
        } catch (error) {
          throw new RunnerError(
            "snapshot",
            `could not snapshot the container: ${errorMessage(error)}`,
          );
        }
      }
      const info = await log.close();
      return {
        ok: true,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        log: info,
        tail: log.tail,
        snapshot,
        evidence,
      };
    } catch (error) {
      if (signal.aborted) return fail("aborted", `stopped: ${String(signal.reason ?? "aborted")}`);
      if (error instanceof RunnerError) return fail(error.code, error.message);
      return fail("internal", errorMessage(error));
    } finally {
      await destroyQuietly(c);
    }
  }

  private async executePlan(
    job: PlanJob,
    signal: AbortSignal,
    started: number,
  ): Promise<PlanOutcome> {
    let token: string;
    try {
      token = await this.mintReadToken(job.artifactsRepo);
    } catch (error) {
      return { ok: false, code: "token", message: errorMessage(error), stderr: "" };
    }
    const log = new StepLog(this.logBucket(), job.logKey, secretVariants(token));
    let c: ContainerLike | null = null;
    try {
      c = this.container();
      const runJob: RunnerJob = {
        runId: job.runId,
        step: "plan",
        kind: "user",
        attempt: 1,
        command: "true",
        env: {},
        instance: "lite",
        timeoutSeconds: job.timeoutSeconds,
        artifactsRepo: job.artifactsRepo,
        remote: job.remote,
        headSha: job.sha,
        from: { kind: "image" },
        replay: [],
        snapshot: false,
        logKey: job.logKey,
      };
      await this.startContainer(c, runJob, log, signal);
      const checkout = await this.runProcess(
        c,
        timedCommandArgv(CHECKOUT_SCRIPT, CHECKOUT_TIMEOUT_SECONDS),
        { cwd: "/", env: checkoutEnv({ remote: job.remote, headSha: job.sha, token }) },
        log,
        signal,
        CHECKOUT_TIMEOUT_SECONDS,
      );
      if (checkout !== 0)
        throw new RunnerError(
          "checkout",
          `checkout of ${job.sha} failed with exit code ${checkout}`,
        );
      const command = `gittifacts-runner plan ${shellQuote(job.file)} --sha ${job.sha}${
        job.baseSha === undefined ? "" : ` --base ${job.baseSha}`
      }`;
      await log.line(`$ ${command}`);
      const proc = await c.exec(timedCommandArgv(command, job.timeoutSeconds), {
        cwd: WORKSPACE,
        env: stepEnv(runJob, {}),
        stdout: "pipe",
        stderr: "pipe",
      });
      const watchdog = deadline(
        (job.timeoutSeconds + KILL_AFTER_SECONDS + WATCHDOG_GRACE_SECONDS) * 1000,
        "plan did not exit",
      );
      let stdout: { text: string; truncated: boolean };
      let exitCode: number;
      try {
        [stdout, , exitCode] = await Promise.race([
          Promise.all([
            readCapped(proc.stdout, MAX_PLAN_STDOUT_BYTES),
            pumpText(proc.stderr, (t) => log.write(t)),
            proc.exitCode,
          ]),
          watchdog.promise,
        ]);
      } finally {
        watchdog.clear();
      }
      await log.line(`exit code ${exitCode}`);
      await log.close();
      const stderr = log.tail;
      if (stdout.truncated) {
        return {
          ok: false,
          code: "exec",
          message: `plan output exceeds ${MAX_PLAN_STDOUT_BYTES} bytes`,
          stderr,
        };
      }
      return { ok: true, stdout: log.redact(stdout.text), stderr, exitCode };
    } catch (error) {
      const code: RunnerErrorCode = signal.aborted
        ? "aborted"
        : error instanceof RunnerError
          ? error.code
          : error instanceof DeadlineError
            ? "exec"
            : "internal";
      const message = log.redact(errorMessage(error));
      await log.line(`error (${code}): ${message}`).catch(() => {});
      await log.closeQuietly();
      return { ok: false, code, message, stderr: log.tail };
    } finally {
      if (c !== null) await destroyQuietly(c);
      void started;
    }
  }

  private async startContainer(
    c: ContainerLike,
    job: RunnerJob,
    log: StepLog,
    signal: AbortSignal,
  ): Promise<void> {
    if (c.running) {
      await log.line("destroying a container left over from an earlier attempt");
      await destroyQuietly(c);
    }
    if (signal.aborted) throw new RunnerError("aborted", "aborted before start");
    const fromSnapshot = job.from.kind === "snapshot";
    const startCode: RunnerErrorCode = fromSnapshot ? "snapshot-unavailable" : "container-start";
    const common = {
      enableInternet: true,
      instance: job.instance,
      entrypoint: ["sleep", "infinity"],
      labels: { "gittifacts-run": label(job.runId), "gittifacts-step": label(job.step) },
    };
    try {
      if (job.from.kind === "snapshot") {
        await log.line(
          `starting ${job.instance} from snapshot ${job.from.snapshotId} (commit ${job.from.sha})`,
        );
        c.start({ ...common, containerSnapshot: { id: job.from.snapshotId } });
      } else {
        const image = c.images.base;
        if (image === undefined)
          throw new RunnerError("container-start", 'no "base" image in containers[].images');
        await log.line(`starting ${job.instance} from image ${image}`);
        c.start({ ...common, image });
      }
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError(startCode, `container failed to start: ${errorMessage(error)}`);
    }
    const exited = c.monitor().then(
      () => {
        throw new RunnerError(startCode, "the container exited during startup");
      },
      (error: unknown) => {
        throw new RunnerError(
          startCode,
          `the container exited during startup: ${errorMessage(error)}`,
        );
      },
    );
    exited.catch(() => {});
    const probe = deadline(
      START_TIMEOUT_MS,
      `the container was not ready after ${START_TIMEOUT_MS / 1000}s`,
    );
    try {
      await c.setInactivityTimeout(
        Math.min(MAX_INACTIVITY_MS, (job.timeoutSeconds + 15 * 60) * 1000),
      );
      const proc = await Promise.race([
        c.exec(["true"], { stdout: "ignore", stderr: "ignore" }),
        exited,
        probe.promise,
      ]);
      await Promise.race([proc.exitCode, exited, probe.promise]);
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError(startCode, errorMessage(error));
    } finally {
      probe.clear();
    }
  }

  /** Runs argv with combined output streamed into the log. Returns the exit code. */
  private async runProcess(
    c: ContainerLike,
    argv: string[],
    opts: { cwd: string; env: Record<string, string> },
    log: StepLog,
    signal: AbortSignal,
    timeoutSeconds: number,
  ): Promise<number> {
    if (signal.aborted) throw new RunnerError("aborted", "aborted");
    let proc: Awaited<ReturnType<ContainerLike["exec"]>>;
    try {
      proc = await c.exec(argv, {
        cwd: opts.cwd,
        env: opts.env,
        stdout: "pipe",
        stderr: "combined",
      });
    } catch (error) {
      throw new RunnerError("exec", `could not start the process: ${errorMessage(error)}`);
    }
    const watchdog = deadline(
      (timeoutSeconds + KILL_AFTER_SECONDS + WATCHDOG_GRACE_SECONDS) * 1000,
      `the process did not exit ${WATCHDOG_GRACE_SECONDS}s after its ${timeoutSeconds}s timeout`,
    );
    const onAbort = () => {
      void destroyQuietly(c);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const [, exitCode] = await Promise.race([
        Promise.all([pumpText(proc.stdout, (t) => log.write(t)), proc.exitCode]),
        watchdog.promise,
      ]);
      return exitCode;
    } catch (error) {
      if (error instanceof DeadlineError) {
        await destroyQuietly(c);
        throw new RunnerError("exec", error.message);
      }
      if (signal.aborted) throw new RunnerError("aborted", "aborted");
      throw new RunnerError("exec", `the process failed: ${errorMessage(error)}`);
    } finally {
      watchdog.clear();
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async runQuiet(c: ContainerLike, argv: string[]): Promise<number> {
    const proc = await c.exec(argv, { stdout: "ignore", stderr: "ignore" });
    return proc.exitCode;
  }

  private async captureEvidence(
    c: ContainerLike,
    job: RunnerJob,
    log: StepLog,
  ): Promise<EvidenceCapture> {
    if (job.evidenceKey === undefined)
      return { error: "no evidence key was assigned to this step" };
    let raw: string | null = null;
    const proc = await c.exec(
      [
        "sh",
        "-c",
        `if [ -f ${EVIDENCE_OUT} ]; then head -c ${MAX_EVIDENCE_BYTES + 1} ${EVIDENCE_OUT}; else exit 3; fi`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [file, code] = await Promise.all([
      readCapped(proc.stdout, MAX_EVIDENCE_BYTES + 1),
      proc.exitCode,
    ]);
    if (code === 0) {
      if (file.bytes > MAX_EVIDENCE_BYTES)
        return { error: `the evidence file exceeds ${MAX_EVIDENCE_BYTES} bytes` };
      raw = file.text;
    } else {
      raw = log.scanner.finish();
      if (raw === null) {
        return {
          error: log.scanner.overflowed
            ? `the ::evidence:: line exceeds ${MAX_EVIDENCE_BYTES} bytes`
            : `no evidence: ${EVIDENCE_OUT} is missing and no ::evidence:: line was printed`,
        };
      }
    }
    const parsed = parseEvidenceDocument(log.redact(raw));
    if (!parsed.ok) return { error: parsed.error.slice(0, 4000) };
    await writeJson(this.objectStore(), job.evidenceKey, parsed.items);
    return { key: job.evidenceKey, count: parsed.items.length };
  }
}

/** Env for user commands. The image env is not inherited except PATH. */
export function stepEnv(job: RunnerJob, userEnv: Record<string, string>): Record<string, string> {
  return {
    HOME: "/root",
    CI: "true",
    LANG: "C.UTF-8",
    TERM: "dumb",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    ...userEnv,
    GITTIFACTS: "1",
    GITTIFACTS_RUN_ID: job.runId,
    GITTIFACTS_STEP: job.step,
    GITTIFACTS_HEAD_SHA: job.headSha,
    ...(job.baseSha === undefined ? {} : { GITTIFACTS_BASE_SHA: job.baseSha }),
    ...(job.kind === "evidence" ? { GITTIFACTS_EVIDENCE_OUT: EVIDENCE_OUT } : {}),
  };
}

function failure(code: RunnerErrorCode, message: string, started: number): RunnerOutcome {
  return { ok: false, code, message, durationMs: Date.now() - started, log: null, tail: "" };
}

async function destroyQuietly(c: ContainerLike): Promise<void> {
  try {
    if (c.running) await c.destroy();
  } catch {
    // already stopped
  }
}
