/**
 * Everything the CLI touches outside its own code, injectable so tests run it in-process with
 * fake clocks, servers and git.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type Connector, connectMcp, type FetchLike } from "./mcp.js";

export interface Writer {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git with extra environment variables (never extra argv: argv is visible in `ps`). */
export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<GitResult>;

/** How to run this CLI again (the git credential helper): node and the bundle, when it is one. */
export interface SelfCommand {
  node: string;
  /** Absolute path of the bundled cli.mjs, or null when running from source. */
  script: string | null;
}

export interface CliIo {
  stdout: Writer;
  stderr: Writer;
  /** All of stdin as text (only read when a command asks for `-`). */
  readStdin(): Promise<string>;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  home: string;
  fetch: FetchLike;
  connect: Connector;
  git: GitRunner;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** A fresh random id (idempotency keys). */
  randomId(): string;
  self: SelfCommand;
  /** Registers a Ctrl-C handler; returns its unregister function. */
  onInterrupt(handler: () => void): () => void;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

export const runGit: GitRunner = (args, opts) =>
  new Promise((resolve) => {
    const child = spawn("git", [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** In the bundle, this module is dist/cli.mjs itself. */
function selfCommand(): SelfCommand {
  let script: string | null = null;
  try {
    const file = fileURLToPath(import.meta.url);
    if (file.endsWith(".mjs") && existsSync(file)) script = file;
  } catch {
    script = null;
  }
  return { node: process.execPath, script };
}

export function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    readStdin: () => readAll(process.stdin),
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    fetch: (input, init) => fetch(input, init),
    connect: connectMcp,
    git: runGit,
    now: () => Date.now(),
    sleep,
    randomId: () => randomBytes(12).toString("base64url"),
    self: selfCommand(),
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => {
        process.off("SIGINT", handler);
      };
    },
  };
}
