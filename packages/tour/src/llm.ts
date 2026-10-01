/**
 * A minimal model client. The reviewer only needs "send a system prompt + messages, get text (and
 * maybe JSON) back, with usage and cost". Two implementations:
 *
 * - {@link AiGatewayClient}: Cloudflare AI Gateway over `fetch`, either the unified OpenAI-style
 *   `/ai/v1/chat/completions` endpoint (the default; required for the Auto Router `cloudflare/auto`)
 *   or the Anthropic-schema `/ai/v1/messages` endpoint (native structured output).
 * - {@link FakeLlmClient}: deterministic scripted responses for tests.
 */
import { z } from "zod";
import {
  AUTO_ROUTER_MODEL,
  costOfUsage,
  DEFAULT_PRICES,
  type PriceTable,
  type TokenUsage,
} from "./budget.js";

// ---------------------------------------------------------------- interface

export type JsonSchema = { [key: string]: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** AI Gateway metadata: at most 5 entries, flat values. Keys starting with `cf.` are reserved. */
export type LlmMetadata = Readonly<Record<string, string | number | boolean>>;

export interface LlmRequest {
  system: string;
  messages: readonly LlmMessage[];
  /** Ask for structured output matching this schema (best effort: callers still validate). */
  jsonSchema?: { name: string; schema: JsonSchema };
  maxTokens: number;
  metadata: LlmMetadata;
}

export interface LlmResponse {
  text: string;
  /** Parsed JSON when the provider returned structured output or the text parsed cleanly. */
  json?: unknown;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  /** The model that actually answered (the routed model for `cloudflare/auto`). */
  model: string;
  /** Provider stop/finish reason when known ("end_turn", "stop", "length", "max_tokens", "refusal"). */
  stopReason?: string;
  /** AI Gateway log id (`cf-aig-log-id`), for audit links. */
  logId?: string;
  /** The provider returned no token usage; tokens (and cost) were estimated from text length. */
  usageEstimated?: boolean;
}

export interface LlmClient {
  /** The requested model id (e.g. `cloudflare/auto`, `anthropic/claude-opus-5-5`). Used for estimates. */
  readonly model: string;
  /** Optional Auto Router allow-list, so estimates can use the pool's ceiling price. */
  readonly allowedModels?: readonly string[];
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind =
  /** The gateway refused for spend (HTTP 429: spend-limit rule or rate limit; we can't tell). */
  "budget" | "http" | "network" | "timeout" | "bad-response";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;

  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

/** Policy's `ai.reviewerModel`: "auto" means the AI Gateway Auto Router. */
export function resolveReviewerModel(policyModel: string): string {
  const m = policyModel.trim();
  return m === "" || m === "auto" ? AUTO_ROUTER_MODEL : m;
}

/**
 * The pool the reviewer routes within when the policy says "auto" and no pool is configured.
 *
 * Claude Sonnet 5 ($2 / $10 per MTok) is the cheapest Anthropic model in the Auto Router's
 * documented default pool (docs/research/release-observability.md §6, verified 2026-10-01).
 * Claude Sonnet 5.5 (same price) and Claude Haiku 4.5 ($1 / $5) are not listed in the router pool
 * yet, and an allow-list entry the pool does not contain makes every request fail with HTTP 400,
 * so they are not the default. Swapping them in later keeps the $2 / $10 ceiling, so the budget
 * arithmetic in README.md does not change. Pass `allowedModels: []` to use the router's full pool.
 */
export const DEFAULT_REVIEWER_POOL: readonly string[] = ["anthropic/claude-sonnet-5"];

/** `allowedModels` for a client: the default pool for the Auto Router, unless configured. */
export function defaultAllowedModels(
  model: string,
  allowedModels: readonly string[] | undefined,
): readonly string[] | undefined {
  if (allowedModels !== undefined) return allowedModels.length > 0 ? allowedModels : undefined;
  return model === AUTO_ROUTER_MODEL ? DEFAULT_REVIEWER_POOL : undefined;
}

/**
 * The model id actually sent. A one-model Auto Router pool needs no routing, so that model is
 * called directly: this avoids relying on `cloudflare/auto` support on the unified endpoint and
 * the binding, and on the binding forwarding allow-list headers (both unverified, research §9.6).
 */
export function effectiveModel(
  model: string,
  allowedModels: readonly string[] | undefined,
): string {
  if (model !== AUTO_ROUTER_MODEL || allowedModels?.length !== 1) return model;
  const only = allowedModels[0]!;
  return only.includes("*") ? model : only;
}

// ---------------------------------------------------------------- JSON helpers

/**
 * Parse model text as JSON: raw, inside a ``` fence, or the outermost `{…}` span.
 * Returns `undefined` when nothing parses.
 */
export function parseJsonLoose(text: string): unknown {
  const attempts: string[] = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1] !== undefined) attempts.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    if (candidate === "") continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

/** Validates and normalizes gateway metadata (≤ 5 flat entries, no `cf.` keys). */
export function normalizeMetadata(
  metadata: LlmMetadata,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key.startsWith("cf.")) continue;
    if (Object.keys(out).length >= 5) break;
    out[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  return out;
}

// ---------------------------------------------------------------- AI Gateway client

export type GatewayFormat = "openai-chat" | "anthropic-messages";

export interface AiGatewayClientOptions {
  /** Cloudflare account id. Required unless `endpoint` is a full URL. */
  accountId?: string;
  /** AI Gateway id, sent as `cf-aig-gateway-id` (unified endpoints). */
  gatewayId: string;
  /** Cloudflare API token (Workers AI / AI Gateway run permission). */
  apiToken: string;
  /** Model id. "auto" is resolved to `cloudflare/auto`. */
  model: string;
  /** Default "openai-chat" (works for every provider and the Auto Router). */
  format?: GatewayFormat;
  /**
   * Full URL override, e.g. the provider-native
   * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic/v1/messages`.
   * When it points at gateway.ai.cloudflare.com, the token is sent as `cf-aig-authorization`.
   */
  endpoint?: string;
  /** Auto Router candidate pool (`cf-aig-allowed-models`), e.g. ["anthropic/*"]. */
  allowedModels?: readonly string[];
  /** Auto Router provider allow-list (`cf-aig-allowed-providers`). */
  allowedProviders?: readonly string[];
  prices?: PriceTable;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Gateway-side timeout (`cf-aig-request-timeout`) and the client abort, in ms. Default 120 000. */
  requestTimeoutMs?: number;
  /** Gateway retries (`cf-aig-max-attempts`). Default: gateway default. */
  maxAttempts?: number;
  skipCache?: boolean;
  /** "max_tokens" (default) or "max_completion_tokens" for OpenAI reasoning models. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Anthropic schema only: `output_config.effort`. Unset = model default. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Anthropic schema only: top-level automatic prompt caching (helps the one regeneration). */
  promptCaching?: boolean;
}

const UNIFIED_BASE = "https://api.cloudflare.com/client/v4/accounts";

/** Environment the platform Worker passes in (wrangler vars/secrets). */
export const AiGatewayEnv = z.object({
  CF_ACCOUNT_ID: z.string().min(1),
  AI_GATEWAY_ID: z.string().min(1),
  AI_GATEWAY_TOKEN: z.string().min(1),
  AI_GATEWAY_FORMAT: z.enum(["openai-chat", "anthropic-messages"]).optional(),
  AI_GATEWAY_ENDPOINT: z.url().optional(),
});
export type AiGatewayEnv = z.infer<typeof AiGatewayEnv>;

const OpenAiChatResponse = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })

    .optional(),
});

