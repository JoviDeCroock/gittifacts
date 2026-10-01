/**
 * Child processes with a hard timeout that kills the whole process group (test runners fork
 * workers), output captured (capped) and mirrored to stderr, and an environment scrubbed of
 * platform credentials: repository code never sees the checkout token.
 */
import { spawn } from "node:child_process";
import { passthrough } from "./log.js";

export interface RunOptions {
  cwd: string;
  /** Extra variables; merged over the scrubbed parent environment. `undefined` deletes. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
  /** Mirror output to stderr (default true). */
  echo?: boolean;
  /** Max characters of stdout/stderr kept in memory each (default 8 MiB). */
  maxCapture?: number;
}

export interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Variables never passed to repository code. */
const SCRUBBED = [
  "GITTIFACTS_TOKEN",
  // Resolution must come from the checkout's node_modules, not the caller's environment.
  "NODE_PATH",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_ASKPASS",
  "SSH_AUTH_SOCK",
];

export function scrubbedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SCRUBBED.includes(key)) continue;
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) continue;
    // Vitest sets these in its own workers; a nested vitest must not inherit them.
    if (key === "VITEST" || key.startsWith("VITEST_") || key === "TEST" || key === "NODE_V8_COVERAGE")
      continue;
    env[key] = value;
  }
  env.CI = "1";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Process groups of running children, so a terminating runner can take them down with it. */
const activeGroups = new Set<number>();

export function killAllChildren(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of activeGroups) {
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

class Capture {
  private text = "";
  private dropped = false;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    if (this.text.length + chunk.length <= this.max) {
      this.text += chunk;
      return;
    }
    // Keep the tail: failures are usually reported last.
    this.text = (this.text + chunk).slice(-this.max);
    this.dropped = true;
  }
  toString(): string {
    return this.dropped ? `…(truncated)\n${this.text}` : this.text;
  }
}

export function run(command: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const echo = opts.echo ?? true;
  const max = opts.maxCapture ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: scrubbedEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    if (child.pid !== undefined) activeGroups.add(child.pid);
    const out = new Capture(max);
    const err = new Capture(max);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 5_000);
      }, opts.timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out.push(chunk);
      if (echo) passthrough(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      err.push(chunk);
      if (echo) passthrough(chunk);
    });
    child.on("error", (error) => {
      if (child.pid !== undefined) activeGroups.delete(child.pid);
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (child.pid !== undefined) activeGroups.delete(child.pid);
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Reap anything the child left behind in its group (e.g. orphaned workers).
      if (timedOut) killGroup("SIGKILL");
      resolve({
        code: code ?? (signal ? 128 : 1),
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** `sh -c <command>` with the same guarantees as {@link run}. */
export function runShell(command: string, opts: RunOptions): Promise<RunResult> {
  return run("sh", ["-c", command], opts);
}
