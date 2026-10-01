/**
 * In-process CLI harness: captured stdout/stderr, a temp cwd/home/config dir, an instant
 * (recorded) sleep, and hooks for the MCP connector, fetch and git.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo, Writer } from "../../src/io.js";
import { runCli } from "../../src/main.js";
import { connectMcp } from "../../src/mcp.js";

export interface Capture extends Writer {
  text: string;
}

function capture(isTTY = false): Capture {
  const w: Capture = {
    text: "",
    isTTY,
    columns: 120,
    write(chunk: string) {
      w.text += chunk;
      return true;
    },
  };
  return w;
}

export interface Harness {
  io: CliIo;
  dir: string;
  stdout: Capture;
  stderr: Capture;
  sleeps: number[];
  /** Simulated wall clock (ms); sleeps advance it. */
  clock: { now: number };
  interrupt(): void;
  cleanup(): void;
}

export function tempDir(prefix = "gittifacts-cli-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function harness(
  over: Partial<CliIo> & { stdin?: string; env?: Record<string, string | undefined>; tty?: boolean } = {},
): Harness {
  const dir = tempDir();
  const stdout = capture(over.tty ?? false);
  const stderr = capture(over.tty ?? false);
  const sleeps: number[] = [];
  const clock = { now: Date.parse("2026-10-01T12:00:00Z") };
  const handlers = new Set<() => void>();
  let id = 0;
  const { stdin, env, tty: _tty, ...rest } = over;
  const io: CliIo = {
    stdout,
    stderr,
    readStdin: async () => stdin ?? "",
    env: { GITTIFACTS_CONFIG_DIR: join(dir, "config"), ...env },
    cwd: dir,
    home: join(dir, "home"),
    fetch: (input, init) => fetch(input, init),
    connect: connectMcp,
    git: async () => ({ code: 0, stdout: "", stderr: "" }),
    now: () => clock.now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      sleeps.push(ms);
      clock.now += ms;
    },
    randomId: () => `id${++id}`,
    onInterrupt(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    ...rest,
  };
  return {
    io,
    dir,
    stdout,
    stderr,
    sleeps,
    clock,
    interrupt: () => {
      for (const h of handlers) h();
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function run(h: Harness, argv: string[]) {
  h.stdout.text = "";
  h.stderr.text = "";
  const code = await runCli(argv, h.io);
  return {
    code,
    stdout: h.stdout.text,
    stderr: h.stderr.text,
    json: (): unknown => JSON.parse(h.stdout.text),
  };
}