const AnthropicMessagesResponse = z.object({
  model: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
    })

    .optional(),
});

export class AiGatewayClient implements LlmClient {
  readonly model: string;
  readonly allowedModels?: readonly string[];
  /** The model id put on the wire (see {@link effectiveModel}). */
  readonly sentModel: string;
  readonly format: GatewayFormat;
  private readonly opts: AiGatewayClientOptions;
  private readonly prices: PriceTable;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AiGatewayClientOptions) {
    this.opts = opts;
    this.model = resolveReviewerModel(opts.model);
    const allowed = defaultAllowedModels(this.model, opts.allowedModels);
    if (allowed !== undefined) this.allowedModels = allowed;
    this.sentModel = effectiveModel(this.model, allowed);
    this.format = opts.format ?? "openai-chat";
    this.prices = opts.prices ?? DEFAULT_PRICES;
    // Bind: calling an unbound global fetch as a method throws "Illegal invocation" in workerd.
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    if (this.format === "anthropic-messages" && this.sentModel === AUTO_ROUTER_MODEL) {
      throw new Error("The Auto Router (cloudflare/auto) only speaks the chat-completions format");
    }
    if (opts.endpoint === undefined && (opts.accountId === undefined || opts.accountId === "")) {
      throw new Error("AiGatewayClient needs accountId (or a full endpoint URL)");
    }
  }

  /** Build from Worker env vars; `model` comes from the BASE policy's `ai.reviewerModel`. */
  static fromEnv(
    env: unknown,
    opts: { model: string } & Omit<
      AiGatewayClientOptions,
      "accountId" | "gatewayId" | "apiToken" | "model"
    >,
  ): AiGatewayClient {
    const parsed = AiGatewayEnv.parse(env);
    return new AiGatewayClient({
      ...opts,
      accountId: parsed.CF_ACCOUNT_ID,
      gatewayId: parsed.AI_GATEWAY_ID,
      apiToken: parsed.AI_GATEWAY_TOKEN,
      ...(parsed.AI_GATEWAY_FORMAT !== undefined && opts.format === undefined
        ? { format: parsed.AI_GATEWAY_FORMAT }
        : {}),
      ...(parsed.AI_GATEWAY_ENDPOINT !== undefined && opts.endpoint === undefined
        ? { endpoint: parsed.AI_GATEWAY_ENDPOINT }
        : {}),
    });
  }

  get url(): string {
    if (this.opts.endpoint !== undefined) return this.opts.endpoint;
    const path = this.format === "openai-chat" ? "chat/completions" : "messages";
    return `${UNIFIED_BASE}/${this.opts.accountId}/ai/v1/${path}`;
  }

  /** Request headers and body, exposed for tests and the live script. */
  buildRequest(req: LlmRequest): {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cf-aig-gateway-id": this.opts.gatewayId,
      "cf-aig-metadata": JSON.stringify(normalizeMetadata(req.metadata)),
    };
    const url = this.url;
    if (/^https:\/\/gateway\.ai\.cloudflare\.com\//.test(url)) {
      headers["cf-aig-authorization"] = `Bearer ${this.opts.apiToken}`;
    } else {
      headers.authorization = `Bearer ${this.opts.apiToken}`;
    }
    const timeout = this.opts.requestTimeoutMs ?? 120_000;
    headers["cf-aig-request-timeout"] = String(timeout);
    if (this.opts.maxAttempts !== undefined)
      headers["cf-aig-max-attempts"] = String(this.opts.maxAttempts);
    if (this.opts.skipCache) headers["cf-aig-skip-cache"] = "true";
    if (this.sentModel === AUTO_ROUTER_MODEL) {
      if (this.allowedModels?.length)
        headers["cf-aig-allowed-models"] = this.allowedModels.join(",");
      if (this.opts.allowedProviders?.length) {
        headers["cf-aig-allowed-providers"] = this.opts.allowedProviders.join(",");
      }
    }

    if (this.format === "anthropic-messages") {
      headers["anthropic-version"] = "2023-06-01";
      const outputConfig: Record<string, unknown> = {};
      if (req.jsonSchema)
        outputConfig.format = { type: "json_schema", schema: req.jsonSchema.schema };
      if (this.opts.effort) outputConfig.effort = this.opts.effort;
      const body: Record<string, unknown> = {
        model: this.sentModel,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
      if (this.opts.promptCaching) body.cache_control = { type: "ephemeral" };
      return { url, headers, body };
    }

    const body: Record<string, unknown> = {
      model: this.sentModel,
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      [this.opts.maxTokensField ?? "max_tokens"]: req.maxTokens,
    };
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
      };
    }
    return { url, headers, body };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { url, headers, body } = this.buildRequest(req);
    const timeout = this.opts.requestTimeoutMs ?? 120_000;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // Give the gateway's own timeout a head start before aborting locally.
        signal: AbortSignal.timeout(timeout + 5_000),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new LlmError("timeout", `AI Gateway request timed out after ${timeout} ms`);
      }
      throw new LlmError("network", `AI Gateway request failed: ${errorMessage(err)}`);
    }

    const raw = await res.text();
    if (!res.ok) {
      const kind = res.status === 429 ? "budget" : "http";
      throw new LlmError(kind, `AI Gateway HTTP ${res.status}: ${raw.slice(0, 500)}`, res.status);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new LlmError(
        "bad-response",
        `AI Gateway returned non-JSON: ${raw.slice(0, 200)}`,
        res.status,
      );
    }

    const routed = res.headers.get("cf-aig-routed-model") ?? undefined;
    const logId = res.headers.get("cf-aig-log-id") ?? undefined;
    const parsed =
      this.format === "anthropic-messages" ? parseAnthropic(payload) : parseOpenAi(payload);
    const model = routed ?? parsed.model ?? this.sentModel;
    const costUsd = costOfUsage(model, parsed.usage, this.prices);
    const json = parsed.text === "" ? undefined : parseJsonLoose(parsed.text);
    const out: LlmResponse = {
      text: parsed.text,
      usage: { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens },
      costUsd,
      model,
    };
    if (json !== undefined) out.json = json;
    if (parsed.stopReason !== undefined) out.stopReason = parsed.stopReason;
    if (logId !== undefined) out.logId = logId;
    return out;
  }
}

