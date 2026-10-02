import { describe, expect, it } from "vitest";
import { type AgentLimits, runAgent } from "../../src/agent/loop.js";
import { cachingStep, FakeClock, FakeTools, ScriptedModel, type ScriptedTurn } from "../fakes.js";

const LIMITS: AgentLimits = {
  maxToolCalls: 60,
  maxWallMs: 15 * 60_000,
  maxTokens: 1_500_000,
  maxTurns: 100,
};

function setup(script: ScriptedTurn[], limits: Partial<AgentLimits> = {}, callMs = 5000) {
  const clock = new FakeClock();
  const model = new ScriptedModel(script);
  const tools = new FakeTools(clock, {}, callMs);
  const step = cachingStep(clock);
  const input = {
    system: "You are a coding agent. Platform: https://p. Start at https://p/start.",
    task: "Do the thing.",
    model,
    tools,
    step,
    limits: { ...LIMITS, ...limits },
    contextChars: 100_000,
  };
  return { clock, model, tools, step, input };
}

describe("runAgent", () => {
  it("runs tool calls until the model answers, counting calls and tokens", async () => {
    const { input, tools, model } = setup([
      { call: "http_fetch", args: { url: "https://p/start" } },
      {
        calls: [
          { call: "mcp_call", args: { name: "whoami" } },
          { call: "shell", args: { command: "ls" } },
        ],
      },
      { final: "Deployed." },
    ]);
    const run = await runAgent(input);
    expect(run.stop).toBe("final");
    expect(run.finalMessage).toBe("Deployed.");
    expect(run.turns).toBe(3);
    expect(run.toolCalls).toBe(3);
    expect(run.toolCounts).toEqual({ http_fetch: 1, mcp_call: 1, shell: 1 });
    expect(run.usage).toEqual({ prompt: 300, completion: 30, cached: 0 });
    expect(tools.calls.map((c) => c.name)).toEqual(["http_fetch", "mcp_call", "shell"]);
    // The model sees only the system prompt and the task first.
    expect(model.seen[0]).toEqual([
      { role: "system", content: input.system },
      { role: "user", content: "Do the thing." },
    ]);
    // Tool results come back with their call ids.
    const last = model.seen[2]!;
    expect(last.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "ok http_fetch",
      "ok mcp_call",
      "ok shell",
    ]);
    expect(run.transcript.filter((t) => t.kind === "tool")).toHaveLength(3);
  });

  it("stops at the tool-call cap", async () => {
    const script: ScriptedTurn[] = Array.from({ length: 100 }, () => ({ call: "http_fetch" }));
    const { input, tools } = setup(script, { maxToolCalls: 5 });
    const run = await runAgent(input);
    expect(run.stop).toBe("step-cap");
    expect(run.toolCalls).toBe(5);
    expect(tools.calls).toHaveLength(5);
  });

  it("stops at the wall-clock cap and clamps the remaining time", async () => {
    const script: ScriptedTurn[] = Array.from({ length: 100 }, () => ({ call: "shell" }));
    const { input } = setup(script, { maxWallMs: 60_000 }, 20_000);
    const run = await runAgent(input);
    expect(run.stop).toBe("time-cap");
    expect(run.endedAt - run.startedAt).toBeGreaterThanOrEqual(60_000);
    expect(run.toolCalls).toBeLessThanOrEqual(3);
  });

  it("stops at the token budget", async () => {
    const script: ScriptedTurn[] = Array.from({ length: 100 }, () => ({ call: "http_fetch" }));
    const { input } = setup(script, { maxTokens: 330 });
    const run = await runAgent(input);
    expect(run.stop).toBe("token-cap");
    expect(run.turns).toBe(3);
  });

  it("ends with model-error when the model call fails (after the step's retries)", async () => {
    const { input } = setup([
      { call: "http_fetch" },
      { throws: "3040: Capacity temporarily exceeded" },
    ]);
    const run = await runAgent(input);
    expect(run.stop).toBe("model-error");
    expect(run.modelError).toContain("3040");
    expect(run.toolCalls).toBe(1);
  });

  it("answers bad arguments with an error result and counts it", async () => {
    const { input, tools, model } = setup([
      { call: "http_fetch", raw: "{not json" },
      { final: "gave up" },
    ]);
    const run = await runAgent(input);
    expect(tools.calls).toHaveLength(0);
    expect(run.toolErrors).toBe(1);
    const toolMsg = model.seen[1]!.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/not valid JSON/);
  });

  it("replays cached steps to the same history (Workflow resume)", async () => {
    const script: ScriptedTurn[] = [{ call: "http_fetch" }, { call: "shell" }, { final: "ok" }];
    const a = setup(script);
    const first = await runAgent(a.input);
    // A second pass over the same cached steps re-runs nothing and yields the same run.
    const replayModel = new ScriptedModel([]);
    const replayTools = new FakeTools(a.clock);
    const second = await runAgent({ ...a.input, model: replayModel, tools: replayTools });
    expect(replayModel.seen).toHaveLength(0);
    expect(replayTools.calls).toHaveLength(0);
    expect(replayTools.observed).toHaveLength(2);
    expect(second).toEqual(first);
  });
});
