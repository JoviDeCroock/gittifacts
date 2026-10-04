/**
 * Model calls through the Workers AI binding: `env.AI.run(model, inputs, { gateway })`.
 *
 * The default client inside the platform Worker: it needs no API-token secret, and the request
 * still goes through AI Gateway (logs, caching, spend limits keyed by the `change_id` metadata).
 * The HTTP {@link AiGatewayClient} is the fallback.
 *
 * What `@cloudflare/workers-types@5.20261001.1` says about the binding:
 * - `run(model, inputs, options?: AiOptions)`. `AiOptions.gateway` is
 *   `{ id, metadata, cacheKey, cacheTtl, skipCache, collectLog, eventId, requestTimeoutMs,
 *   retries: { maxAttempts 1-5, retryDelayMs, backoff } }`, plus `extraHeaders`, `signal`, `tags`.
 * - Model names outside the typed `@cf/…` catalog (third-party gateway models such as
 *   `anthropic/claude-sonnet-5`) take an explicit fallback overload: inputs and output are
 *   `Record<string, unknown>`. Third-party models on the binding use Unified Billing (or a BYOK key
 *   stored under the alias `default`); research §6.
 * - Current `@cf/…` chat models (deepseek-v4, glm-5.x, qwen3.8, kimi-k2.x, gemma-4, gpt-oss) are
 *   typed with the OpenAI chat-completions shapes: input `messages` + `response_format:
 *   { type: "json_schema", json_schema: { name, schema, strict } }`, output `choices[].message` with
 *   `usage`. Older `@cf/…` models take `response_format: { type: "json_schema", json_schema: <schema> }`
 *   and return `{ response, usage? }` (usage optional).
 * - `ai.aiGatewayLogId` holds the gateway log id of the last call.
 * Not verified: `cloudflare/auto` on the binding, and whether `extraHeaders` reaches the Auto Router
 * (`cf-aig-allowed-models`). The default one-model pool sidesteps both (see `effectiveModel`).
 */
import { z } from "zod";
import {
  AUTO_ROUTER_MODEL,
  costOfUsage,
  DEFAULT_PRICES,
  estimateTokens,
  type PriceTable,
} from "./budget.js";
import {
  AiGatewayClient,
  type AiGatewayClientOptions,
  AiGatewayEnv,
  defaultAllowedModels,
  effectiveModel,
  errorMessage,
  type LlmClient,
  LlmError,
  type LlmRequest,
  type LlmResponse,
  normalizeMetadata,
  type ParsedCompletion,
  parseAnthropic,
  parseJsonLoose,
  parseOpenAi,
  resolveReviewerModel,
} from "./llm.js";

/** Options we pass to `Ai.run` (a subset of workers-types' `AiOptions`). */
export interface AiBindingRunOptions {
  gateway?: {
    id: string;
    metadata?: Record<string, string | number | boolean>;
    skipCache?: boolean;
    cacheTtl?: number;
    collectLog?: boolean;
    requestTimeoutMs?: number;
    retries?: { maxAttempts?: 1 | 2 | 3 | 4 | 5 };
  };
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * The part of the Workers AI binding we use. workers-types' `Ai` is assignable to it (checked in
 * test/binding.test.ts), and tests implement it with a fake.
 */
export interface AiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: AiBindingRunOptions,
  ): Promise<unknown>;
  readonly aiGatewayLogId?: string | null;
}

export type BindingJsonMode =
  /** `response_format: { type: "json_schema", json_schema: { name, schema, strict } }` (default). */
  | "openai"
  /** Older `@cf/…` JSON mode: `response_format: { type: "json_schema", json_schema: <schema> }`. */
  | "workers-ai"
  /** No response_format; JSON is parsed from text (validation/regeneration still apply). */
  | "none";

