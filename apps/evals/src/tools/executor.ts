/**
 * The harness side of the agent's tools: dispatch, argument checks, truncation, and the side
 * channel the checker needs (ids harvested from raw output, the MCP connection, preview probes
 * that time the first green while long calls such as wait_for_change are in flight).
 */
import { z } from "zod";
import type { ToolExecutor } from "../agent/loop.js";
import { truncate } from "../agent/messages.js";
import {
  emptyHarvest,
  errorOutcome,
  type Harvest,
  type McpState,
  mergeHarvest,
  type ToolOutcome,
} from "../agent/tool-outcome.js";
import type { ShellResult } from "../sandbox.js";
import type { ToolName } from "../tasks.js";
import { errorCodes, harvest } from "./harvest.js";
import { httpFetch } from "./http.js";
import { McpSessions } from "./mcp.js";
import { type FetchLike, probePreview } from "./probe.js";
import {
  RESULT_MAX_CHARS,
  SHELL_DEFAULT_TIMEOUT_SEC,
  SHELL_MAX_TIMEOUT_SEC,
  toolSpecs,
} from "./specs.js";

export interface HarnessDeps {
  fetcher: FetchLike;
  /** The run's sandbox (`EvalSandbox.exec`). */
  shell: (command: string, timeoutSec: number) => Promise<ShellResult>;
  previewSuffix: string;
  /** Headers added to requests to the platform and its previews (never to other hosts). */
  evalHeaders: (url: URL) => Record<string, string>;
  /** Probe harvested preview URLs to time the first green. */
  probes: boolean;
  /** Upper bound for one network call (long polls included). */
  maxCallMs?: number;
  probeIntervalMs?: number;
}

const ShellArgs = z.object({
  command: z.string().min(1),
  timeout_sec: z.coerce.number().int().positive().optional(),
});
const ConnectArgs = z.object({ url: z.string().min(1), token: z.string().min(1).optional() });
const CallArgs = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

interface Raw {
  text: string;
  raw: string;
  isError: boolean;
  meta?: ToolOutcome["meta"];
}

function invalid(tool: string, e: z.ZodError): Raw {
  const why = e.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
  return { text: `Error: invalid arguments for ${tool} (${why})`, raw: "", isError: true };
}

export class HarnessTools implements ToolExecutor {
  private mcpState: McpState | null = null;
  private found: Harvest = emptyHarvest();
  private green: { url: string; at: number } | null = null;
  private readonly mcp: McpSessions;

  constructor(
    private readonly names: readonly ToolName[],
    private readonly deps: HarnessDeps,
  ) {
    this.mcp = new McpSessions(deps.fetcher, (u) => this.headersFor(u));
  }

  specs() {
    return toolSpecs(this.names);
  }

  /** What the run produced so far: harvested ids and the first green preview. */
  collected(): { harvest: Harvest; firstGreen: { url: string; at: number } | null } {
    return { harvest: this.found, firstGreen: this.green };
  }

