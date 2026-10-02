/**
 * The workspace's container, behind a small interface so the Durable Object's lifecycle logic
 * (TTL, idle sleep, quotas, path rules, output caps) is the same in production and in workerd
 * tests, where containers can't run.
 *
 * `ContainerMachine` drives `ctx.container` (`scheduling_policy: "durable_object"`) on the sandbox
 * image exactly like the CI Runner does: same image, same unprivileged user (10001), same
 * coreutils `timeout` wrapping, same egress lockdown (`enableInternet: false` + every HTTP(S)
 * request through a gateway entrypoint, with the Containers interception CA trusted) for
 * `registries-only`. Tokens only ever appear in the env of the one exec that needs them.
 */
import {
  CONTAINERS_CA_PATH,
  type ContainerLike,
  type ExecProcessLike,
  type InstanceType,
  RUNNER_HOME,
  RUNNER_USER,
  shellQuote,
  timedCommandArgv,
} from "@app/ci-engine";
import {
  CHECKOUT_SCRIPT,
  COMMIT_PUSH_SCRIPT,
  DIFF_PATCH_SCRIPT,
  DIFF_STAT_SCRIPT,
  type DiffStatus,
  lastWsMarker,
  PATCH_SCRIPT,
  parseDiffStats,
  READ_SCRIPT,
  WRITE_SCRIPT,
} from "./scripts.js";

// ---------------------------------------------------------------- contract

export type BootFrom =
  | { kind: "sleep-snapshot"; id: string }
  | { kind: "dependency-snapshot"; id: string }
  | { kind: "image" };

export interface BootSpec {
  workspaceId: string;
  from: BootFrom;
  instance: InstanceType;
  network: "open" | "registries-only";
  /** Egress gateway props for `registries-only` (git host = the fork's host; push = its path). */
  egress: { gitHost: string | null; forkPath: string };
  /** Backstop: the runtime stops the container after this long without requests. */
  inactivityTimeoutMs: number;
}

export interface Author {
  name: string;
  email: string;
}

export interface CheckoutSpec {
  remote: string;
  branch: string;
  headSha: string;
  baseSha: string;
  token: string;
}

export interface ExecSpec {
  command: string;
  /** Validated, repository-relative ("." = the root). */
  cwd: string;
  timeoutSec: number;
  maxOutputBytes: number;
  author: Author;
}

export interface Captured {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface ExecOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: Captured;
  stderr: Captured;
}

export type ReadOutcome =
  | { ok: true; bytes: Uint8Array; size: number }
  | { ok: false; reason: "outside" | "missing" | "not-a-file" | "failed"; message: string };

export type WriteOutcome =
  | { ok: true; created: boolean }
  | { ok: false; reason: "outside" | "is-directory" | "failed"; message: string };

export type PatchOutcome =
  | { ok: true }
  | { ok: false; reason: "outside" | "rejected"; message: string };

export interface DiffOutcome {
  files: Array<{ path: string; status: DiffStatus; additions: number; deletions: number }>;
  patch: string;
  truncated: boolean;
}

export interface CommitPushSpec {
  remote: string;
  branch: string;
  message: string;
  author: Author;
  token: string;
  /** What the fork's branch is known to be at (the last checkout or push from here). */
  pushedHead: string;
}

export type CommitPushOutcome =
  | { status: "pushed"; head: string; before: string | null; committed: boolean; files: number }
  | { status: "nothing"; head: string }
  | { status: "rejected"; head: string | null; message: string };

export class MachineError extends Error {
  constructor(
    readonly code: "snapshot-unavailable" | "container-start" | "checkout" | "exec" | "egress",
    message: string,
  ) {
    super(message);
    this.name = "MachineError";
  }
}