export interface AiBindingClientOptions {
  ai: AiBinding;
  /** AI Gateway id; every call goes through it. */
  gatewayId: string;
  /** Model id; "auto" → `cloudflare/auto` (with the default reviewer pool unless configured). */
  model: string;
  /** Auto Router pool. Default {@link DEFAULT_REVIEWER_POOL}; `[]` = the router's full pool. */
  allowedModels?: readonly string[];
  allowedProviders?: readonly string[];
  prices?: PriceTable;
  jsonMode?: BindingJsonMode;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /**
   * `reasoning_effort` for reasoning models. Default: {@link DEFAULT_REASONING_EFFORT} for the model,
   * else not sent (the model's own default).
   */
  reasoningEffort?: "low" | "high" | "max";
  /** Gateway-side timeout and the local abort, in ms. Default 120 000. */
  requestTimeoutMs?: number;
  maxAttempts?: 1 | 2 | 3 | 4 | 5;
  skipCache?: boolean;
  collectLog?: boolean;
}

/**
 * Per-model reasoning defaults. GLM-5.3-Flash defaults to "max", which spent the whole output budget
 * on reasoning in 3 of 22 judge calibration calls (no JSON left, so `unsure`); "low" keeps it inside
 * the budget (DECISIONS.md 2026-10-04).
 */
export const DEFAULT_REASONING_EFFORT: Readonly<Record<string, "low" | "high" | "max">> = {
  "@cf/zai-org/glm-5.3-flash": "low",
};