  observe(o: ToolOutcome): void {
    if ("mcp" in o.meta) this.mcpState = o.meta.mcp ?? null;
    this.found = mergeHarvest(this.found, o.meta.harvest);
    if (o.meta.firstGreen && (this.green === null || o.meta.firstGreen.at < this.green.at)) {
      this.green = o.meta.firstGreen;
    }
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  private headersFor(url: URL): Record<string, string> {
    const h: Record<string, string> = { "user-agent": "gittifacts-eval-agent/1.0" };
    return { ...h, ...this.deps.evalHeaders(url) };
  }

  async execute(
    call: { id: string; name: string; args: Record<string, unknown> },
    ctx: { remainingMs: number },
  ): Promise<ToolOutcome> {
    const t0 = Date.now();
    if (!(this.names as readonly string[]).includes(call.name)) {
      return errorOutcome(
        `Error: unknown tool "${call.name}". Available tools: ${this.names.join(", ")}.`,
        Date.now(),
      );
    }
    const timeoutMs = Math.max(1000, Math.min(ctx.remainingMs, this.deps.maxCallMs ?? 330_000));
    const settled = { done: false };
    const work = this.dispatch(call.name, call.args, timeoutMs).finally(() => {
      settled.done = true;
    });
    const [r, probedGreen] = await Promise.all([work, this.probeWhile(work, settled)]);
    const h = harvest(r.raw, this.deps.previewSuffix);
    let firstGreen = probedGreen;
    if (firstGreen === null && this.green === null && this.deps.probes) {
      // URLs this call revealed get one probe right away.
      const fresh = h.previewUrls.filter((u) => !this.found.previewUrls.includes(u)).slice(0, 3);
      firstGreen = await this.probeOnce(fresh);
    }
    return {
      content: r.text,
      isError: r.isError,
      errorCodes: errorCodes(r.raw),
      at: Date.now(),
      durationMs: Date.now() - t0,
      meta: { ...r.meta, harvest: h, ...(firstGreen ? { firstGreen } : {}) },
    };
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Raw> {
    switch (name) {
      case "http_fetch":
        return httpFetch(this.deps.fetcher, args, {
          timeoutMs,
          extraHeaders: (u) => this.headersFor(u),
        });
      case "mcp_connect": {
        const a = ConnectArgs.safeParse(args);
        if (!a.success) return invalid(name, a.error);
        const r = await this.mcp.connect(a.data.url, a.data.token ?? null, timeoutMs);
        return { ...r, meta: { mcp: r.state ?? null } };
      }
      case "mcp_list_tools":
        return this.mcp.listTools(this.mcpState, timeoutMs);
      case "mcp_call": {
        const a = CallArgs.safeParse(args);
        if (!a.success) return invalid(name, a.error);
        const r = await this.mcp.call(
          this.mcpState,
          a.data.name,
          a.data.arguments ?? {},
          timeoutMs,
        );
        return { ...r, meta: { mcpTool: a.data.name } };
      }
      case "shell":
        return this.runShell(args, timeoutMs);
      default:
        return { text: `Error: unknown tool "${name}"`, raw: "", isError: true };
    }
  }

  private async runShell(args: Record<string, unknown>, timeoutMs: number): Promise<Raw> {
    const a = ShellArgs.safeParse(args);
    if (!a.success) return invalid("shell", a.error);
    const secs = Math.max(
      1,
      Math.min(
        a.data.timeout_sec ?? SHELL_DEFAULT_TIMEOUT_SEC,
        SHELL_MAX_TIMEOUT_SEC,
        Math.floor((timeoutMs - 5000) / 1000),
      ),
    );
    const r = await this.deps.shell(a.data.command, secs);
    if (r.error !== null) return { text: `Error: ${r.error}`, raw: "", isError: true };
    const head = `exit code: ${r.exitCode}${r.timedOut ? ` (timed out after ${secs} s)` : ""}\n`;
    const tail = r.truncated ? `\n[output over ${r.outputBytes} bytes was cut at 128 KiB]` : "";
    const body = truncate(r.output, RESULT_MAX_CHARS - head.length - tail.length);
    // A non-zero exit is a normal result (a failing test), not a tool error.
    return { text: head + body + tail, raw: r.output, isError: false };
  }

  /** Probes the run's preview URLs every few seconds until the call settles; first green wins. */
  private async probeWhile(work: Promise<unknown>, settled: { done: boolean }) {
    if (!this.deps.probes || this.green !== null) return null;
    const every = this.deps.probeIntervalMs ?? 5000;
    const workDone = work.then(
      () => undefined,
      () => undefined,
    );
    while (!settled.done) {
      const g = await this.probeOnce(this.found.previewUrls);
      if (g !== null) return g;
      let id: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<void>((r) => {
        id = setTimeout(r, every);
      });
      await Promise.race([workDone, tick]);
      if (id !== undefined) clearTimeout(id);
    }
    return null;
  }

  private async probeOnce(urls: readonly string[]): Promise<{ url: string; at: number } | null> {
    if (urls.length === 0) return null;
    const results = await Promise.all(
      urls.map((u) =>
        probePreview(this.deps.fetcher, u, {
          timeoutMs: 8000,
          headers: this.headersFor(new URL(u)),
        }),
      ),
    );
    const greens = results.filter((r) => r.green).sort((a, b) => a.at - b.at);
    return greens[0] ? { url: greens[0].url, at: greens[0].at } : null;
  }
}
