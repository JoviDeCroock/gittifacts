import { describe, expect, it } from "vitest";
import {
  type AiBinding,
  AiBindingClient,
  type AiBindingRunOptions,
  bindingError,
  FallbackLlmClient,
  parseBindingOutput,
  reviewerLlmFromEnv,
} from "../src/binding.js";
import { AiGatewayClient, FakeLlmClient, LlmError, type LlmRequest } from "../src/llm.js";
import { createReviewer } from "../src/tour.js";
import { breakingApiInput, CHANGE_ID, goodModelTour } from "./support/scenario.js";

// Type-level: the real workers-types binding fits the interface we depend on.
export const realBindingFits = (ai: Ai): AiBinding => ai;

interface Call {
  model: string;
  inputs: Record<string, unknown>;
  options: AiBindingRunOptions | undefined;
}

/** A scripted stand-in for `env.AI`. */
class FakeAi implements AiBinding {
  readonly calls: Call[] = [];
  aiGatewayLogId: string | null = null;
  constructor(private readonly outputs: Array<unknown | Error>) {}
  async run(
    model: string,
    inputs: Record<string, unknown>,
    options?: AiBindingRunOptions,
  ): Promise<unknown> {
    this.calls.push({ model, inputs, options });
    const next = this.outputs.shift();
    if (next === undefined) throw new Error("FakeAi: no output left");
    if (next instanceof Error) throw next;
    this.aiGatewayLogId = `log-${this.calls.length}`;
    return next;
  }
}

