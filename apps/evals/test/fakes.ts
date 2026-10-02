/** Fakes shared by the unit and worker tests: a scripted model and a fake tool executor. */
import type { DurableStep, ToolExecutor } from "../src/agent/loop.js";
import type { Message } from "../src/agent/messages.js";
import type { ChatModel, ModelTurn } from "../src/agent/model.js";
import type { ToolSpec } from "../src/agent/protocol.js";
import type { ToolOutcome } from "../src/agent/tool-outcome.js";

export type ScriptedTurn =
  | { call: string; args?: Record<string, unknown>; raw?: string }
  | { calls: { call: string; args?: Record<string, unknown> }[] }
  | { final: string }
  | { throws: string };

/** Replies from a script, in order; records what it was sent. After the script: final "done". */
export class ScriptedModel implements ChatModel {
  readonly seen: Message[][] = [];
  private i = 0;
  constructor(
    private readonly script: ScriptedTurn[],
    private readonly usage = { prompt: 100, completion: 10, cached: 0 },
  ) {}

  async complete(req: {
    messages: readonly Message[];
    tools: readonly ToolSpec[];
  }): Promise<ModelTurn> {
    this.seen.push([...req.messages]);
    const t = this.script[this.i++] ?? { final: "done" };
    const usage = { ...this.usage };
    if ("throws" in t) throw new Error(t.throws);
    if ("final" in t) return { content: t.final, toolCalls: [], usage, finishReason: "stop" };
    const list = "calls" in t ? t.calls : [t];
    return {
      content: null,
      toolCalls: list.map((c, j) => ({
        id: `s${this.i}_${j}`,
        name: c.call,
        arguments: "raw" in c && typeof c.raw === "string" ? c.raw : JSON.stringify(c.args ?? {}),
      })),
      usage,
      finishReason: "tool_calls",
    };
  }
}

/** A fake clock: every read advances it by `tickMs`. */
export class FakeClock {
  constructor(
    public now = Date.parse("2026-10-03T03:00:00.000Z"),
    private readonly tickMs = 1000,
  ) {}
  read(): number {
    this.now += this.tickMs;
    return this.now;
  }
}

/** Tools that answer `ok <name>` (or a scripted outcome) and advance the fake clock. */
export class FakeTools implements ToolExecutor {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly observed: ToolOutcome[] = [];
  constructor(
    private readonly clock: FakeClock,
    private readonly answers: Record<string, Partial<ToolOutcome>> = {},
    private readonly callMs = 5000,
  ) {}
  specs(): ToolSpec[] {
    return ["http_fetch", "mcp_call", "shell"].map((name) => ({
      name,
      description: name,
      parameters: { type: "object" },
    }));
  }
  async execute(call: { name: string; args: Record<string, unknown> }): Promise<ToolOutcome> {
    this.calls.push(call);
    this.clock.now += this.callMs;
    const a = this.answers[call.name] ?? {};
    return {
      content: `ok ${call.name}`,
      isError: false,
      errorCodes: [],
      at: this.clock.now,
      durationMs: this.callMs,
      meta: {},
      ...a,
    };
  }
  observe(o: ToolOutcome): void {
    this.observed.push(o);
  }
}

/** A DurableStep that caches results by name, like Workflows' step.do on replay. */
export function cachingStep(clock: FakeClock): DurableStep & { cache: Map<string, unknown> } {
  const cache = new Map<string, unknown>();
  const step = (async <T>(name: string, kind: string, fn: () => Promise<T>): Promise<T> => {
    if (cache.has(name)) return cache.get(name) as T;
    const realNow = Date.now;
    if (kind === "clock" || kind === "model") Date.now = () => clock.read();
    try {
      const v = await fn();
      cache.set(name, v);
      return v;
    } finally {
      Date.now = realNow;
    }
  }) as DurableStep & { cache: Map<string, unknown> };
  step.cache = cache;
  return step;
}
