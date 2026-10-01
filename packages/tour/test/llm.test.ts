import { describe, expect, it } from "vitest";
import {
  AiGatewayClient,
  FakeLlmClient,
  LlmError,
  type LlmRequest,
  normalizeMetadata,
  parseJsonLoose,
  resolveReviewerModel,
} from "../src/llm.js";

const REQ: LlmRequest = {
  system: "You are a reviewer.",
  messages: [{ role: "user", content: "Review this." }],
  jsonSchema: { name: "tour", schema: { type: "object", properties: {}, additionalProperties: false } },
  maxTokens: 1000,
  metadata: { change_id: "chg_1", purpose: "tour", head: "abc", attempt: 1, prompt: "p1" },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(response: { status?: number; body: unknown; headers?: Record<string, string> }, captured: Captured[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: response.headers ?? {},
    });
  }) as typeof fetch;
}

describe("resolveReviewerModel", () => {
  it('maps policy "auto" to the Auto Router and passes explicit models through', () => {
    expect(resolveReviewerModel("auto")).toBe("cloudflare/auto");
    expect(resolveReviewerModel("")).toBe("cloudflare/auto");
    expect(resolveReviewerModel("anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
  });
});

describe("AiGatewayClient (chat completions, Auto Router)", () => {
  it("calls the unified endpoint with gateway id, metadata and a JSON schema", async () => {
    const captured: Captured[] = [];
    const client = new AiGatewayClient({
      accountId: "acct",
      gatewayId: "gittifacts",
      apiToken: "tok",
      model: "auto",
      allowedModels: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"],
      fetch: fakeFetch(
        {
          body: {
            model: "anthropic/claude-sonnet-5-5",
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
          },
          headers: { "cf-aig-routed-model": "anthropic/claude-sonnet-5-5", "cf-aig-log-id": "log-1" },
        },
        captured,
      ),
    });
    const res = await client.complete(REQ);

    const call = captured[0]!;
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer tok");
    expect(call.headers["cf-aig-gateway-id"]).toBe("gittifacts");
    expect(JSON.parse(call.headers["cf-aig-metadata"]!)).toEqual(REQ.metadata);
    expect(call.headers["cf-aig-allowed-models"]).toBe("anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5");
    expect(call.body).toMatchObject({
      model: "cloudflare/auto",
      max_tokens: 1000,
      messages: [
        { role: "system", content: "You are a reviewer." },
        { role: "user", content: "Review this." },
      ],
      response_format: { type: "json_schema", json_schema: { name: "tour", strict: true } },
    });

    // Cost uses the routed model: 10k × $2/M + 2k × $10/M.
    expect(res).toMatchObject({
      text: '{"ok":true}',
      json: { ok: true },
      model: "anthropic/claude-sonnet-5-5",
      usage: { inputTokens: 10_000, outputTokens: 2_000 },
      stopReason: "stop",
      logId: "log-1",
    });
    expect(res.costUsd).toBeCloseTo(0.04, 8);
  });

  it("prices an unknown routed model at the ceiling (never cheaper than reality)", async () => {
    const client = new AiGatewayClient({
      accountId: "acct",
      gatewayId: "gw",
      apiToken: "tok",
      model: "auto",
      fetch: fakeFetch(
        {
          body: {
            model: "xai/grok-4.5",
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
          },
        },
        [],
      ),
    });
    const res = await client.complete(REQ);
    expect(res.costUsd).toBe(10);
  });

  it("maps HTTP 429 to a budget error and other failures to http errors", async () => {
    const mk = (status: number) =>
      new AiGatewayClient({
        accountId: "a",
        gatewayId: "g",
        apiToken: "t",
        model: "auto",
        fetch: fakeFetch({ status, body: { error: "nope" } }, []),
      });
    await expect(mk(429).complete(REQ)).rejects.toMatchObject({ kind: "budget", status: 429 });
    await expect(mk(500).complete(REQ)).rejects.toMatchObject({ kind: "http", status: 500 });
  });

  it("rejects responses without usage (cost would be unknown)", async () => {
    const client = new AiGatewayClient({
      accountId: "a",
      gatewayId: "g",
      apiToken: "t",
      model: "auto",
      fetch: fakeFetch({ body: { choices: [{ message: { content: "{}" } }] } }, []),
    });
    await expect(client.complete(REQ)).rejects.toBeInstanceOf(LlmError);
  });

  it("refuses the Anthropic schema for the Auto Router", () => {
    expect(
      () => new AiGatewayClient({ accountId: "a", gatewayId: "g", apiToken: "t", model: "auto", format: "anthropic-messages" }),
    ).toThrow(/Auto Router/);
  });
});

describe("AiGatewayClient (Anthropic messages)", () => {
  it("sends output_config.format and accounts cache tokens", async () => {
    const captured: Captured[] = [];
    const client = new AiGatewayClient({
      accountId: "acct",
      gatewayId: "gw",
      apiToken: "tok",
      model: "anthropic/claude-opus-5-5",
      format: "anthropic-messages",
      effort: "medium",
      fetch: fakeFetch(
        {
          body: {
            model: "claude-opus-5-5",
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: '{"a":1}' },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 10_000 },
          },
        },
        captured,
      ),
    });
    const res = await client.complete(REQ);

    const call = captured[0]!;
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/messages");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body).toMatchObject({
      model: "anthropic/claude-opus-5-5",
      max_tokens: 1000,
      system: "You are a reviewer.",
      messages: [{ role: "user", content: "Review this." }],
      output_config: { format: { type: "json_schema", schema: REQ.jsonSchema!.schema }, effort: "medium" },
    });
    expect(res.text).toBe('{"a":1}');
    expect(res.json).toEqual({ a: 1 });
    expect(res.stopReason).toBe("end_turn");
    // 1k × $4/M + 500 × $20/M + 10k cache reads × $0.20/M
    expect(res.costUsd).toBeCloseTo(0.004 + 0.01 + 0.002, 8);
  });

  it("uses cf-aig-authorization on the provider-native gateway URL", () => {
    const client = new AiGatewayClient({
      gatewayId: "gw",
      apiToken: "tok",
      model: "claude-opus-5-5",
      format: "anthropic-messages",
      endpoint: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    });
    const { url, headers } = client.buildRequest(REQ);
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages");
    expect(headers["cf-aig-authorization"]).toBe("Bearer tok");
    expect(headers.authorization).toBeUndefined();
  });

  it("builds from Worker env vars", () => {
    const client = AiGatewayClient.fromEnv(
      { CF_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: "tok" },
      { model: "auto" },
    );
    expect(client.model).toBe("cloudflare/auto");
    expect(client.url).toContain("/accounts/acct/ai/v1/chat/completions");
    expect(() => AiGatewayClient.fromEnv({ CF_ACCOUNT_ID: "acct" }, { model: "auto" })).toThrow();
  });
});

describe("metadata and JSON helpers", () => {
  it("keeps at most five entries and drops reserved cf.* keys", () => {
    expect(normalizeMetadata({ "cf.x": 1, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 });
  });

  it("parses raw, fenced and embedded JSON, and returns undefined otherwise", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Here you go: {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(parseJsonLoose("no json here")).toBeUndefined();
  });
});

describe("FakeLlmClient", () => {
  it("replays scripted responses in order and records requests", async () => {
    const client = new FakeLlmClient(["hello", { json: { a: 1 }, costUsd: 0.5 }, new Error("boom")]);
    await expect(client.complete(REQ)).resolves.toMatchObject({ text: "hello", costUsd: 0.01 });
    await expect(client.complete(REQ)).resolves.toMatchObject({ json: { a: 1 }, costUsd: 0.5 });
    await expect(client.complete(REQ)).rejects.toThrow("boom");
    await expect(client.complete(REQ)).rejects.toThrow(/no scripted response/);
    expect(client.requests).toHaveLength(4);
  });
});