const REQ: LlmRequest = {
  system: "You are a reviewer.",
  messages: [{ role: "user", content: "Review this." }],
  jsonSchema: {
    name: "tour",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  maxTokens: 1000,
  metadata: { change_id: "chg_1", purpose: "tour", head: "abc", attempt: 1, prompt: "p1" },
};

function chat(
  content: string,
  model = "anthropic/claude-sonnet-5",
  usage = { prompt_tokens: 10_000, completion_tokens: 2_000 },
) {
  return {
    id: "x",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

describe("AiBindingClient", () => {
  it("calls env.AI.run through the gateway with metadata and a JSON schema", async () => {
    const ai = new FakeAi([chat('{"ok":true}')]);
    const client = new AiBindingClient({ ai, gatewayId: "gittifacts", model: "auto" });
    const res = await client.complete(REQ);

    const call = ai.calls[0]!;
    // "auto" with the default one-model pool calls that model directly.
    expect(call.model).toBe("anthropic/claude-sonnet-5");
    expect(call.inputs).toEqual({
      messages: [
        { role: "system", content: "You are a reviewer." },
        { role: "user", content: "Review this." },
      ],
      max_tokens: 1000,
      response_format: {
        type: "json_schema",
        json_schema: { name: "tour", schema: REQ.jsonSchema!.schema, strict: true },
      },
    });
    expect(call.options?.gateway).toEqual({
      id: "gittifacts",
      metadata: REQ.metadata,
      requestTimeoutMs: 120_000,
    });
    expect(call.options?.extraHeaders).toBeUndefined();
    expect(call.options?.signal).toBeInstanceOf(AbortSignal);

    // 10k × $2/M + 2k × $10/M
    expect(res).toMatchObject({
      text: '{"ok":true}',
      json: { ok: true },
      model: "anthropic/claude-sonnet-5",
      logId: "log-1",
    });
    expect(res.costUsd).toBeCloseTo(0.04, 8);
    expect(res.usageEstimated).toBeUndefined();
  });

  it("passes the router pool as extra headers when it really routes (unverified on the binding)", () => {
    const client = new AiBindingClient({
      ai: new FakeAi([]),
      gatewayId: "gw",
      model: "auto",
      allowedModels: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5.5"],
    });
    const { model, options } = client.buildRun(REQ);
    expect(model).toBe("cloudflare/auto");
    expect(options.extraHeaders).toEqual({
      "cf-aig-allowed-models": "anthropic/claude-sonnet-5,anthropic/claude-opus-5.5",
    });
    expect(client.allowedModels).toHaveLength(2);
  });

  it("sends GLM-5.3-Flash a low reasoning effort by default, overridable, and nothing for other models", () => {
    const glm = (reasoningEffort?: "low" | "high" | "max") =>
      new AiBindingClient({
        ai: new FakeAi([]),
        gatewayId: "gw",
        model: "@cf/zai-org/glm-5.3-flash",
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }).buildRun(REQ).inputs;
    expect(glm().reasoning_effort).toBe("low");
    expect(glm("high").reasoning_effort).toBe("high");
    const kimi = new AiBindingClient({ ai: new FakeAi([]), gatewayId: "gw", model: "@cf/moonshotai/kimi-k2.7-code" });
    expect(kimi.buildRun(REQ).inputs).not.toHaveProperty("reasoning_effort");
  });

  it("supports older @cf models: their JSON mode and { response } output", async () => {
    const ai = new FakeAi([
      {
        response: { stops: [] },
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
    ]);
    const client = new AiBindingClient({
      ai,
      gatewayId: "gw",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      jsonMode: "workers-ai",
      prices: {
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inputPerMTok: 0.3, outputPerMTok: 2 },
      },
    });
    const res = await client.complete(REQ);
    expect(ai.calls[0]!.inputs.response_format).toEqual({
      type: "json_schema",
      json_schema: REQ.jsonSchema!.schema,
    });
    expect(res.json).toEqual({ stops: [] });
    expect(res.text).toBe('{"stops":[]}');
    expect(res.costUsd).toBeCloseTo((100 * 0.3 + 20 * 2) / 1e6, 10);
  });

  it("estimates usage when the model reports none (never free)", async () => {
    const ai = new FakeAi([{ response: '{"a":1}' }]);
    const client = new AiBindingClient({
      ai,
      gatewayId: "gw",
      model: "@cf/qwen/qwen3.8-27b",
      jsonMode: "none",
    });
    const res = await client.complete(REQ);
    expect(ai.calls[0]!.inputs.response_format).toBeUndefined();
    expect(res.usageEstimated).toBe(true);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.json).toEqual({ a: 1 });
  });

  it("reads Anthropic-shaped and Responses-shaped outputs too", () => {
    expect(
      parseBindingOutput({
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "{}" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    ).toMatchObject({
      text: "{}",
      usage: { inputTokens: 5, outputTokens: 1 },
      stopReason: "end_turn",
    });
    expect(
      parseBindingOutput({ output_text: "{}", usage: { input_tokens: 3, output_tokens: 2 } }),
    ).toMatchObject({
      text: "{}",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(() => parseBindingOutput({ image: "…" })).toThrow(/Unrecognized/);
    expect(() => parseBindingOutput("text")).toThrow(LlmError);
  });

  it("maps binding failures: 429-like → budget, aborts → timeout, others → http", async () => {
    expect(bindingError(new Error("AiError: 429 Too Many Requests"), 1000).kind).toBe("budget");
    expect(bindingError(new Error("Spend limit reached for gateway"), 1000).kind).toBe("budget");
    expect(
      bindingError(Object.assign(new Error("aborted"), { name: "TimeoutError" }), 1000).kind,
    ).toBe("timeout");
    expect(bindingError(new Error("InferenceUpstreamError: model not found"), 1000).kind).toBe(
      "http",
    );
    const client = new AiBindingClient({
      ai: new FakeAi([new Error("5xx upstream")]),
      gatewayId: "gw",
      model: "auto",
    });
    await expect(client.complete(REQ)).rejects.toMatchObject({ kind: "http" });
  });

  it("drives a full tour", async () => {
    const ai = new FakeAi([
      chat(JSON.stringify(goodModelTour()), "anthropic/claude-sonnet-5", {
        prompt_tokens: 6000,
        completion_tokens: 900,
      }),
    ]);
    const outcome = await createReviewer(
      new AiBindingClient({ ai, gatewayId: "gw", model: "auto" }),
    ).tour(breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: 0.5, spentUsd: 0 } }));
    expect(outcome.status).toBe("ok");
    expect(outcome.costUsd).toBeCloseTo((6000 * 2 + 900 * 10) / 1e6, 8);
    expect(ai.calls[0]!.options?.gateway?.metadata).toMatchObject({
      change_id: CHANGE_ID,
      purpose: "tour",
    });
  });
});

describe("FallbackLlmClient", () => {
  it("falls back to HTTP when the binding path fails", async () => {
    const primary = new FakeLlmClient([new LlmError("http", "binding: model not found")]);
    const fallback = new FakeLlmClient([{ text: "{}" }], { model: "fallback-model" });
    const client = new FallbackLlmClient(primary, fallback);
    await expect(client.complete(REQ)).resolves.toMatchObject({ model: "fallback-model" });
    expect(client.lastUsed).toBe("fallback");
  });

  it("never falls back on a budget refusal or a timeout", async () => {
    for (const kind of ["budget", "timeout"] as const) {
      const fallback = new FakeLlmClient([{ text: "{}" }]);
      const client = new FallbackLlmClient(new FakeLlmClient([new LlmError(kind, kind)]), fallback);
      await expect(client.complete(REQ)).rejects.toMatchObject({ kind });
      expect(fallback.requests).toHaveLength(0);
    }
  });
});

describe("reviewerLlmFromEnv", () => {
  const ai = new FakeAi([]);
  const http = { CF_ACCOUNT_ID: "acct", AI_GATEWAY_TOKEN: "tok" };

  it("prefers the binding, with HTTP as fallback when both are configured", () => {
    const both = reviewerLlmFromEnv({ AI: ai, AI_GATEWAY_ID: "gw", ...http }, { model: "auto" });
    expect(both).toBeInstanceOf(FallbackLlmClient);
    expect((both as FallbackLlmClient).primary).toBeInstanceOf(AiBindingClient);
    expect((both as FallbackLlmClient).fallback).toBeInstanceOf(AiGatewayClient);
    expect(both.allowedModels).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("uses whichever path is configured, and refuses when there is none", () => {
    expect(reviewerLlmFromEnv({ AI: ai, AI_GATEWAY_ID: "gw" }, { model: "auto" })).toBeInstanceOf(
      AiBindingClient,
    );
    expect(reviewerLlmFromEnv({ AI_GATEWAY_ID: "gw", ...http }, { model: "auto" })).toBeInstanceOf(
      AiGatewayClient,
    );
    expect(() => reviewerLlmFromEnv({ AI_GATEWAY_ID: "gw" }, { model: "auto" })).toThrow(
      /No model access/,
    );
    expect(() => reviewerLlmFromEnv({ AI: ai }, { model: "auto" })).toThrow();
    expect(() =>
      reviewerLlmFromEnv({ AI: { run: 1 }, AI_GATEWAY_ID: "gw" }, { model: "auto" }),
    ).toThrow();
  });
});
