/**
 * `Runner`: one Durable Object per (run, step), named `${runId}:${step}`, driving one container
 * through `this.ctx.container` (`scheduling_policy: "durable_object"`). It never uses
 * `@cloudflare/containers` or `@cloudflare/sandbox`.
 *
 * A job: start from `images.base` or the parent step's container snapshot (egress open, or locked
 * down to registries through `CiEgressGateway`) → check out the head commit with a short-lived
 * read token passed only in that exec's env → (global-scope cached steps) reduce the workspace to
 * the cache inputs → run the command under coreutils `timeout`, streaming redacted combined output
 * to R2 → (evidence steps) collect the evidence JSON → snapshot on success when asked → destroy.
 *
 * Platform secrets never enter the container: the only credential is the per-step read token,
 * and only the checkout exec sees it. Every outcome reports per-phase timings and the container
 * time it used, for quotas and time-to-first-green.
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { ArtifactRef } from "../engine.js";
import { formatIssues, type InstanceType } from "../plan/spec.js";
import { type ObjectStore, writeJson } from "../storage.js";
import {
  type ContainerLike,
  DeadlineError,
  deadline,
  errorMessage,
  pumpText,
  readCapped,
} from "./container.js";
import {
  CONTAINERS_CA_PATH,
  EGRESS_GATEWAY_EXPORT,
  EgressDenial,
  type EgressProps,
  hostOf,
  REGISTRY_HOSTS,
} from "./egress.js";
import { parseEvidenceDocument } from "./evidence.js";
import {
  type EvidenceCapture,
  type LogInfo,
  PlanJob,
  type PlanOutcome,
  type RunnerErrorCode,
  RunnerJob,
  type RunnerOutcome,
  type RunnerTimings,
  type StartFrom,
} from "./job.js";
import {
  EvidenceLineScanner,
  type LogBucket,
  R2ChunkedUpload,
  R2LogSink,
  TailBuffer,
} from "./log-sink.js";
import { createStreamRedactor, redactText, type StreamRedactor, secretVariants } from "./redact.js";
import {
  CHECKOUT_SCRIPT,
  checkoutEnv,
  EVIDENCE_OUT,
  HERMETIC_SCRIPT,
  inDirectory,
  isTimeoutExit,
  KILL_AFTER_SECONDS,
  ROOT_USER,
  RUNNER_HOME,
  RUNNER_USER,
  shellQuote,
  timedCommandArgv,
  trustCaScript,
  WORKSPACE,
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
export const ARTIFACT_TIMEOUT_SECONDS = 600;
/** How long past the command timeout the Runner waits before destroying the container itself. */
export const WATCHDOG_GRACE_SECONDS = 60;
const MAX_INACTIVITY_MS = 6 * 60 * 60 * 1000;
/** Denied requests after this many are counted but no longer logged one by one. */
const MAX_LOGGED_DENIALS = 50;

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
    maxBytes?: number,
  ) {
    this.sink = new R2LogSink(bucket, key, maxBytes === undefined ? {} : { maxBytes });
    this.redactor = createStreamRedactor(secrets);
  }

  get tail(): string {
    return this.tailBuffer.toString();
  }

  get isClosed(): boolean {
    return this.closed !== null;
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

/** Per-job accounting, also reachable from `noteEgressDenied` while the job runs. */
class Session {
  readonly timings: RunnerTimings = {};
  log: StepLog | null = null;
  container: ContainerLike | null = null;
  containerStartedAt: number | null = null;
  denied = 0;
  readonly deniedHosts = new Set<string>();
  /** Extra env every exec gets (e.g. NODE_EXTRA_CA_CERTS once egress is intercepted). */
  readonly execEnv: Record<string, string> = {};

  async phase<T>(name: keyof RunnerTimings, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.timings[name] = (this.timings[name] ?? 0) + (Date.now() - t0);
    }
  }

  computeMs(): number {
    return this.containerStartedAt === null ? 0 : Date.now() - this.containerStartedAt;
  }

  egress(): { denied: number; hosts: string[] } {
    return { denied: this.denied, hosts: [...this.deniedHosts] };
  }
}

type Accounting = "computeMs" | "timings" | "egress";
type OutcomeCore = RunnerOutcome extends infer O
  ? O extends RunnerOutcome
    ? Omit<O, Accounting>
    : never
  : never;