export interface WorkspaceMachine {
  readonly running: boolean;
  boot(spec: BootSpec): Promise<void>;
  checkout(spec: CheckoutSpec): Promise<{ head: string }>;
  exec(spec: ExecSpec): Promise<ExecOutcome>;
  read(path: string, maxBytes: number): Promise<ReadOutcome>;
  write(path: string, content: Uint8Array): Promise<WriteOutcome>;
  applyPatch(path: string, patch: string): Promise<PatchOutcome>;
  diff(baseSha: string, maxBytes: number): Promise<DiffOutcome>;
  commitPush(spec: CommitPushSpec): Promise<CommitPushOutcome>;
  /** Root-filesystem snapshot (the sleep snapshot). */
  snapshot(name: string): Promise<{ id: string }>;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------- output capture

const TAIL_SHARE = 0.75;

/**
 * Reads a stream keeping the first quarter and the last three quarters of `maxBytes`, so a long
 * test run still shows its start and, more importantly, its summary and the failures at the end.
 */
export async function captureHeadTail(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Captured> {
  if (stream === null) return { text: "", bytes: 0, truncated: false };
  const headMax = Math.floor(maxBytes * (1 - TAIL_SHARE));
  const tailMax = maxBytes - headMax;
  const head: Uint8Array[] = [];
  let headLen = 0;
  let tail: Uint8Array[] = [];
  let tailLen = 0;
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      let chunk = value;
      if (headLen < headMax) {
        const take = chunk.subarray(0, headMax - headLen);
        head.push(take);
        headLen += take.byteLength;
        chunk = chunk.subarray(take.byteLength);
      }
      if (chunk.byteLength === 0) continue;
      tail.push(chunk);
      tailLen += chunk.byteLength;
      while (tailLen > tailMax && tail.length > 0) {
        const first = tail[0];
        if (first === undefined) break;
        const excess = tailLen - tailMax;
        if (first.byteLength <= excess) {
          tail = tail.slice(1);
          tailLen -= first.byteLength;
        } else {
          tail[0] = first.subarray(excess);
          tailLen -= excess;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  const join = (parts: Uint8Array[]) => {
    const len = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  };
  const truncated = total > headLen + tailLen;
  const text = truncated
    ? `${decoder.decode(join(head))}\n…[${total - headLen - tailLen} bytes omitted]…\n${decoder.decode(join(tail))}`
    : decoder.decode(join([...head, ...tail]));
  return { text, bytes: total, truncated };
}

async function readAll(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; total: number }> {
  if (stream === null) return { bytes: new Uint8Array(0), total: 0 };
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (kept < maxBytes) {
        const take = value.subarray(0, maxBytes - kept);
        parts.push(take);
        kept += take.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(kept);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return { bytes: out, total };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------- container machine

const START_TIMEOUT_MS = 3 * 60_000;
const GIT_TIMEOUT_SEC = 300;
const OP_TIMEOUT_SEC = 120;
/** Seconds past a command's own timeout before the Worker stops waiting for it. */
const WATCHDOG_GRACE_SEC = 40;
const MAX_INACTIVITY_MS = 6 * 60 * 60_000;

/** Container label keys are limited to 16 bytes (live: "Label names cannot exceed 16 bytes"). */
export const MAX_LABEL_KEY_BYTES = 16;

export function workspaceLabels(workspaceId: string): Record<string, string> {
  return { "gf-workspace": workspaceId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63) };
}

/** The exports entrypoint the platform Worker exposes for workspace egress (./egress.ts). */
export const WORKSPACE_EGRESS_EXPORT = "WorkspaceEgressGateway";

export interface ContainerMachineOptions {
  /** `ctx.container` (undefined when the class has no container attached). */
  container: ContainerLike | undefined;
  /** `ctx.exports.WorkspaceEgressGateway({ props })`, or null when the Worker lacks it. */
  egressGateway(props: {
    workspaceId: string;
    registries: string[];
    gitHost: string | null;
    pushPath: string | null;
  }): Fetcher | null;
  registries: readonly string[];
}

function baseEnv(author?: Author): Record<string, string> {
  return {
    HOME: RUNNER_HOME,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    GITTIFACTS: "1",
    GITTIFACTS_WORKSPACE: "1",
    WS_ROOT: "/workspace",
    ...(author === undefined
      ? {}
      : {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        }),
  };
}

function tokenEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function redact(text: string, token: string): string {
  if (token === "") return text;
  const bare = token.split("?")[0] ?? token;
  return text.replaceAll(token, "[redacted]").replaceAll(bare, "[redacted]");
}

export class ContainerMachine implements WorkspaceMachine {
  /** Extra env every exec gets (NODE_EXTRA_CA_CERTS once egress is intercepted). */
  private readonly execEnv: Record<string, string> = {};

  constructor(private readonly opts: ContainerMachineOptions) {}

  private get c(): ContainerLike {
    const c = this.opts.container;
    if (c === undefined) {
      throw new MachineError(
        "container-start",
        'no container is attached (containers[] must name class "Workspace" with scheduling_policy "durable_object")',
      );
    }
    return c;
  }

  get running(): boolean {
    return this.opts.container?.running === true;
  }

  async boot(spec: BootSpec): Promise<void> {
    const c = this.c;
    if (c.running) {
      // The DO restarted while its container kept running: the inactivity timeout and egress
      // interception are per Durable Object instance, so apply them again; the files stay.
      await c.setInactivityTimeout(Math.min(MAX_INACTIVITY_MS, spec.inactivityTimeoutMs));
      await this.lockdown(c, spec);
      return;
    }
    let gateway: Fetcher | null = null;
    if (spec.network === "registries-only") {
      gateway = this.gateway(spec);
      if (gateway === null) {
        throw new MachineError(
          "egress",
          `registries-only egress needs the platform Worker to export ${WORKSPACE_EGRESS_EXPORT}; refusing to start with open egress`,
        );
      }
    }
    const common = {
      enableInternet: gateway === null,
      instance: spec.instance,
      labels: workspaceLabels(spec.workspaceId),
    };
    try {
      if (spec.from.kind === "image") {
        const image = c.images.base;
        if (image === undefined) throw new Error('no "base" image in containers[].images');
        c.start({ ...common, image });
      } else {
        c.start({ ...common, containerSnapshot: { id: spec.from.id } });
      }
    } catch (e) {
      throw new MachineError(
        spec.from.kind === "image" ? "container-start" : "snapshot-unavailable",
        `the container failed to start: ${errorText(e)}`,
      );
    }
    const exited = c.monitor().then(
      () => {
        throw new MachineError("container-start", "the container exited during startup");
      },
      (e: unknown) => {
        throw new MachineError(
          spec.from.kind === "image" ? "container-start" : "snapshot-unavailable",
          `the container exited during startup: ${errorText(e)}`,
        );
      },
    );
    exited.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new MachineError("container-start", "the container was not ready in time")),
        START_TIMEOUT_MS,
      );
    });
    timeout.catch(() => {});
    try {
      await c.setInactivityTimeout(Math.min(MAX_INACTIVITY_MS, spec.inactivityTimeoutMs));
      if (gateway !== null) {
        await c.interceptAllOutboundHttp(gateway);
        await c.interceptOutboundHttps("*", gateway);
      }
      const probe = await Promise.race([
        c.exec(["true"], { stdout: "ignore", stderr: "ignore" }),
        exited,
        timeout,
      ]);
      await Promise.race([probe.exitCode, exited, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (gateway !== null) await this.trustCa(c);
  }

  private gateway(spec: BootSpec): Fetcher | null {
    return this.opts.egressGateway({
      workspaceId: spec.workspaceId,
      registries: [...this.opts.registries],
      gitHost: spec.egress.gitHost,
      pushPath: spec.egress.forkPath,
    });
  }

  private async lockdown(c: ContainerLike, spec: BootSpec): Promise<void> {
    if (spec.network !== "registries-only") return;
    const gateway = this.gateway(spec);
    if (gateway === null) {
      throw new MachineError("egress", `the ${WORKSPACE_EGRESS_EXPORT} entrypoint is missing`);
    }
    await c.interceptAllOutboundHttp(gateway);
    await c.interceptOutboundHttps("*", gateway);
    await this.trustCa(c);
  }

  private async trustCa(_c: ContainerLike): Promise<void> {
    const f = shellQuote(CONTAINERS_CA_PATH);
    const script = [
      `if [ ! -f ${f} ]; then echo "interception CA certificate is missing" >&2; exit 3; fi`,
      "mkdir -p /usr/local/share/ca-certificates",
      `cp ${f} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt`,
      "update-ca-certificates >/dev/null 2>&1 || true",
    ].join("\n");
    const r = await this.run(["sh", "-c", script], { user: "0:0", timeoutSec: 60, maxBytes: 4096 });
    if (r.exitCode !== 0) {
      throw new MachineError(
        "egress",
        `could not trust the egress interception CA: ${r.stderr.text}`,
      );
    }
    this.execEnv.NODE_EXTRA_CA_CERTS = CONTAINERS_CA_PATH;
  }

  /** One exec, stdout/stderr captured separately, bounded by `timeout` + a watchdog. */
  private async run(
    argv: string[],
    o: {
      env?: Record<string, string>;
      cwd?: string;
      user?: string;
      stdin?: Uint8Array;
      timeoutSec: number;
      maxBytes: number;
      rawStdout?: boolean;
    },
  ): Promise<ExecOutcome & { raw: Uint8Array }> {
    const c = this.c;
    const started = Date.now();
    let proc: ExecProcessLike;
    try {
      proc = await c.exec(timedCommandArgv(argv.map(shellQuote).join(" "), o.timeoutSec), {
        cwd: o.cwd ?? "/workspace",
        user: o.user ?? RUNNER_USER,
        env: { ...baseEnv(), ...this.execEnv, ...o.env },
        stdout: "pipe",
        stderr: "pipe",
        ...(o.stdin === undefined ? {} : { stdin: streamOf(o.stdin) }),
      });
    } catch (e) {
      throw new MachineError("exec", `could not start the process: ${errorText(e)}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<"watchdog">((resolve) => {
      timer = setTimeout(
        () => resolve("watchdog"),
        (o.timeoutSec + 10 + WATCHDOG_GRACE_SEC) * 1000,
      );
    });
    const empty: Captured = { text: "", bytes: 0, truncated: false };
    try {
      const work = Promise.all([
        o.rawStdout === true
          ? readAll(proc.stdout, o.maxBytes).then((r) => ({ raw: r.bytes, total: r.total }))
          : captureHeadTail(proc.stdout, o.maxBytes).then((cap) => ({ cap })),
        captureHeadTail(proc.stderr, o.maxBytes),
        proc.exitCode,
      ]);
      const raced = await Promise.race([work, watchdog]);
      if (raced === "watchdog") {
        return {
          exitCode: null,
          timedOut: true,
          durationMs: Date.now() - started,
          stdout: empty,
          stderr: {
            text: "the process did not exit after its timeout",
            bytes: 0,
            truncated: false,
          },
          raw: new Uint8Array(0),
        };
      }
      const [out, stderr, exitCode] = raced;
      const stdout: Captured =
        "cap" in out ? out.cap : { text: "", bytes: out.total, truncated: out.total > o.maxBytes };
      const raw = "raw" in out ? out.raw : new Uint8Array(0);
      const timedOut =
        (exitCode === 124 || exitCode === 137) &&
        Date.now() - started >= o.timeoutSec * 1000 - 2000;
      return { exitCode, timedOut, durationMs: Date.now() - started, stdout, stderr, raw };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Runs one of ./scripts.ts with positional args (`sh -c SCRIPT gittifacts-ws ARGS…`). */
  private script(
    script: string,
    args: string[],
    o: Omit<Parameters<ContainerMachine["run"]>[1], "timeoutSec" | "maxBytes"> & {
      timeoutSec?: number;
      maxBytes?: number;
    },
  ) {
    return this.run(["sh", "-c", script, "gittifacts-ws", ...args], {
      timeoutSec: o.timeoutSec ?? OP_TIMEOUT_SEC,
      maxBytes: o.maxBytes ?? 64 * 1024,
      ...o,
    });
  }

  async checkout(spec: CheckoutSpec): Promise<{ head: string }> {
    const r = await this.script(CHECKOUT_SCRIPT, [], {
      cwd: "/",
      timeoutSec: GIT_TIMEOUT_SEC,
      env: {
        WS_REMOTE: spec.remote,
        WS_BRANCH: spec.branch,
        WS_HEAD: spec.headSha,
        WS_BASE: spec.baseSha,
        ...tokenEnv(spec.token),
      },
    });
    const marker = lastWsMarker(r.stdout.text) as { head?: unknown } | null;
    if (r.exitCode !== 0 || typeof marker?.head !== "string") {
      throw new MachineError(
        "checkout",
        `checkout of ${spec.headSha.slice(0, 12)} failed (exit ${r.exitCode}): ${redact(r.stderr.text, spec.token).slice(-2000)}`,
      );
    }
    return { head: marker.head };
  }

  async exec(spec: ExecSpec): Promise<ExecOutcome> {
    const cd =
      spec.cwd === "."
        ? spec.command
        : `cd -- ${shellQuote(spec.cwd)} || { echo ${shellQuote(`gittifacts: working directory ${spec.cwd} does not exist`)} >&2; exit 2; }\n${spec.command}`;
    const { raw: _raw, ...outcome } = await this.run(["sh", "-c", cd], {
      env: baseEnv(spec.author),
      timeoutSec: spec.timeoutSec,
      maxBytes: spec.maxOutputBytes,
    });
    return outcome;
  }

  async read(path: string, maxBytes: number): Promise<ReadOutcome> {
    const r = await this.script(READ_SCRIPT, [path, String(maxBytes)], {
      rawStdout: true,
      maxBytes,
      timeoutSec: 60,
    });
    const err = r.stderr.text;
    if (r.exitCode === 3) return { ok: false, reason: "outside", message: err.trim() };
    if (r.exitCode === 4) return { ok: false, reason: "missing", message: err.trim() };
    if (r.exitCode === 5) return { ok: false, reason: "not-a-file", message: err.trim() };
    if (r.exitCode !== 0) return { ok: false, reason: "failed", message: err.trim().slice(-1000) };
    const size = Number(/size (\d+)/.exec(err)?.[1] ?? r.raw.byteLength);
    return { ok: true, bytes: r.raw, size };
  }

  async write(path: string, content: Uint8Array): Promise<WriteOutcome> {
    const r = await this.script(WRITE_SCRIPT, [path], { stdin: content, timeoutSec: 60 });
    if (r.exitCode === 3) return { ok: false, reason: "outside", message: r.stderr.text.trim() };
    if (r.exitCode === 5)
      return { ok: false, reason: "is-directory", message: r.stderr.text.trim() };
    const marker = lastWsMarker(r.stdout.text) as { created?: unknown } | null;
    if (r.exitCode !== 0 || typeof marker?.created !== "boolean") {
      return { ok: false, reason: "failed", message: r.stderr.text.trim().slice(-1000) };
    }
    return { ok: true, created: marker.created };
  }

  async applyPatch(path: string, patch: string): Promise<PatchOutcome> {
    const r = await this.script(PATCH_SCRIPT, [path], {
      stdin: new TextEncoder().encode(patch),
      timeoutSec: 60,
    });
    if (r.exitCode === 3) return { ok: false, reason: "outside", message: r.stderr.text.trim() };
    if (r.exitCode !== 0 || lastWsMarker(r.stdout.text) === null) {
      return { ok: false, reason: "rejected", message: r.stderr.text.trim().slice(-2000) };
    }
    return { ok: true };
  }

  async diff(baseSha: string, maxBytes: number): Promise<DiffOutcome> {
    const env = { WS_BASE: baseSha };
    const stats = await this.script(DIFF_STAT_SCRIPT, [], { env, maxBytes: 1024 * 1024 });
    if (stats.exitCode !== 0) {
      throw new MachineError("exec", `git diff failed: ${stats.stderr.text.trim().slice(-1000)}`);
    }
    const patch = await this.script(DIFF_PATCH_SCRIPT, [], { env, maxBytes });
    return {
      files: parseDiffStats(stats.stdout.text),
      patch: patch.stdout.text,
      truncated: patch.stdout.truncated,
    };
  }

  async commitPush(spec: CommitPushSpec): Promise<CommitPushOutcome> {
    const r = await this.script(COMMIT_PUSH_SCRIPT, [], {
      timeoutSec: GIT_TIMEOUT_SEC,
      env: {
        ...baseEnv(spec.author),
        WS_REMOTE: spec.remote,
        WS_BRANCH: spec.branch,
        WS_MESSAGE: spec.message,
        WS_PUSHED: spec.pushedHead,
        ...tokenEnv(spec.token),
      },
    });
    const m = lastWsMarker(r.stdout.text) as {
      status?: unknown;
      head?: unknown;
      before?: unknown;
      committed?: unknown;
      files?: unknown;
    } | null;
    const head = typeof m?.head === "string" ? m.head : null;
    if (r.exitCode === 0 && m?.status === "nothing" && head !== null)
      return { status: "nothing", head };
    if (r.exitCode === 0 && m?.status === "pushed" && head !== null) {
      return {
        status: "pushed",
        head,
        before: typeof m.before === "string" && m.before !== "" ? m.before : null,
        committed: m.committed === true,
        files: typeof m.files === "number" ? m.files : 0,
      };
    }
    return {
      status: "rejected",
      head,
      message: redact(r.stderr.text, spec.token).trim().slice(-2000) || `exit ${r.exitCode}`,
    };
  }

  async snapshot(name: string): Promise<{ id: string }> {
    const s = await this.c.snapshotContainer({
      name: name.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 63),
    });
    return { id: s.id };
  }

  async destroy(): Promise<void> {
    const c = this.opts.container;
    try {
      if (c?.running) await c.destroy();
    } catch {
      // already stopped
    }
  }
}
