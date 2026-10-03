/**
 * Captures a terminal session for replay: each command's output with real timestamps (ms since
 * the session started). Secrets never reach the cast: tokens are redacted before they are stored.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type EventKind = "cmd" | "out" | "err" | "note" | "chapter" | "metric";
export interface CastEvent {
  t: number;
  k: EventKind;
  d: string;
}
export interface Cast {
  number: string;
  slug: string;
  title: string;
  subtitle?: string;
  persona: "agent";
  mode: "live";
  host: string;
  date: string;
  startedAt: string;
  prompt: string;
  events: CastEvent[];
  metrics: Record<string, number | string>;
}

/** Token shapes the platform and git hand out, plus any JSON "token"/"secret" value. */
export function redact(text: string): string {
  return text
    .replace(/\b(gt[a-z]{0,3}_)[A-Za-z0-9_-]{12,}/g, "$1«redacted»")
    .replace(
      /("(?:[a-zA-Z]*[tT]oken|secret|clientSecret|password)"\s*:\s*")[^"]+"/g,
      '$1«redacted»"',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=?&-]{12,}/g, "$1«redacted»")
    .replace(/(art_v1_)[A-Za-z0-9]+/g, "$1«redacted»");
}

export class Term {
  readonly t0 = Date.now();
  readonly cast: Cast;

  constructor(meta: Omit<Cast, "startedAt" | "events" | "metrics" | "persona" | "mode" | "date">) {
    this.cast = {
      ...meta,
      persona: "agent",
      mode: "live",
      date: new Date().toISOString().slice(0, 10),
      startedAt: new Date().toISOString(),
      events: [],
      metrics: {},
    };
  }

  get now(): number {
    return Date.now() - this.t0;
  }

  private push(k: EventKind, d: string): void {
    this.cast.events.push({ t: this.now, k, d: redact(d) });
    if (k === "out" || k === "err" || k === "note") process.stdout.write(redact(d));
    if (k === "cmd") process.stdout.write(`$ ${d}\n`);
  }

  chapter(label: string): void {
    this.push("chapter", label);
  }
  /** A narration line (shown dimmed, as a shell comment). */
  note(text: string): void {
    this.push("note", `# ${text}\n`);
  }
  print(text: string): void {
    this.push("out", text.endsWith("\n") ? text : `${text}\n`);
  }
  /** Show a command as typed, without running it (for in-process tools such as an MCP client). */
  typed(display: string): void {
    this.push("cmd", display);
  }
  metric(name: string, value: number | string): void {
    this.cast.metrics[name] = value;
    this.push("metric", `${name}=${value}`);
  }

  /** Runs `cmd` through bash, showing `display` as the typed command. Output streams with timestamps. */
  run(
    display: string,
    cmd: string,
    opts: { env?: Record<string, string>; cwd?: string; quiet?: boolean } = {},
  ): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
    this.push("cmd", display);
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", cmd], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString();
        if (!opts.quiet) this.push("out", b.toString());
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString();
        if (!opts.quiet) this.push("err", b.toString());
      });
      child.on("close", (code) =>
        resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started }),
      );
    });
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(this.cast, null, 1)}\n`);
  }
}