export interface ParsedCompletion {
  text: string;
  usage: TokenUsage;
  model: string | undefined;
  stopReason: string | undefined;
}

export function parseOpenAi(payload: unknown): ParsedCompletion {
  const r = OpenAiChatResponse.safeParse(payload);
  if (!r.success)
    throw new LlmError("bad-response", `Unexpected chat-completions response: ${r.error.message}`);
  const choice = r.data.choices[0];
  if (r.data.usage === undefined) {
    throw new LlmError(
      "bad-response",
      "chat-completions response has no usage; cannot account for cost",
    );
  }
  return {
    text: choice?.message.content ?? "",
    usage: {
      inputTokens: r.data.usage.prompt_tokens,
      outputTokens: r.data.usage.completion_tokens,
    },
    model: r.data.model,
    stopReason: choice?.finish_reason ?? undefined,
  };
}

export function parseAnthropic(payload: unknown): ParsedCompletion {
  const r = AnthropicMessagesResponse.safeParse(payload);
  if (!r.success)
    throw new LlmError("bad-response", `Unexpected messages response: ${r.error.message}`);
  if (r.data.usage === undefined) {
    throw new LlmError("bad-response", "messages response has no usage; cannot account for cost");
  }
  const text = r.data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const usage: TokenUsage = {
    inputTokens: r.data.usage.input_tokens,
    outputTokens: r.data.usage.output_tokens,
  };
  if (r.data.usage.cache_read_input_tokens)
    usage.cacheReadInputTokens = r.data.usage.cache_read_input_tokens;
  if (r.data.usage.cache_creation_input_tokens)
    usage.cacheWriteInputTokens = r.data.usage.cache_creation_input_tokens;
  return { text, usage, model: r.data.model, stopReason: r.data.stop_reason ?? undefined };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- fake client

export type ScriptedResponse =
  | string
  | Error
  | {
      text?: string;
      /** Serialized into `text` when `text` is absent; returned as `json` too. */
      json?: unknown;
      usage?: { inputTokens: number; outputTokens: number };
      costUsd?: number;
      model?: string;
      stopReason?: string;
    }
  | ((req: LlmRequest) => ScriptedResponse);

export interface FakeLlmClientOptions {
  model?: string;
  /** Cost charged for a scripted response without `costUsd`. Default 0.01. */
  defaultCostUsd?: number;
}

/** Deterministic, scripted client. Records every request for assertions. */
export class FakeLlmClient implements LlmClient {
  readonly model: string;
  readonly requests: LlmRequest[] = [];
  private readonly script: ScriptedResponse[];
  private readonly defaultCostUsd: number;

  constructor(responses: readonly ScriptedResponse[], opts: FakeLlmClientOptions = {}) {
    this.script = [...responses];
    this.model = opts.model ?? "fake/reviewer-1";
    this.defaultCostUsd = opts.defaultCostUsd ?? 0.01;
  }

  get remaining(): number {
    return this.script.length;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    let next = this.script.shift();
    if (next === undefined) throw new Error("FakeLlmClient: no scripted response left");
    while (typeof next === "function") next = next(req);
    if (next instanceof Error) throw next;
    if (typeof next === "string") next = { text: next };
    const text = next.text ?? (next.json === undefined ? "" : JSON.stringify(next.json));
    const out: LlmResponse = {
      text,
      usage: next.usage ?? {
        inputTokens: Math.ceil(
          (req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 3,
        ),
        outputTokens: Math.ceil(text.length / 3),
      },
      costUsd: next.costUsd ?? this.defaultCostUsd,
      model: next.model ?? this.model,
    };
    const json = next.json ?? (text === "" ? undefined : parseJsonLoose(text));
    if (json !== undefined) out.json = json;
    if (next.stopReason !== undefined) out.stopReason = next.stopReason;
    return out;
  }
}
