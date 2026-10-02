/**
 * The fresh-agent loop: model turn → tool calls → results → next turn, until the model answers
 * without a tool call or a cap is hit (tool calls, wall clock, tokens, turns).
 *
 * Pure apart from its seams. Every model turn and every tool call runs inside `step` (a Workflow
 * `step.do` in production), so a resumed Workflow replays cached results and rebuilds the same
 * history; clock reads happen only inside steps. Tool side state (the MCP connection, harvested
 * ids, preview probes) is rebuilt the same way through `ToolExecutor.observe`.
 */
import type { TokenUsage } from "../models.js";
import { assistantMessage, compact, type Message, truncate } from "./messages.js";
import type { ChatModel, ModelTurn } from "./model.js";
import type { ToolSpec } from "./protocol.js";
import type { ToolOutcome } from "./tool-outcome.js";

export interface ToolExecutor {
  specs(): ToolSpec[];
  /** Runs one call. Must not throw (failures are error outcomes) and must not mutate state. */
  execute(
    call: { id: string; name: string; args: Record<string, unknown> },
    ctx: { remainingMs: number },
  ): Promise<ToolOutcome>;
  /** Applies an outcome's side state (fresh or replayed). */
  observe(outcome: ToolOutcome): void;
}

export type StepKind = "clock" | "model" | "tool" | "io";
export type DurableStep = <T>(name: string, kind: StepKind, fn: () => Promise<T>) => Promise<T>;

export interface AgentLimits {
  maxToolCalls: number;
  maxWallMs: number;
  /** Prompt + completion tokens summed over every turn. */
  maxTokens: number;
  maxTurns: number;
}

export type AgentStop = "final" | "step-cap" | "time-cap" | "token-cap" | "model-error";

export type TranscriptEntry =
  | {
      kind: "model";
      turn: number;
      at: number;
      content: string | null;
      calls: { id: string; name: string; arguments: string }[];
      usage: TokenUsage;
    }
  | {
      kind: "tool";
      turn: number;
      at: number;
      id: string;
      name: string;
      arguments: string;
      isError: boolean;
      codes: string[];
      durationMs: number;
      content: string;
    };

export interface AgentRun {
  stop: AgentStop;
  startedAt: number;
  endedAt: number;
  turns: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  toolErrors: number;
  errorCodes: string[];
  usage: TokenUsage;
  finalMessage: string | null;
  modelError: string | null;
  transcript: TranscriptEntry[];
}

export interface AgentInput {
  system: string;
  task: string;
  model: ChatModel;
  tools: ToolExecutor;
  step: DurableStep;
  limits: AgentLimits;
  /** History above this many characters is compacted before each turn. */
  contextChars: number;
}

const TRANSCRIPT_TEXT = 4000;

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function parseArgs(raw: string): Record<string, unknown> | string {
  if (raw.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
    return "the arguments must be a JSON object";
  } catch (e) {
    return `the arguments are not valid JSON (${errorText(e)})`;
  }
}

export async function runAgent(input: AgentInput): Promise<AgentRun> {
  const { step, limits, model, tools } = input;
  const specs = tools.specs();
  const startedAt = await step("start", "clock", async () => Date.now());
  const messages: Message[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.task },
  ];
  const run: AgentRun = {
    stop: "final",
    startedAt,
    endedAt: startedAt,
    turns: 0,
    toolCalls: 0,
    toolCounts: {},
    toolErrors: 0,
    errorCodes: [],
    usage: { prompt: 0, completion: 0, cached: 0 },
    finalMessage: null,
    modelError: null,
    transcript: [],
  };
  let now = startedAt;
  const elapsed = () => now - startedAt;

  for (let turn = 0; ; turn++) {
    if (elapsed() >= limits.maxWallMs) return finish(run, "time-cap", now);
    if (run.usage.prompt + run.usage.completion >= limits.maxTokens) {
      return finish(run, "token-cap", now);
    }
    if (turn >= limits.maxTurns) return finish(run, "step-cap", now);

    let res: { turn: ModelTurn; at: number };
    try {
      res = await step(`turn-${turn}`, "model", async () => {
        const t = await model.complete({
          messages: compact(messages, input.contextChars),
          tools: specs,
        });
        return { turn: t, at: Date.now() };
      });
    } catch (e) {
      run.modelError = errorText(e);
      return finish(run, "model-error", now);
    }
    now = Math.max(now, res.at);
    run.turns++;
    run.usage.prompt += res.turn.usage.prompt;
    run.usage.completion += res.turn.usage.completion;
    run.usage.cached += res.turn.usage.cached;
    const calls = res.turn.toolCalls.map((c, j) => ({ ...c, id: c.id || `call_${turn}_${j}` }));
    messages.push(assistantMessage(res.turn.content, calls));
    run.transcript.push({
      kind: "model",
      turn,
      at: res.at,
      content: res.turn.content === null ? null : truncate(res.turn.content, TRANSCRIPT_TEXT),
      calls: calls.map((c) => ({ ...c, arguments: truncate(c.arguments, TRANSCRIPT_TEXT) })),
      usage: res.turn.usage,
    });
    if (calls.length === 0) {
      run.finalMessage = res.turn.content;
      return finish(run, "final", now);
    }

    for (const [j, call] of calls.entries()) {
      const remainingMs = limits.maxWallMs - elapsed();
      if (remainingMs <= 0) return finish(run, "time-cap", now);
      const args = parseArgs(call.arguments);
      let outcome: ToolOutcome;
      if (typeof args === "string") {
        outcome = {
          content: `Error: ${call.name} was not run: ${args}.`,
          isError: true,
          errorCodes: [],
          at: now,
          durationMs: 0,
          meta: {},
        };
      } else {
        try {
          outcome = await step(`tool-${turn}-${j}`, "tool", () =>
            tools.execute({ id: call.id, name: call.name, args }, { remainingMs }),
          );
        } catch (e) {
          outcome = {
            content: `Error: the harness failed to run ${call.name}: ${errorText(e)}`,
            isError: true,
            errorCodes: [],
            at: now,
            durationMs: 0,
            meta: {},
          };
        }
      }
      tools.observe(outcome);
      now = Math.max(now, outcome.at);
      run.toolCalls++;
      run.toolCounts[call.name] = (run.toolCounts[call.name] ?? 0) + 1;
      if (outcome.isError) run.toolErrors++;
      run.errorCodes.push(...outcome.errorCodes);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
      run.transcript.push({
        kind: "tool",
        turn,
        at: outcome.at,
        id: call.id,
        name: call.name,
        arguments: truncate(call.arguments, TRANSCRIPT_TEXT),
        isError: outcome.isError,
        codes: outcome.errorCodes,
        durationMs: outcome.durationMs,
        content: truncate(outcome.content, TRANSCRIPT_TEXT),
      });
      if (run.toolCalls >= limits.maxToolCalls) return finish(run, "step-cap", now);
    }
  }
}

function finish(run: AgentRun, stop: AgentStop, now: number): AgentRun {
  run.stop = stop;
  run.endedAt = now;
  return run;
}
