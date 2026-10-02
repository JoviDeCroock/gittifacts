/**
 * Tool-call wire formats.
 *
 * - `tools` (default): OpenAI chat-completions function calling, which Workers AI accepts for the
 *   current `@cf/…` chat models (workers-types `ChatCompletionsCommonOptions.tools`).
 * - `json-actions` (fallback for a model whose function calling misbehaves): no `tools` field; a
 *   second system message lists the tools and the model answers with exactly one JSON object per
 *   turn. That message is harness plumbing (tool schemas), never task hints.
 */
import type { Message, ToolCall } from "./messages.js";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function wireTools(tools: readonly ToolSpec[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function jsonActionInstructions(tools: readonly ToolSpec[]): string {
  const list = tools
    .map(
      (t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`,
    )
    .join("\n");
  return [
    "Tools you can call:",
    list,
    "",
    'To call a tool, reply with ONLY one JSON object: {"tool": "<name>", "arguments": { ... }}.',
    'When you are done, reply with ONLY: {"final": "<what you did and the result>"}.',
    "One tool call per reply; its result comes back in the next message.",
  ].join("\n");
}

/** Rewrites a native tool-calling history into the json-actions dialect. */
export function toJsonActionMessages(
  messages: readonly Message[],
  tools: readonly ToolSpec[],
): Message[] {
  const names = new Map<string, string>();
  const out: Message[] = [];
  let instructed = false;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const c = m.tool_calls[0]!;
      names.set(c.id, c.function.name);
      out.push({
        role: "assistant",
        content: JSON.stringify({
          tool: c.function.name,
          arguments: safeParse(c.function.arguments),
        }),
      });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: `Result of ${names.get(m.tool_call_id) ?? "tool"}:\n${m.content}`,
      });
    } else {
      out.push(m);
      if (m.role === "system" && !instructed) {
        out.push({ role: "system", content: jsonActionInstructions(tools) });
        instructed = true;
      }
    }
  }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export type JsonAction =
  | { kind: "call"; call: Omit<ToolCall, "id"> }
  | { kind: "final"; text: string }
  | { kind: "none" };

/**
 * Reads a JSON action from a reply: the whole reply (optionally in a ``` fence) must be one JSON
 * object with `tool` (or `name`) + `arguments`, or `final`. Anything else is plain text.
 */
export function parseJsonAction(text: string | null): JsonAction {
  if (!text) return { kind: "none" };
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return { kind: "none" };
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return { kind: "none" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { kind: "none" };
  const o = v as Record<string, unknown>;
  const name = typeof o.tool === "string" ? o.tool : typeof o.name === "string" ? o.name : null;
  if (name !== null && ("arguments" in o || "args" in o)) {
    const args = o.arguments ?? o.args ?? {};
    return {
      kind: "call",
      call: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    };
  }
  if (typeof o.final === "string") return { kind: "final", text: o.final };
  return { kind: "none" };
}
