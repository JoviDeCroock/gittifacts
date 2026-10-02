/**
 * `EvalSandbox`: the `shell` tool's machine. One Durable Object per run (name = run id) drives a
 * `ctx.container` on the platform's sandbox image (git, node 22, pnpm, wrangler), started lazily
 * on the first command with open internet (the agent needs the platform, its git host and the
 * package registries). Same exec contract as the platform's Runner: `sh -c` under
 * `timeout --kill-after`, as the image's unprivileged user, in /workspace.
 */
import { DurableObject } from "cloudflare:workers";

/** The slice of `ctx.container` used here; tests inject a fake. */
export interface ContainerLike {
  readonly running: boolean;
  readonly images: Record<string, string>;
  start(options: ContainerStartupOptions): void;
  exec(
    cmd: string[],
    options?: ContainerExecOptions,
  ): Promise<{
    readonly stdout: ReadableStream<Uint8Array> | null;
    readonly exitCode: Promise<number>;
  }>;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
}

export interface ShellResult {
  exitCode: number | null;
  output: string;
  outputBytes: number;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Infrastructure failure (container could not start, exec failed). */
  error: string | null;
}

export const WORKSPACE = "/workspace";
export const RUNNER_USER = "10001:10001";
const KILL_AFTER_SECONDS = 10;
const START_TIMEOUT_MS = 3 * 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
/** Backstop: a sandbox left behind by a crashed run stops itself. */
const INACTIVITY_MS = 30 * 60_000;

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("cannot shell-quote a string containing NUL");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `sh -c "exec timeout --kill-after=10 <secs> sh -c '<cmd>'"`: exit 124/137 = timed out. */
export function timedCommandArgv(command: string, timeoutSeconds: number): string[] {
  return [
    "sh",
    "-c",
    `exec timeout --kill-after=${KILL_AFTER_SECONDS} ${timeoutSeconds} sh -c ${shellQuote(command)}`,
  ];
}

const EXEC_ENV: Record<string, string> = {
  HOME: "/home/runner",
  LANG: "C.UTF-8",
  TERM: "dumb",
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
};

export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (stream === null) return { text: "", bytes: 0, truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (kept < maxBytes) {
      const slice = value.subarray(0, maxBytes - kept);
      chunks.push(slice);
      kept += slice.byteLength;
    }
  }
  const buf = new Uint8Array(kept);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), bytes: total, truncated: total > maxBytes };
}

function label(v: string): string {
  return (
    v
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63) || "run"
  );
}

/** A cancelable timer that resolves "timeout" (cleared once the race it guards is over). */
function timer(ms: number): { done: Promise<"timeout">; clear: () => void } {
  let id: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((r) => {
    id = setTimeout(() => r("timeout"), ms);
  });
  return { done, clear: () => (id === undefined ? undefined : clearTimeout(id)) };
}

export class EvalSandbox<E = unknown> extends DurableObject<E> {
  private starting: Promise<void> | null = null;

  /** The container. Production: `ctx.container`. Tests override this. */
  protected container(): ContainerLike {
    const c = this.ctx.container as ContainerLike | undefined;
    if (c === undefined) {
      throw new Error('no container is attached (containers[] must name class "EvalSandbox")');
    }
    return c;
  }

  private async ensureStarted(c: ContainerLike, runLabel: string): Promise<void> {
    if (c.running && this.starting === null) return;
    this.starting ??= (async () => {
      const image = c.images.base;
      if (image === undefined) throw new Error('no "base" image in containers[].images');
      c.start({
        image,
        enableInternet: true,
        instance: "standard-1",
        labels: { "gf-eval-run": label(runLabel) },
      });
      await c.setInactivityTimeout(INACTIVITY_MS);
      const ready = (async () => {
        const p = await c.exec(["true"], { stdout: "ignore", stderr: "ignore" });
        await p.exitCode;
      })();
      const t = timer(START_TIMEOUT_MS);
      const r = await Promise.race([ready.then(() => "ok" as const), t.done]).finally(t.clear);
      if (r !== "ok")
        throw new Error(`the sandbox was not ready after ${START_TIMEOUT_MS / 1000} s`);
    })();
    try {
      await this.starting;
    } catch (e) {
      this.starting = null;
      throw e;
    }
    this.starting = null;
  }

  /** Runs one command. Never throws: infrastructure failures come back in `error`. */
  async exec(command: string, timeoutSeconds: number, runLabel = "run"): Promise<ShellResult> {
    const t0 = Date.now();
    const secs = Math.max(1, Math.min(3600, Math.floor(timeoutSeconds)));
    const fail = (error: string): ShellResult => ({
      exitCode: null,
      output: "",
      outputBytes: 0,
      truncated: false,
      timedOut: false,
      durationMs: Date.now() - t0,
      error,
    });
    let c: ContainerLike;
    try {
      c = this.container();
      await this.ensureStarted(c, runLabel);
    } catch (e) {
      return fail(`the sandbox could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const proc = await c.exec(timedCommandArgv(command, secs), {
        cwd: WORKSPACE,
        user: RUNNER_USER,
        env: EXEC_ENV,
        stdout: "pipe",
        stderr: "combined",
      });
      const watchdog = timer((secs + KILL_AFTER_SECONDS + 20) * 1000);
      const done = Promise.all([readCapped(proc.stdout, MAX_OUTPUT_BYTES), proc.exitCode]);
      const r = await Promise.race([done, watchdog.done]).finally(watchdog.clear);
      if (r === "timeout") {
        return { ...fail("the command did not exit after its timeout"), timedOut: true };
      }
      const [out, exitCode] = r;
      return {
        exitCode,
        output: out.text,
        outputBytes: out.bytes,
        truncated: out.truncated,
        timedOut: exitCode === 124 || exitCode === 137,
        durationMs: Date.now() - t0,
        error: null,
      };
    } catch (e) {
      return fail(`exec failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Stops the container (end of run). Safe to call when nothing was started. */
  async destroy(): Promise<void> {
    try {
      const c = this.container();
      if (c.running) await c.destroy("eval run finished");
    } catch {
      // nothing to stop
    }
  }
}
