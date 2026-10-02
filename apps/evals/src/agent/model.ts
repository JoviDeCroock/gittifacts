/**
 * The agent's model: `env.AI.run(model, inputs, { gateway: { id, metadata } })`, so every call is
 * logged, rate-limited and spend-limited by AI Gateway with `{ run, task, model }` metadata.
 */
import { z } from "zod";
import type { ModelDef, TokenUsage } from "../models.js";
import type { Message, ToolCall } from "./messages.js";
import { parseJsonAction, type ToolSpec, toJsonActionMessages, wireTools } from "./protocol.js";

export interface ModelTurn {
  content: string | null;
  /** `id` may be "" when the provider omitted it; the loop assigns one. */
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: string | null;
}

export interface ChatModel {
  complete(req: { messages: readonly Message[]; tools: readonly ToolSpec[] }): Promise<ModelTurn>;
}

/** The slice of the Workers AI binding used here (workers-types' `Ai` satisfies it). */
export interface AiRunner {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: {
      gateway?: {
        id: string;
        metadata?: Record<string, string | number | boolean>;
        skipCache?: boolean;
        requestTimeoutMs?: number;
      };
    },
  ): Promise<unknown>;
}

export class ModelOutputError extends Error {
  override readonly name = "ModelOutputError";
}

const Usage = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
  })
  .nullish();

const OpenAiShape = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().nullish(),
                function: z.object({ name: z.string(), arguments: z.unknown() }),
              }),
            )
            .nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: Usage,
});

/** Older Workers AI shape: `{ response, tool_calls: [{ name, arguments }] }`. */
const LegacyShape = z.object({
  response: z.unknown().optional(),
  tool_calls: z.array(z.object({ name: z.string(), arguments: z.unknown() })).nullish(),
  usage: Usage,
});

function argsText(a: unknown): string {
  if (typeof a === "string") return a;
  return JSON.stringify(a ?? {});
}

function usageOf(u: z.infer<typeof Usage>): TokenUsage {
  return {
    prompt: u?.prompt_tokens ?? 0,
    completion: u?.completion_tokens ?? 0,
    cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

export function parseCompletion(raw: unknown): ModelTurn {
  const o = OpenAiShape.safeParse(raw);
  if (o.success) {
    const choice = o.data.choices[0]!;
    return {
      content: choice.message.content ?? null,
      toolCalls: (choice.message.tool_calls ?? []).map((c) => ({
        id: c.id ?? "",
        name: c.function.name,
        arguments: argsText(c.function.arguments),
      })),
      usage: usageOf(o.data.usage),
      finishReason: choice.finish_reason ?? null,
    };
  }
  const l = LegacyShape.safeParse(raw);
  if (l.success && (l.data.response !== undefined || l.data.tool_calls)) {
    const r = l.data.response;
    return {
      content: r === undefined || r === null ? null : typeof r === "string" ? r : JSON.stringify(r),
      toolCalls: (l.data.tool_calls ?? []).map((c) => ({
        id: "",
        name: c.name,
        arguments: argsText(c.arguments),
      })),
      usage: usageOf(l.data.usage),
      finishReason: null,
    };
  }
  throw new ModelOutputError(`unrecognised model output: ${JSON.stringify(raw).slice(0, 300)}`);
}

/**
 * Turns a reply into tool calls per protocol. Native-tools models sometimes write the call as
 * text; a reply that is exactly one JSON action counts as that call (documented leniency).
 */
export function normalizeTurn(turn: ModelTurn): ModelTurn {
  if (turn.toolCalls.length > 0) return turn;
  const a = parseJsonAction(turn.content);
  if (a.kind === "call") return { ...turn, toolCalls: [{ id: "", ...a.call }] };
  if (a.kind === "final") return { ...turn, content: a.text };
  return turn;
}

export interface WorkersAiModelOptions {
  ai: AiRunner;
  model: ModelDef;
  gatewayId: string;
  /** ≤ 5 entries (AI Gateway limit): run, task, model. */
  metadata: Record<string, string>;
  requestTimeoutMs?: number;
}

export class WorkersAiModel implements ChatModel {
  constructor(private readonly opts: WorkersAiModelOptions) {}

  async complete(req: { messages: readonly Message[]; tools: readonly ToolSpec[] }) {
    const { model } = this.opts;
    const native = model.protocol === "tools";
    const inputs: Record<string, unknown> = {
      messages: native ? req.messages : toJsonActionMessages(req.messages, req.tools),
      max_tokens: model.maxTokens,
    };
    if (native && req.tools.length > 0) {
      inputs.tools = wireTools(req.tools);
      inputs.tool_choice = "auto";
    }
    const raw = await this.opts.ai.run(model.id, inputs, {
      gateway: {
        id: this.opts.gatewayId,
        metadata: this.opts.metadata,
        // Every turn is unique; a cached reply would replay an old run.
        skipCache: true,
        requestTimeoutMs: this.opts.requestTimeoutMs ?? 180_000,
      },
    });
    const turn = normalizeTurn(parseCompletion(raw));
    // json-actions: one call per reply.
    return native ? turn : { ...turn, toolCalls: turn.toolCalls.slice(0, 1) };
  }
}