const LegacyWorkersAiResponse = z.object({
  response: z
    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .nullable(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const ResponsesApiResponse = z.object({
  model: z.string().optional(),
  output_text: z.string(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

interface ParsedAny extends ParsedCompletion {
  /** Structured output already parsed by the runtime (older `@cf/…` JSON mode). */
  json?: unknown;
}

function hasKey(payload: unknown, key: string): boolean {
  return typeof payload === "object" && payload !== null && key in payload;
}

/**
 * Read whatever the binding returned: OpenAI chat completions (current `@cf/…` chat models and,
 * per the gateway's unified API, third-party models), Anthropic messages, the Responses API, or the
 * older Workers AI `{ response, usage? }` shape.
 */
export function parseBindingOutput(payload: unknown): ParsedAny {
  if (hasKey(payload, "choices")) return parseOpenAi(payload);
  if (hasKey(payload, "content") && Array.isArray((payload as { content: unknown }).content)) {
    return parseAnthropic(payload);
  }
  if (hasKey(payload, "output_text")) {
    const r = ResponsesApiResponse.safeParse(payload);
    if (!r.success)
      throw new LlmError("bad-response", `Unexpected Responses API output: ${r.error.message}`);
    return {
      text: r.data.output_text,
      usage: r.data.usage
        ? { inputTokens: r.data.usage.input_tokens, outputTokens: r.data.usage.output_tokens }
        : undefined,
      model: r.data.model,
      stopReason: undefined,
    };
  }
  if (hasKey(payload, "response")) {
    const r = LegacyWorkersAiResponse.safeParse(payload);
    if (!r.success)
      throw new LlmError("bad-response", `Unexpected Workers AI output: ${r.error.message}`);
    const response = r.data.response;
    const text =
      typeof response === "string" ? response : response === null ? "" : JSON.stringify(response);
    const u = r.data.usage;
    const out: ParsedAny = {
      text,
      usage:
        u?.prompt_tokens !== undefined && u.completion_tokens !== undefined
          ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
          : undefined,
      model: undefined,
      stopReason: undefined,
    };
    if (response !== null && typeof response === "object") out.json = response;
    return out;
  }
  const keys =
    typeof payload === "object" && payload !== null
      ? Object.keys(payload).join(", ")
      : typeof payload;
  throw new LlmError("bad-response", `Unrecognized Workers AI binding output (${keys})`);
}

/** Map a binding exception to an LlmError. 429-like failures count as budget (escalating reading). */
export function bindingError(err: unknown, timeoutMs: number): LlmError {
  if (err instanceof LlmError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new LlmError("timeout", `Workers AI binding call timed out after ${timeoutMs} ms`);
  }
  const message = errorMessage(err);
  if (/\b429\b|rate.?limit|spend.?limit|budget|quota/i.test(message)) {
    return new LlmError(
      "budget",
      `Workers AI binding refused the call: ${message.slice(0, 500)}`,
      429,
    );
  }
  return new LlmError("http", `Workers AI binding call failed: ${message.slice(0, 500)}`);
}

export class AiBindingClient implements LlmClient {
  readonly model: string;
  readonly allowedModels?: readonly string[];
  /** The model id passed to `run` (see `effectiveModel`). */
  readonly sentModel: string;
  private readonly opts: AiBindingClientOptions;
  private readonly prices: PriceTable;

  constructor(opts: AiBindingClientOptions) {
    this.opts = opts;
    this.model = resolveReviewerModel(opts.model);
    const allowed = defaultAllowedModels(this.model, opts.allowedModels);
    if (allowed !== undefined) this.allowedModels = allowed;
    this.sentModel = effectiveModel(this.model, allowed);
    this.prices = opts.prices ?? DEFAULT_PRICES;
  }

  /** `inputs` and `options` for `Ai.run`, exposed for tests. */
  buildRun(req: LlmRequest): {
    model: string;
    inputs: Record<string, unknown>;
    options: AiBindingRunOptions;
  } {
    const timeout = this.opts.requestTimeoutMs ?? 120_000;
    const inputs: Record<string, unknown> = {
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      [this.opts.maxTokensField ?? "max_tokens"]: req.maxTokens,
    };
    const effort = this.opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT[this.sentModel];
    if (effort !== undefined) inputs.reasoning_effort = effort;
    const mode = this.opts.jsonMode ?? "openai";
    if (req.jsonSchema && mode === "openai") {
      inputs.response_format = {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
      };
    } else if (req.jsonSchema && mode === "workers-ai") {
      inputs.response_format = { type: "json_schema", json_schema: req.jsonSchema.schema };
    }

    const gateway: NonNullable<AiBindingRunOptions["gateway"]> = {
      id: this.opts.gatewayId,
      metadata: normalizeMetadata(req.metadata),
      requestTimeoutMs: timeout,
    };
    if (this.opts.skipCache) gateway.skipCache = true;
    if (this.opts.collectLog !== undefined) gateway.collectLog = this.opts.collectLog;
    if (this.opts.maxAttempts !== undefined)
      gateway.retries = { maxAttempts: this.opts.maxAttempts };
    const options: AiBindingRunOptions = { gateway, signal: AbortSignal.timeout(timeout + 5_000) };
    if (this.sentModel === AUTO_ROUTER_MODEL) {
      const extra: Record<string, string> = {};
      if (this.allowedModels?.length) extra["cf-aig-allowed-models"] = this.allowedModels.join(",");
      if (this.opts.allowedProviders?.length)
        extra["cf-aig-allowed-providers"] = this.opts.allowedProviders.join(",");
      if (Object.keys(extra).length > 0) options.extraHeaders = extra;
    }
    return { model: this.sentModel, inputs, options };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { model, inputs, options } = this.buildRun(req);
    const timeout = this.opts.requestTimeoutMs ?? 120_000;
    let payload: unknown;
    try {
      payload = await this.opts.ai.run(model, inputs, options);
    } catch (err) {
      throw bindingError(err, timeout);
    }
    const parsed = parseBindingOutput(payload);
    const answeredBy = parsed.model ?? model;
    // Unknown usage is never free: estimate it from the text (≈3 chars/token, conservative).
    const usage = parsed.usage ?? {
      inputTokens: estimateTokens(req.system + req.messages.map((m) => m.content).join("\n")),
      outputTokens: estimateTokens(parsed.text),
    };
    const out: LlmResponse = {
      text: parsed.text,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      costUsd: costOfUsage(answeredBy, usage, this.prices),
      model: answeredBy,
    };
    const json = parsed.json ?? (parsed.text === "" ? undefined : parseJsonLoose(parsed.text));
    if (json !== undefined) out.json = json;
    if (parsed.stopReason !== undefined) out.stopReason = parsed.stopReason;
    if (parsed.usage === undefined) out.usageEstimated = true;
    const logId = this.opts.ai.aiGatewayLogId;
    if (typeof logId === "string" && logId !== "") out.logId = logId;
    return out;
  }
}

/**
 * Try `primary`; if it fails for a reason the other path might not share (an HTTP/binding error,
 * a network error or an unreadable response), retry the same request once on `fallback`. Budget
 * refusals and timeouts are never retried elsewhere: they would only spend or wait twice.
 */
export class FallbackLlmClient implements LlmClient {
  readonly model: string;
  readonly allowedModels?: readonly string[];
  /** Which client answered the last successful call. */
  lastUsed: "primary" | "fallback" | null = null;

  constructor(
    readonly primary: LlmClient,
    readonly fallback: LlmClient,
  ) {
    this.model = primary.model;
    if (primary.allowedModels !== undefined) this.allowedModels = primary.allowedModels;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.primary.complete(req);
      this.lastUsed = "primary";
      return res;
    } catch (err) {
      if (err instanceof LlmError && (err.kind === "budget" || err.kind === "timeout")) throw err;
      const res = await this.fallback.complete(req);
      this.lastUsed = "fallback";
      return res;
    }
  }
}

// ---------------------------------------------------------------- choosing a client

const ReviewerLlmEnv = z.object({
  AI: z
    .custom<AiBinding>(
      (v) =>
        typeof v === "object" && v !== null && typeof (v as { run?: unknown }).run === "function",
      "AI must be a Workers AI binding",
    )
    .optional(),
  AI_GATEWAY_ID: z.string().min(1),
  CF_ACCOUNT_ID: z.string().min(1).optional(),
  AI_GATEWAY_TOKEN: z.string().min(1).optional(),
});

export interface ReviewerLlmOptions {
  /** BASE policy's `ai.reviewerModel`. */
  model: string;
  allowedModels?: readonly string[];
  prices?: PriceTable;
  requestTimeoutMs?: number;
  /** Binding-only options. */
  binding?: Pick<
    AiBindingClientOptions,
    "jsonMode" | "maxTokensField" | "reasoningEffort" | "maxAttempts" | "skipCache" | "collectLog"
  >;
  /** HTTP-only options. */
  http?: Omit<
    AiGatewayClientOptions,
    "accountId" | "gatewayId" | "apiToken" | "model" | "allowedModels" | "prices"
  >;
}

/**
 * The reviewer's client for the platform Worker:
 * - `env.AI` (binding) + `AI_GATEWAY_ID` → {@link AiBindingClient} (no API token needed);
 * - plus `CF_ACCOUNT_ID` + `AI_GATEWAY_TOKEN` → the HTTP {@link AiGatewayClient} as fallback;
 * - HTTP variables only → the HTTP client.
 */
export function reviewerLlmFromEnv(env: unknown, opts: ReviewerLlmOptions): LlmClient {
  const e = ReviewerLlmEnv.parse(env);
  const shared = {
    model: opts.model,
    ...(opts.allowedModels !== undefined ? { allowedModels: opts.allowedModels } : {}),
    ...(opts.prices !== undefined ? { prices: opts.prices } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  };
  const binding = e.AI
    ? new AiBindingClient({ ...opts.binding, ...shared, ai: e.AI, gatewayId: e.AI_GATEWAY_ID })
    : null;
  const http =
    e.CF_ACCOUNT_ID !== undefined && e.AI_GATEWAY_TOKEN !== undefined
      ? AiGatewayClient.fromEnv(AiGatewayEnv.parse(env), { ...opts.http, ...shared })
      : null;
  if (binding && http) return new FallbackLlmClient(binding, http);
  if (binding) return binding;
  if (http) return http;
  throw new Error(
    "No model access: bind Workers AI as `AI`, or set CF_ACCOUNT_ID and AI_GATEWAY_TOKEN",
  );
}
