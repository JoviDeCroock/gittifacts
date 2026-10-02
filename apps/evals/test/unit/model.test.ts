import { describe, expect, it } from "vitest";
import { compact, type Message, totalChars, truncate } from "../../src/agent/messages.js";
import { type AiRunner, parseCompletion, WorkersAiModel } from "../../src/agent/model.js";
import { parseJsonAction, toJsonActionMessages } from "../../src/agent/protocol.js";
import { MODELS, neuronsFor, usdForNeurons } from "../../src/models.js";

const kimi = MODELS[0]!;
const TOOLS = [{ name: "http_fetch", description: "fetch", parameters: { type: "object" } }];

describe("truncate", () => {
  it("keeps short text and cuts long text to the limit, head and tail", () => {
    expect(truncate("abc", 10)).toBe("abc");
    const long = `HEAD${"x".repeat(10_000)}TAIL`;
    const t = truncate(long, 500);
    expect(t.length).toBeLessThanOrEqual(500);
    expect(t.startsWith("HEAD")).toBe(true);
    expect(t.endsWith("TAIL")).toBe(true);
    expect(t).toMatch(/truncated \d+ characters/);
  });
});

describe("compact", () => {
  it("elides older tool results first and never the system prompt or the task", () => {
    const big = "y".repeat(5000);
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
    ];
    for (let i = 0; i < 10; i++) {
      msgs.push({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `c${i}`, type: "function", function: { name: "http_fetch", arguments: "{}" } },
        ],
      });
      msgs.push({ role: "tool", tool_call_id: `c${i}`, content: big });
    }
    const out = compact(msgs, 35_000);
    expect(totalChars(out)).toBeLessThanOrEqual(35_000);
    expect(out[0]).toEqual(msgs[0]);
    expect(out[1]).toEqual(msgs[1]);
    expect(out.at(-1)).toEqual(msgs.at(-1));
    expect((out[3] as { content: string }).content).toMatch(/elided/);
    expect(compact(msgs, 1_000_000)).toEqual(msgs);
  });
});

describe("parseCompletion", () => {
  it("reads OpenAI chat-completions output with tool calls and cached usage", () => {
    const t = parseCompletion({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "a",
                type: "function",
                function: { name: "http_fetch", arguments: '{"url":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    expect(t.toolCalls).toEqual([{ id: "a", name: "http_fetch", arguments: '{"url":"x"}' }]);
    expect(t.usage).toEqual({ prompt: 1000, completion: 50, cached: 800 });
  });

  it("reads the legacy Workers AI shape with object arguments", () => {
    const t = parseCompletion({
      response: null,
      tool_calls: [{ name: "shell", arguments: { command: "ls" } }],
    });
    expect(t.toolCalls).toEqual([{ id: "", name: "shell", arguments: '{"command":"ls"}' }]);
  });

  it("rejects anything else", () => {
    expect(() => parseCompletion({ nope: 1 })).toThrow(/unrecognised/);
  });
});

describe("json actions", () => {
  it("parses a fenced call, a final answer, and ignores prose", () => {
    expect(parseJsonAction('```json\n{"tool":"shell","arguments":{"command":"ls"}}\n```')).toEqual({
      kind: "call",
      call: { name: "shell", arguments: '{"command":"ls"}' },
    });
    expect(parseJsonAction('{"final":"done"}')).toEqual({ kind: "final", text: "done" });
    expect(parseJsonAction('I will call {"tool":"x"} now')).toEqual({ kind: "none" });
  });

  it("rewrites tool history into user messages and adds the tool list once", () => {
    const out = toJsonActionMessages(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "http_fetch", arguments: '{"url":"u"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "HTTP 200" },
      ],
      TOOLS,
    );
    expect(out.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user"]);
    expect(out[1]!.content).toContain("http_fetch");
    expect(out[3]!.content).toBe('{"tool":"http_fetch","arguments":{"url":"u"}}');
    expect(out[4]!.content).toBe("Result of http_fetch:\nHTTP 200");
  });
});

describe("WorkersAiModel", () => {
  it("calls the binding through the gateway with metadata, tools and no cache", async () => {
    const calls: { model: string; inputs: Record<string, unknown>; options: unknown }[] = [];
    const ai: AiRunner = {
      async run(model, inputs, options) {
        calls.push({ model, inputs, options });
        return { choices: [{ message: { content: '{"final":"hi"}' }, finish_reason: "stop" }] };
      },
    };
    const m = new WorkersAiModel({
      ai,
      model: kimi,
      gatewayId: "gittifacts",
      metadata: { run: "r1", task: "t1", model: "kimi" },
    });
    const turn = await m.complete({ messages: [{ role: "user", content: "x" }], tools: TOOLS });
    expect(turn.content).toBe("hi");
    expect(calls[0]!.model).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(calls[0]!.inputs.tool_choice).toBe("auto");
    expect(calls[0]!.inputs.tools).toEqual([
      {
        type: "function",
        function: { name: "http_fetch", description: "fetch", parameters: { type: "object" } },
      },
    ]);
    expect(calls[0]!.options).toMatchObject({
      gateway: {
        id: "gittifacts",
        metadata: { run: "r1", task: "t1", model: "kimi" },
        skipCache: true,
      },
    });
  });

  it("json-actions models get no tools field and one call per reply", async () => {
    let seen: Record<string, unknown> = {};
    const ai: AiRunner = {
      async run(_m, inputs) {
        seen = inputs;
        return {
          choices: [{ message: { content: '{"tool":"http_fetch","arguments":{"url":"u"}}' } }],
        };
      },
    };
    const m = new WorkersAiModel({
      ai,
      model: { ...kimi, protocol: "json-actions" },
      gatewayId: "g",
      metadata: {},
    });
    const turn = await m.complete({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "x" },
      ],
      tools: TOOLS,
    });
    expect(seen.tools).toBeUndefined();
    expect(turn.toolCalls).toEqual([{ id: "", name: "http_fetch", arguments: '{"url":"u"}' }]);
  });
});

describe("cost", () => {
  it("prices tokens in neurons with the cached-input rate", () => {
    const n = neuronsFor(kimi, { prompt: 1_000_000, completion: 100_000, cached: 500_000 });
    expect(n).toBe(Math.round(500_000 * 0.086364 + 500_000 * 0.017273 + 100_000 * 0.363636));
    expect(usdForNeurons(100_000)).toBeCloseTo(1.1, 5);
  });
});