type PlanCore = PlanOutcome extends infer O
  ? O extends PlanOutcome
    ? Omit<O, "computeMs">
    : never
  : never;

type Lockdown = { network: "open" } | { network: "locked"; props: EgressProps };

export class Runner<E extends RunnerEnv = RunnerEnv> extends DurableObject<E> {
  private active: { controller: AbortController; done: Promise<void> } | null = null;
  private session: Session | null = null;

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

  /**
   * The egress gateway for one container: `ctx.exports.CiEgressGateway({ props })`. Null when the
   * Worker does not export it (then `registries-only` fails closed).
   */
  protected egressGateway(props: EgressProps): Fetcher | null {
    const exportsObject: unknown = this.ctx.exports;
    if (typeof exportsObject !== "object" || exportsObject === null) return null;
    const factory: unknown = Reflect.get(exportsObject, EGRESS_GATEWAY_EXPORT);
    if (typeof factory !== "function") return null;
    const gateway: unknown = Reflect.apply(factory, exportsObject, [{ props }]);
    return isFetcher(gateway) ? gateway : null;
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
    if (aborted !== null) {
      return failure("aborted", `the run was cancelled: ${aborted.reason}`, started);
    }
    return this.exclusive((signal) => this.execute(job, signal, started));
  }

  /** Evaluates a pipeline file in plan mode (`gittifacts-runner plan`). Never throws. */
  async plan(input: unknown): Promise<PlanOutcome> {
    const parsed = PlanJob.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid-job",
        message: formatIssues(parsed.error),
        stderr: "",
        computeMs: 0,
      };
    }
    const aborted = await this.abortRecord();
    if (aborted !== null) {
      return {
        ok: false,
        code: "aborted",
        message: `the run was cancelled: ${aborted.reason}`,
        stderr: "",
        computeMs: 0,
      };
    }
    return this.exclusive((signal) => this.executePlan(parsed.data, signal));
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

  /** The image a container would start from. Starts nothing. */
  async describe(): Promise<{ image: string | null }> {
    return { image: this.containerOrNull()?.images.base ?? null };
  }

  /** Called by `CiEgressGateway` for every refused request of the running job. */
  async noteEgressDenied(input: unknown): Promise<void> {
    const denial = EgressDenial.safeParse(input);
    const session = this.session;
    if (!denial.success || session === null) return;
    session.denied += 1;
    const host = hostOf(denial.data.url);
    if (host !== null && session.deniedHosts.size < 20) session.deniedHosts.add(host);
    if (session.denied <= MAX_LOGGED_DENIALS && session.log !== null && !session.log.isClosed) {
      await session.log
        .line(`egress blocked: ${denial.data.method} ${denial.data.url} (${denial.data.reason})`)
        .catch(() => {});
    }
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

  /** Runs `fn` with fresh accounting; always destroys the container afterwards. */
  private async withSession<T>(
    fn: (session: Session) => Promise<T>,
  ): Promise<{ value: T; session: Session }> {
    const session = new Session();
    this.session = session;
    try {
      return { value: await fn(session), session };
    } finally {
      if (session.container !== null) await destroyQuietly(session.container);
      if (this.session === session) this.session = null;
    }
  }

  private async execute(
    job: RunnerJob,
    signal: AbortSignal,
    started: number,
  ): Promise<RunnerOutcome> {
    const { value, session } = await this.withSession((s) =>
      this.executeJob(job, signal, started, s),
    );
    return {
      ...value,
      computeMs: session.computeMs(),
      timings: session.timings,
      egress: session.egress(),
    };
  }

  private async executeJob(
    job: RunnerJob,
    signal: AbortSignal,
    started: number,
    session: Session,
  ): Promise<OutcomeCore> {
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
      return coreFailure(
        "token",
        `could not mint a read token for ${job.artifactsRepo}: ${errorMessage(error)}`,
        started,
      );
    }
    const log = new StepLog(this.logBucket(), job.logKey, secretVariants(token), job.maxLogBytes);
    session.log = log;
    const fail = async (code: RunnerErrorCode, message: string): Promise<OutcomeCore> => {
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

    try {
      const c = this.container();
      session.container = c;
      await log.line(
        `${job.kind} step "${job.step}" attempt ${job.attempt} on ${job.instance}, network ${job.network}`,
      );
      const lockdown: Lockdown =
        job.network === "open"
          ? { network: "open" }
          : {
              network: "locked",
              props: {
                runner: `${job.runId}:${job.step}`,
                registries: [...REGISTRY_HOSTS],
                gitHost: hostOf(job.remote),
              },
            };
      await session.phase("containerStartMs", () =>
        this.boot(
          c,
          {
            from: job.from,
            instance: job.instance,
            timeoutSeconds: job.timeoutSeconds,
            runId: job.runId,
            step: job.step,
            lockdown,
          },
          session,
          log,
          signal,
        ),
      );

      await log.line(
        `checkout ${job.headSha}${job.baseSha === undefined ? "" : ` (base ${job.baseSha})`}`,
      );
      const checkout = await session.phase("checkoutMs", () =>
        this.runProcess(
          c,
          timedCommandArgv(CHECKOUT_SCRIPT, CHECKOUT_TIMEOUT_SECONDS),
          {
            ...session.execEnv,
            ...checkoutEnv({
              remote: job.remote,
              headSha: job.headSha,
              baseSha: job.baseSha,
              token,
            }),
          },
          log,
          signal,
          CHECKOUT_TIMEOUT_SECONDS,
          { cwd: "/" },
        ),
      );
      if (checkout !== 0) {
        throw new RunnerError(
          "checkout",
          `checkout of ${job.headSha} failed with exit code ${checkout}`,
        );
      }

      const hermeticInputs = job.hermeticInputs;
      if (hermeticInputs !== undefined) {
        await log.line(
          `global cache scope: running with only the ${hermeticInputs.length} cache input files in ${WORKSPACE}`,
        );
        const code = await session.phase("hermeticMs", () =>
          this.runHermetic(c, hermeticInputs, session, log, signal),
        );
        if (code !== 0) {
          throw new RunnerError(
            "exec",
            `reducing the workspace to the cache inputs failed (exit ${code})`,
          );
        }
      }

      for (const r of job.replay) {
        await log.line(`replaying "${r.name}" (its snapshot is no longer available): ${r.command}`);
        const code = await session.phase("replayMs", () =>
          this.runProcess(
            c,
            timedCommandArgv(inDirectory(r.command, r.cwd), job.timeoutSeconds),
            { ...stepEnv(job, r.env ?? {}), ...session.execEnv },
            log,
            signal,
            job.timeoutSeconds,
          ),
        );
        if (code !== 0) {
          throw new RunnerError("replay", `replaying "${r.name}" failed with exit code ${code}`);
        }
      }

      if (job.kind === "evidence") {
        await this.runQuiet(c, ["sh", "-c", "rm -rf /tmp/gittifacts && mkdir -p /tmp/gittifacts"]);
      }

      await log.line(`$ ${job.command}`);
      const commandStarted = Date.now();
      const exitCode = await session.phase("commandMs", () =>
        this.runProcess(
          c,
          timedCommandArgv(inDirectory(job.command, job.cwd), job.timeoutSeconds),
          { ...stepEnv(job, job.env), ...session.execEnv },
          log,
          signal,
          job.timeoutSeconds,
        ),
      );
      const timedOut =
        isTimeoutExit(exitCode) && Date.now() - commandStarted >= job.timeoutSeconds * 1000 - 2000;
      await log.line(
        timedOut
          ? `timed out after ${job.timeoutSeconds}s (exit ${exitCode})`
          : `exit code ${exitCode}`,
      );

      const evidence =
        job.kind === "evidence"
          ? await session.phase("evidenceMs", () => this.captureEvidence(c, job, log))
          : null;
      if (evidence !== null && "error" in evidence) await log.line(`evidence: ${evidence.error}`);

      const artifacts: Record<string, ArtifactRef> = {};
      const artifactErrors: Record<string, { error: string; optional: boolean }> = {};
      if (exitCode === 0 && job.artifacts.length > 0) {
        await session.phase("artifactsMs", async () => {
          for (const a of job.artifacts) {
            const res = await this.uploadArtifact(c, a, job.maxArtifactBytes, log, signal);
            if ("ref" in res) {
              artifacts[a.name] = res.ref;
              await log.line(
                `artifact ${a.name}: ${res.ref.bytes} bytes, sha256 ${res.ref.sha256}`,
              );
            } else {
              const optional = a.optional === true;
              artifactErrors[a.name] = { error: res.error, optional };
              await log.line(
                `artifact ${a.name}${optional ? " (optional, skipped)" : ""}: ${res.error}`,
              );
            }
          }
        });
      }
      const artifactsComplete = Object.values(artifactErrors).every((e) => e.optional);

      let snapshot: { id: string; size: number } | null = null;
      if (exitCode === 0 && artifactsComplete && job.snapshot) {
        snapshot = await session.phase("snapshotMs", async () => {
          try {
            const s = await c.snapshotContainer({ name: snapshotName(job.runId, job.step) });
            await this.ctx.storage.put("snapshot", {
              id: s.id,
              size: s.size,
              takenAt: new Date().toISOString(),
            });
            await log.line(`snapshot ${s.id} (${s.size} bytes)`);
            return { id: s.id, size: s.size };
          } catch (error) {
            throw new RunnerError(
              "snapshot",
              `could not snapshot the container: ${errorMessage(error)}`,
            );
          }
        });
      }
      if (session.denied > 0) {
        await log.line(
          `egress: ${session.denied} request(s) blocked (${[...session.deniedHosts].join(", ")})`,
        );
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
        hermetic: hermeticInputs !== undefined,
        artifacts,
        artifactErrors,
      };
    } catch (error) {
      if (signal.aborted) return fail("aborted", `stopped: ${String(signal.reason ?? "aborted")}`);
      if (error instanceof RunnerError) return fail(error.code, error.message);
      return fail("internal", errorMessage(error));
    }
  }

  private async executePlan(job: PlanJob, signal: AbortSignal): Promise<PlanOutcome> {
    const { value, session } = await this.withSession((s) => this.executePlanJob(job, signal, s));
    return { ...value, computeMs: session.computeMs() };
  }

  private async executePlanJob(
    job: PlanJob,
    signal: AbortSignal,
    session: Session,
  ): Promise<PlanCore> {
    let token: string;
    try {
      token = await this.mintReadToken(job.artifactsRepo);
    } catch (error) {
      return { ok: false, code: "token", message: errorMessage(error), stderr: "" };
    }
    const log = new StepLog(this.logBucket(), job.logKey, secretVariants(token));
    session.log = log;
    try {
      const c = this.container();
      session.container = c;
      // Plan mode never needs more than the git host, so lock egress down whenever the gateway
      // exists. Only an explicitly open run may fall back to open egress without it.
      const props: EgressProps = {
        runner: `${job.runId}:plan`,
        registries: [],
        gitHost: hostOf(job.remote),
      };
      const lockdown: Lockdown =
        job.network === "open" && this.egressGateway(props) === null
          ? { network: "open" }
          : { network: "locked", props };
      await log.line(
        `plan ${job.file} at ${job.sha}, network ${lockdown.network === "open" ? "open" : "git host only"}`,
      );
      await this.boot(
        c,
        {
          from: { kind: "image" },
          instance: job.instance,
          timeoutSeconds: job.timeoutSeconds,
          runId: job.runId,
          step: "plan",
          lockdown,
        },
        session,
        log,
        signal,
      );
      const checkout = await this.runProcess(
        c,
        timedCommandArgv(CHECKOUT_SCRIPT, CHECKOUT_TIMEOUT_SECONDS),
        { ...session.execEnv, ...checkoutEnv({ remote: job.remote, headSha: job.sha, token }) },
        log,
        signal,
        CHECKOUT_TIMEOUT_SECONDS,
        { cwd: "/" },
      );
      if (checkout !== 0) {
        throw new RunnerError(
          "checkout",
          `checkout of ${job.sha} failed with exit code ${checkout}`,
        );
      }
      const command = `gittifacts-runner plan ${shellQuote(job.file)} --sha ${job.sha}${
        job.baseSha === undefined ? "" : ` --base ${job.baseSha}`
      }`;
      await log.line(`$ ${command}`);
      const proc = await c.exec(timedCommandArgv(command, job.timeoutSeconds), {
        cwd: WORKSPACE,
        user: RUNNER_USER,
        env: { ...planEnv(job), ...session.execEnv },
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
    }
  }

  /** Starts the container, applies egress lockdown, waits until it runs commands. */
  private async boot(
    c: ContainerLike,
    opts: {
      from: StartFrom;
      instance: InstanceType;
      timeoutSeconds: number;
      runId: string;
      step: string;
      lockdown: Lockdown;
    },
    session: Session,
    log: StepLog,
    signal: AbortSignal,
  ): Promise<void> {
    if (c.running) {
      await log.line("destroying a container left over from an earlier attempt");
      await destroyQuietly(c);
    }
    if (signal.aborted) throw new RunnerError("aborted", "aborted before start");
    let gateway: Fetcher | null = null;
    if (opts.lockdown.network === "locked") {
      gateway = this.egressGateway(opts.lockdown.props);
      if (gateway === null) {
        throw new RunnerError(
          "internal",
          `restricted egress needs the platform Worker to export ${EGRESS_GATEWAY_EXPORT}; refusing to run with open egress`,
        );
      }
    }
    const startCode: RunnerErrorCode =
      opts.from.kind === "snapshot" ? "snapshot-unavailable" : "container-start";
    const common = {
      enableInternet: gateway === null,
      instance: opts.instance,
      // The image's own entrypoint (tini + sleep infinity) keeps the container up and reaps
      // zombies; it also runs again when a snapshot is restored.
      labels: { "gittifacts-run": label(opts.runId), "gittifacts-step": label(opts.step) },
    };
    try {
      session.containerStartedAt = Date.now();
      if (opts.from.kind === "snapshot") {
        await log.line(
          `starting ${opts.instance} from snapshot ${opts.from.snapshotId} (commit ${opts.from.sha})`,
        );
        c.start({ ...common, containerSnapshot: { id: opts.from.snapshotId } });
      } else {
        const image = c.images.base;
        if (image === undefined) {
          throw new RunnerError("container-start", 'no "base" image in containers[].images');
        }
        await log.line(`starting ${opts.instance} from image ${image}`);
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
        Math.min(MAX_INACTIVITY_MS, (opts.timeoutSeconds + 15 * 60) * 1000),
      );
      if (gateway !== null) {
        // Every HTTP and HTTPS request goes to the gateway; nothing else has a route.
        await c.interceptAllOutboundHttp(gateway);
        await c.interceptOutboundHttps("*", gateway);
      }
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
    if (gateway !== null && opts.lockdown.network === "locked") {
      const code = await this.runProcess(
        c,
        ["sh", "-c", trustCaScript(CONTAINERS_CA_PATH)],
        {},
        log,
        signal,
        60,
        { cwd: "/", user: ROOT_USER },
      );
      if (code !== 0) {
        throw new RunnerError(
          "container-start",
          `could not trust the egress interception CA (exit ${code})`,
        );
      }
      session.execEnv.NODE_EXTRA_CA_CERTS = CONTAINERS_CA_PATH;
      const allowed = [...opts.lockdown.props.registries, opts.lockdown.props.gitHost].filter(
        (h): h is string => h !== null,
      );
      await log.line(`egress restricted to ${allowed.join(", ")}`);
    }
  }

  /** Runs argv with combined output streamed into the log. Returns the exit code. */
  private async runProcess(
    c: ContainerLike,
    argv: string[],
    env: Record<string, string>,
    log: StepLog,
    signal: AbortSignal,
    timeoutSeconds: number,
    opts: { cwd?: string; stdin?: ReadableStream<Uint8Array>; user?: string } = {},
  ): Promise<number> {
    if (signal.aborted) throw new RunnerError("aborted", "aborted");
    let proc: Awaited<ReturnType<ContainerLike["exec"]>>;
    try {
      proc = await c.exec(argv, {
        cwd: opts.cwd ?? WORKSPACE,
        user: opts.user ?? RUNNER_USER,
        env,
        stdout: "pipe",
        stderr: "combined",
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
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

  private async runHermetic(
    c: ContainerLike,
    inputs: readonly string[],
    session: Session,
    log: StepLog,
    signal: AbortSignal,
  ): Promise<number> {
    const list = new TextEncoder().encode(inputs.map((p) => `${p}\0`).join(""));
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(list);
        controller.close();
      },
    });
    return this.runProcess(
      c,
      timedCommandArgv(HERMETIC_SCRIPT, 300),
      { ...session.execEnv },
      log,
      signal,
      300,
      { cwd: "/", stdin },
    );
  }

  private async runQuiet(c: ContainerLike, argv: string[]): Promise<number> {
    const proc = await c.exec(argv, { user: RUNNER_USER, stdout: "ignore", stderr: "ignore" });
    return proc.exitCode;
  }

  /**
   * `tar -C /workspace -cz <paths>` streamed straight to R2 (multipart past one part), hashed on
   * the way. Over `maxBytes` the upload is abandoned.
   */
  private async uploadArtifact(
    c: ContainerLike,
    artifact: { name: string; paths: string[]; key: string },
    maxBytes: number,
    log: StepLog,
    signal: AbortSignal,
  ): Promise<{ ref: ArtifactRef } | { error: string }> {
    if (signal.aborted) throw new RunnerError("aborted", "aborted");
    const command = `exec tar -C ${WORKSPACE} -cz -- ${artifact.paths.map(shellQuote).join(" ")}`;
    const proc = await c.exec(timedCommandArgv(command, ARTIFACT_TIMEOUT_SECONDS), {
      cwd: WORKSPACE,
      user: RUNNER_USER,
      env: { HOME: RUNNER_HOME, LANG: "C.UTF-8" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const upload = new R2ChunkedUpload(this.logBucket(), artifact.key, {
      contentType: "application/gzip",
    });
    const digest = new crypto.DigestStream("SHA-256");
    const digestWriter = digest.getWriter();
    let tooLarge = false;
    const pump = async (): Promise<void> => {
      if (proc.stdout === null) return;
      const reader = proc.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (upload.size + value.byteLength > maxBytes) {
          tooLarge = true;
          await reader.cancel();
          break;
        }
        await digestWriter.write(value);
        await upload.append(value);
      }
    };
    const watchdog = deadline(
      (ARTIFACT_TIMEOUT_SECONDS + KILL_AFTER_SECONDS + WATCHDOG_GRACE_SECONDS) * 1000,
      `packing artifact ${artifact.name} did not finish`,
    );
    let exitCode: number;
    try {
      [, , exitCode] = await Promise.race([
        Promise.all([pump(), pumpText(proc.stderr, (t) => log.write(t)), proc.exitCode]),
        watchdog.promise,
      ]);
    } catch (error) {
      await upload.abort();
      await digestWriter.abort().catch(() => {});
      if (error instanceof DeadlineError) await destroyQuietly(c);
      return { error: `packing failed: ${errorMessage(error)}` };
    } finally {
      watchdog.clear();
    }
    if (tooLarge || exitCode !== 0) {
      await upload.abort();
      await digestWriter.abort().catch(() => {});
      return {
        error: tooLarge
          ? `larger than ${maxBytes} bytes compressed`
          : `tar exited with ${exitCode} (does ${artifact.paths.join(", ")} exist?)`,
      };
    }
    await digestWriter.close();
    const sha256 = [...new Uint8Array(await digest.digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const bytes = await upload.close();
    return { ref: { key: artifact.key, bytes, sha256 } };
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
      { user: RUNNER_USER, stdout: "pipe", stderr: "ignore" },
    );
    const [file, code] = await Promise.all([
      readCapped(proc.stdout, MAX_EVIDENCE_BYTES + 1),
      proc.exitCode,
    ]);
    if (code === 0) {
      if (file.bytes > MAX_EVIDENCE_BYTES) {
        return { error: `the evidence file exceeds ${MAX_EVIDENCE_BYTES} bytes` };
      }
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
    HOME: RUNNER_HOME,
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

function planEnv(job: PlanJob): Record<string, string> {
  return {
    HOME: RUNNER_HOME,
    CI: "true",
    LANG: "C.UTF-8",
    TERM: "dumb",
    GITTIFACTS: "1",
    GITTIFACTS_RUN_ID: job.runId,
    GITTIFACTS_HEAD_SHA: job.sha,
  };
}

function isFetcher(value: unknown): value is Fetcher {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "fetch") === "function"
  );
}

function coreFailure(code: RunnerErrorCode, message: string, started: number): OutcomeCore {
  return { ok: false, code, message, durationMs: Date.now() - started, log: null, tail: "" };
}

function failure(code: RunnerErrorCode, message: string, started: number): RunnerOutcome {
  return {
    ok: false,
    code,
    message,
    durationMs: Date.now() - started,
    log: null,
    tail: "",
    computeMs: 0,
    timings: {},
    egress: { denied: 0, hosts: [] },
  };
}

async function destroyQuietly(c: ContainerLike): Promise<void> {
  try {
    if (c.running) await c.destroy();
  } catch {
    // already stopped
  }
}
